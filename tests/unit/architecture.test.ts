// Limites arquiteturais (IronTrack 2.0 F01/P03). Regras e motivos em docs/ARQUITETURA.md.
// Lê os imports de src/ com uma expressão regular simples (sem ferramentas extras) e
// confere as dependências permitidas entre camadas e domínios.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(process.cwd(), 'src');

interface Edge {
  from: string;
  /** Especificador como escrito no código. */
  spec: string;
  /** Arquivo de src/ resolvido (null para pacotes externos). */
  target: string | null;
  /** Nomes importados entre chaves, quando houver. */
  names: string[];
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return listFiles(p);
    return /\.tsx?$/.test(f) && !f.endsWith('.d.ts') ? [p] : [];
  });
}

const rel = (abs: string) => relative(ROOT, abs).split('\\').join('/');

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = join(dirname(from), spec);
  else return null;
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx'), base])
    if (existsSync(c) && statSync(c).isFile()) return rel(c);
  throw new Error(`Import não resolvido em ${rel(from)}: ${spec}`);
}

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?([^'"]*?)\s*from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

const files = listFiles(ROOT);
const edges: Edge[] = files.flatMap((abs) => {
  const src = readFileSync(abs, 'utf8');
  const out: Edge[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = (m[2] ?? m[3] ?? m[4])!;
    const names = (/\{([^}]*)\}/.exec(m[1] ?? '')?.[1] ?? '').split(',').map((n) => n.replace(/^\s*type\s+/, '').trim().split(/\s+as\s+/)[0]).filter(Boolean);
    out.push({ from: rel(abs), spec, target: resolveSpec(abs, spec), names });
  }
  return out;
});

const inDir = (file: string, ...dirs: string[]) => dirs.some((d) => file === d || file.startsWith(`${d}/`));
const fmt = (e: Edge) => `${e.from} → ${e.spec}`;

/** Caminhos antigos de src/lib mantidos só por compatibilidade (reexportações @deprecated). */
const DEPRECATED_SHIMS = ['session', 'rotation', 'progression', 'volume', 'stats', 'restTimer', 'routineSchema', 'bodySchema', 'bodyPdf', 'bodyEvolution', 'bodyRegions'].map((f) => `lib/${f}.ts`);

const UI = ['pages', 'features', 'components', 'App.tsx'];

describe('arquitetura', () => {
  it('o leitor de imports encontra os arquivos e dependências do app', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(edges.some((e) => e.from === 'modules/training/stats.ts' && e.target === 'modules/training/volume.ts')).toBe(true);
    expect(edges.some((e) => e.from === 'App.tsx' && e.spec === '@/pages/WorkoutsPage')).toBe(true);
  });

  it('sem dependências circulares (inclusive imports só de tipo)', () => {
    const graph = new Map<string, string[]>(files.map((f) => [rel(f), []]));
    for (const e of edges) if (e.target) graph.get(e.from)!.push(e.target);
    const state = new Map<string, 'visiting' | 'done'>();
    const cycles: string[] = [];
    const visit = (n: string, path: string[]) => {
      if (state.get(n) === 'done') return;
      if (state.get(n) === 'visiting') {
        cycles.push([...path.slice(path.indexOf(n)), n].join(' → '));
        return;
      }
      state.set(n, 'visiting');
      for (const t of graph.get(n) ?? []) visit(t, [...path, n]);
      state.set(n, 'done');
    };
    for (const n of graph.keys()) visit(n, []);
    expect(cycles).toEqual([]);
  });

  it('domínios (src/modules) são puros: sem React, Dexie, banco, hooks ou telas', () => {
    const allowedPackages = new Set(['zod', 'pdfjs-dist', 'pdfjs-dist/build/pdf.worker.min.mjs?url']);
    const allowedShared = new Set(['lib/utils.ts', 'lib/dates.ts', 'lib/validation.ts']);
    const bad = edges.filter((e) => {
      if (!inDir(e.from, 'modules')) return false;
      if (!e.target) return !allowedPackages.has(e.spec);
      const ownModule = e.from.split('/').slice(0, 2).join('/');
      return !inDir(e.target, ownModule) && !allowedShared.has(e.target);
    });
    expect(bad.map(fmt)).toEqual([]);
  });

  it('treinamento e evolução corporal não dependem um do outro', () => {
    const cross = edges.filter(
      (e) => e.target && ((inDir(e.from, 'modules/training') && inDir(e.target, 'modules/body')) || (inDir(e.from, 'modules/body') && inDir(e.target, 'modules/training'))),
    );
    expect(cross.map(fmt)).toEqual([]);
  });

  it('fora de um domínio, importa-se só a API pública dele (index.ts)', () => {
    const deep = edges.filter((e) => {
      if (!e.target || !inDir(e.target, 'modules') || e.target.endsWith('/index.ts')) return false;
      const own = e.from.split('/').slice(0, 2).join('/');
      if (inDir(e.from, 'modules') && inDir(e.target, own)) return false;
      // Exceções documentadas: reexportações de compatibilidade e o agregador de tipos.
      if (DEPRECATED_SHIMS.includes(e.from)) return false;
      if (e.from === 'lib/types.ts' && /^modules\/[^/]+\/types\.ts$/.test(e.target)) return false;
      return true;
    });
    expect(deep.map(fmt)).toEqual([]);
  });

  it('telas e componentes não acessam o Dexie diretamente (usam src/db e src/hooks)', () => {
    const bad = edges.filter(
      (e) => inDir(e.from, ...UI) && (e.spec === 'dexie' || e.spec === 'dexie-react-hooks' || (e.target === 'db/db.ts' && e.names.includes('db'))),
    );
    expect(bad.map(fmt)).toEqual([]);
  });

  it('src/lib (compartilhado) não depende de interface nem dos domínios; as regras puras não dependem do banco', () => {
    const upward = edges.filter((e) => inDir(e.from, 'lib') && (['react', 'react-dom', 'dexie-react-hooks'].includes(e.spec) || (e.target && inDir(e.target, 'hooks', ...UI))));
    expect(upward.map(fmt)).toEqual([]);
    // O compartilhado não conhece os domínios (exceto o agregador de tipos e as reexportações).
    const toDomain = edges.filter((e) => inDir(e.from, 'lib') && e.target && inDir(e.target, 'modules') && e.from !== 'lib/types.ts' && !DEPRECATED_SHIMS.includes(e.from));
    expect(toDomain.map(fmt)).toEqual([]);
    const PURE = ['validation', 'integrity', 'merge', 'profile', 'backupFormat', 'dates', 'units', 'defaults', 'types', 'utils'].map((f) => `lib/${f}.ts`);
    const impure = edges.filter((e) => PURE.includes(e.from) && (e.spec === 'dexie' || (e.target && inDir(e.target, 'db'))));
    expect(impure.map(fmt)).toEqual([]);
  });

  it('a persistência (src/db) não depende de interface', () => {
    const bad = edges.filter((e) => inDir(e.from, 'db') && (e.spec === 'react' || e.spec === 'sonner' || (e.target && inDir(e.target, 'hooks', ...UI))));
    expect(bad.map(fmt)).toEqual([]);
  });

  it('código novo não usa os caminhos @deprecated de src/lib', () => {
    const bad = edges.filter((e) => e.target && DEPRECATED_SHIMS.includes(e.target) && !DEPRECATED_SHIMS.includes(e.from));
    expect(bad.map(fmt)).toEqual([]);
  });
});
