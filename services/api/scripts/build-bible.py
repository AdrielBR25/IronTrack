#!/usr/bin/env python3
"""Gera os arquivos da Bíblia Portuguesa Mundial (BPM) usados pelo app e pela API (IronTrack Life — Fase 05).

Fonte: eBible.org, tradução `porbrbsl` ("Bíblia Portuguesa Mundial", DOMÍNIO PÚBLICO — https://ebible.org/porbrbsl/copyright.htm),
arquivos USFM oficiais (https://ebible.org/Scriptures/porbrbsl_usfm.zip). Ver docs/BIBLIA.md §2.

Uso:  python3 -I services/api/scripts/build-bible.py <pasta-com-os-.usfm> [data-da-fonte]

O texto dos versículos NÃO é alterado: o script só remove a marcação USFM, as notas de rodapé (\\f…\\f*) e as referências
cruzadas (\\x…\\x*), e normaliza espaços. Nenhum versículo é completado, reescrito ou gerado. A saída é:
  shared/bible/data/bpm/<LIVRO>.json  — {"id","c": [[{"v":n,"t":texto,"p":início de parágrafo?,"q":poesia?}...], ...], "h": títulos}
  shared/bible/data/bpm/index.ts      — livros, nomes, capítulos, versículos e palavras por capítulo, contagens e SHA-256.
"""
import hashlib
import json
import os
import re
import sys

BOOKS = ['GEN', 'EXO', 'LEV', 'NUM', 'DEU', 'JOS', 'JDG', 'RUT', '1SA', '2SA', '1KI', '2KI', '1CH', '2CH', 'EZR', 'NEH', 'EST', 'JOB', 'PSA', 'PRO', 'ECC', 'SNG', 'ISA', 'JER', 'LAM', 'EZK', 'DAN', 'HOS', 'JOL', 'AMO', 'OBA', 'JON', 'MIC', 'NAM', 'HAB', 'ZEP', 'HAG', 'ZEC', 'MAL',
         'MAT', 'MRK', 'LUK', 'JHN', 'ACT', 'ROM', '1CO', '2CO', 'GAL', 'EPH', 'PHP', 'COL', '1TH', '2TH', '1TI', '2TI', 'TIT', 'PHM', 'HEB', 'JAS', '1PE', '2PE', '1JN', '2JN', '3JN', 'JUD', 'REV']
NT_START = BOOKS.index('MAT')

# Correções de METADADOS (nunca de texto bíblico): dois livros vêm com o título em inglês no \\toc2 da fonte, e algumas
# abreviaturas fogem do padrão brasileiro. Só afetam o nome exibido.
NAME_FIX = {'ZEP': ('Sofonias', 'Sf'), 'HAG': ('Ageu', 'Ag'), 'EXO': (None, 'Êx'), 'OBA': (None, 'Ob'), 'ZEC': (None, 'Zc')}

NOTE_RE = re.compile(r'\\(f|x|fe)\s.*?\\\1\*', re.S)
INLINE_RE = re.compile(r'\\\+?(wj|wh|qs|bk|nd|add|it|bd|em|sc|tl|w|k)\*?\s?')
HEADING = ('d', 'sp', 'ms1', 'ms', 's1', 's', 'cl')
PARA = ('p', 'm', 'pi1', 'pi', 'nb', 'mi', 'li1', 'li', 'b')
POETRY = ('q1', 'q2', 'q', 'q3')


def clean(s: str) -> str:
    s = INLINE_RE.sub('', s)
    s = s.replace('\\', '')
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r'\s+([,.;:!?”’)])', r'\1', s)
    return s


def parse(path: str, book: str):
    raw = open(path, encoding='utf-8').read()
    meta = {}
    for k in ('h', 'toc1', 'toc2', 'toc3'):
        m = re.search(r'^\\' + k + r'\s+(.+?)\s*$', raw, re.M)
        meta[k] = clean(m.group(1)) if m else None
    # Referências cruzadas saem. Notas de rodapé viram um marcador próprio (\\zn … \\zn*): só são guardadas quando o
    # versículo não tem texto na tradução (ex.: Lucas 17:36, omitido com a nota "Alguns manuscritos acrescentam…").
    def note(m):
        if m.group(1) != 'f':
            return ''
        ft = re.search(r'\\ft\s(.*)', m.group(0)[:-3], re.S)
        return ' \\zn ' + (ft.group(1) if ft else '') + ' \\zn* '
    body = NOTE_RE.sub(note, raw)
    if re.search(r'\\(f|x)\s', body):
        raise SystemExit(f'{book}: nota não fechada')
    chapters = []
    headings = []
    cur = None
    verse = None
    pending_p = False
    pending_q = False
    pending_head = []
    # Marcadores de caractere (\wj, \+wh, \qs…) saem antes; sobram os de estrutura (capítulo, versículo, parágrafo, poesia).
    body = INLINE_RE.sub('', body)
    parts = re.split(r'\\([a-z]+[0-9]?)\b\*?', body)
    tokens = [(parts[i], parts[i + 1]) for i in range(1, len(parts) - 1, 2)]
    in_note = False
    for tag, text in tokens:
        if tag == 'zn':
            in_note = not in_note
            if in_note:
                if verse is not None and not verse['t'] and 'n' not in verse:
                    verse['n'] = clean(re.sub(r'\\[a-z]+\*?', ' ', text))
                continue
            t = clean(text)
            if t and verse is not None:
                verse['t'] = (verse['t'] + ' ' + t).strip()
            continue
        if in_note:
            continue
        if tag in ('id', 'ide', 'h', 'toc1', 'toc2', 'toc3', 'mt1', 'mt2', 'mt3', 'mt'):
            continue
        if tag == 'c':
            n = int(text.split()[0])
            if n != len(chapters) + 1:
                raise SystemExit(f'{book}: capítulo {n} fora de ordem')
            cur = []
            chapters.append(cur)
            verse = None
            pending_p = True
            continue
        if cur is None:
            continue
        if tag in HEADING:
            t = clean(text)
            if t:
                pending_head.append(t)
            continue
        if tag in PARA or tag in POETRY:
            if tag in POETRY:
                pending_q = True
            else:
                pending_p = True
                pending_q = False
            t = clean(text)
            if t and verse is not None:
                verse['t'] = (verse['t'] + ' ' + t).strip()
                if tag in POETRY:
                    verse['q'] = 1
            continue
        if tag == 'v':
            mm = re.match(r'(\d+)(?:-(\d+))?\s*(.*)', text.strip(), re.S)
            if not mm:
                raise SystemExit(f'{book} {len(chapters)}: versículo sem número')
            n = int(mm.group(1))
            if mm.group(2):
                raise SystemExit(f'{book} {len(chapters)}:{n}: intervalo de versículos não tratado')
            if n != len(cur) + 1:
                raise SystemExit(f'{book} {len(chapters)}:{n}: esperado {len(cur) + 1}')
            verse = {'v': n, 't': clean(mm.group(3))}
            if pending_p:
                verse['p'] = 1
            if pending_q:
                verse['q'] = 1
            if pending_head:
                headings.append({'c': len(chapters), 'v': n, 't': ' · '.join(pending_head)})
                pending_head = []
            pending_p = False
            cur.append(verse)
            continue
        # Marcadores de caractere soltos (já tratados em clean) ou desconhecidos: o texto continua no versículo atual.
        t = clean(text)
        if t and verse is not None:
            verse['t'] = (verse['t'] + ' ' + t).strip()
    for ci, ch in enumerate(chapters):
        for v in ch:
            v['t'] = clean(v['t'])
            if not v['t'] and v.get('n'):
                v['o'] = 1
            elif not v['t']:
                raise SystemExit(f'{book} {ci + 1}:{v["v"]}: versículo vazio')
    return meta, chapters, headings


def main():
    src = sys.argv[1]
    source_date = sys.argv[2] if len(sys.argv) > 2 else None
    root = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
    out = os.path.join(root, 'shared', 'bible', 'data', 'bpm')
    os.makedirs(out, exist_ok=True)
    books = []
    total_v = total_c = 0
    for i, b in enumerate(BOOKS):
        path = os.path.join(src, b.lower() + '.usfm')
        if not os.path.exists(path):
            path = os.path.join(src, b + '.usfm')
        data = open(path, 'rb').read()
        meta, chapters, headings = parse(path, b)
        payload = {'id': b, 'c': chapters}
        if headings:
            payload['h'] = headings
        text = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        open(os.path.join(out, b + '.json'), 'w', encoding='utf-8').write(text)
        verses = [len(c) for c in chapters]
        words = [sum(len(v['t'].split()) for v in c) for c in chapters]
        total_v += sum(verses)
        total_c += len(chapters)
        fix = NAME_FIX.get(b, (None, None))
        books.append({
            'id': b,
            'name': fix[0] or meta['toc2'] or meta['h'],
            'long': meta['toc1'] if not fix[0] else fix[0],
            'abbrev': fix[1] or meta['toc3'],
            'testament': 'OT' if i < NT_START else 'NT',
            'verses': verses,
            'words': words,
            'sourceSha256': hashlib.sha256(data).hexdigest(),
            'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
        })
    index = {
        'translation': 'BPM',
        'ebibleId': 'porbrbsl',
        'name': 'Bíblia Portuguesa Mundial',
        'language': 'pt-BR',
        'license': 'Domínio público',
        'licenseUrl': 'https://ebible.org/porbrbsl/copyright.htm',
        'source': 'https://ebible.org/Scriptures/porbrbsl_usfm.zip',
        'sourceDate': source_date,
        'canon': '66 livros (39 AT + 27 NT), na ordem e versificação da própria tradução',
        'totals': {'books': len(books), 'chapters': total_c, 'verses': total_v},
        'books': books,
    }
    ts = ('// GERADO por services/api/scripts/build-bible.py — não edite à mão. Índice da Bíblia Portuguesa Mundial (BPM):\n'
          '// livros, capítulos, versículos e palavras por capítulo, e o SHA-256 de cada arquivo (fonte e gerado).\n'
          'export const BPM_INDEX = ' + json.dumps(index, ensure_ascii=False, indent=1) + ' as const;\n')
    open(os.path.join(out, 'index.ts'), 'w', encoding='utf-8').write(ts)
    print(f'{len(books)} livros, {total_c} capítulos, {total_v} versículos')


main()
