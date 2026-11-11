// Markdown seguro para as respostas da IA: o texto vira elementos React (nunca HTML bruto). Suporta títulos, parágrafos,
// listas, tabelas, citações, blocos de código, código em linha, negrito, itálico e links http(s) (abrem em nova aba,
// sem Referer). Qualquer outra coisa aparece como texto.
import { Fragment, type ReactNode } from 'react';

const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;

function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  // Ordem: código, link, negrito, itálico.
  const re = /(`[^`\n]+`)|(\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\))|(\*\*([^*\n]+)\*\*)|(__([^_\n]+)__)|(\*([^*\n]+)\*)|(_([^_\n]+)_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{m[1].slice(1, -1)}</code>);
    else if (m[2]) {
      const href = m[4];
      out.push(
        SAFE_URL.test(href) ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="font-medium text-primary underline underline-offset-2">
            {m[3]}
          </a>
        ) : (
          m[3]
        ),
      );
    } else if (m[5] || m[7]) out.push(<strong key={k}>{inline(m[6] ?? m[8], k)}</strong>);
    else out.push(<em key={k}>{inline(m[10] ?? m[12], k)}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${k++}`;
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key} className="overflow-x-auto rounded-xl bg-muted p-3 font-mono text-xs leading-relaxed">
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.+)$/.exec(line);
    if (h) {
      const cls = h[1].length <= 2 ? 'text-base font-bold' : 'text-sm font-bold';
      blocks.push(
        <p key={key} role="heading" aria-level={Math.min(6, h[1].length + 2)} className={`${cls} mt-1`}>
          {inline(h[2], key)}
        </p>,
      );
      i++;
      continue;
    }
    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
      blocks.push(<hr key={key} className="border-border" />);
      i++;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key} className="-mx-1 overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} className="border-b px-2 py-1.5 font-semibold">
                    {inline(c, `${key}h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-border/50 last:border-0">
                  {head.map((_, j) => (
                    <td key={j} className="px-2 py-1.5 tabular">
                      {inline(r[j] ?? '', `${key}r${ri}c${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(
        <blockquote key={key} className="border-l-2 border-primary/50 pl-3 text-muted-foreground">
          {inline(body.join(' '), key)}
        </blockquote>,
      );
      continue;
    }
    const li = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items: { text: string; sub: boolean }[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(lines[i]);
        if (m) {
          items.push({ text: m[3], sub: m[1].length >= 2 });
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ` ${lines[i].trim()}`;
          i++;
        } else break;
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={key} className={`${ordered ? 'list-decimal' : 'list-disc'} space-y-1 pl-5`}>
          {items.map((it, j) => (
            <li key={j} className={it.sub ? 'ml-4' : undefined}>
              {inline(it.text, `${key}l${j}`)}
            </li>
          ))}
        </Tag>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*```|\s*>|\s*([-*+]|\d{1,3}[.)])\s)/.test(lines[i]) && !(isTableRow(lines[i]) && isTableSep(lines[i + 1] ?? ''))) para.push(lines[i++]);
    // Linha que parecia bloco mas não é (ex.: "# " sozinho): vira texto, e a leitura sempre avança.
    if (!para.length) para.push(lines[i++]);
    blocks.push(
      <p key={key}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p, `${key}p${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="space-y-2.5 break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{blocks}</div>;
}
