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

/**
 * Únicos imports permitidos de adaptadores de IA fora do módulo (raiz de composição do assistente).
 * P05: provedor simulado. P06: provedor remoto via gateway (e o tipo do transporte, no transporte).
 * O adaptador Ollama (P06) é só contrato: nenhum arquivo do app o importa.
 */
const ADAPTER_IMPORTS = new Set([
  'integrations/ai/assistantService.ts → modules/ai/adapters/MockAIProvider.ts',
  'integrations/ai/assistantService.ts → modules/ai/adapters/GatewayAIProvider.ts',
  'integrations/ai/gatewayTransport.ts → modules/ai/adapters/GatewayAIProvider.ts',
]);
const allowedAdapterImport = (e: Edge) => ADAPTER_IMPORTS.has(`${e.from} → ${e.target}`);

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
      // P08: analytics é um modelo de leitura sobre o treinamento e só pode usar a API pública dele.
      if (ownModule === 'modules/analytics' && e.target === 'modules/training/index.ts') return false;
      // P12: metas leem treinos pela API pública do treinamento e medem com os contratos públicos do analytics.
      if (ownModule === 'modules/goals' && (e.target === 'modules/training/index.ts' || e.target === 'modules/analytics/index.ts')) return false;
      // P13: o planejamento lê treinos pela API pública do treinamento, usa o calendário do analytics e conta sessões
      // e semanas com o motor das metas (sem fórmula paralela).
      if (ownModule === 'modules/planner' && ['modules/training/index.ts', 'modules/analytics/index.ts', 'modules/goals/index.ts'].includes(e.target)) return false;
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
      // Raiz de composição do assistente (P05/P06): único ponto que registra adaptadores.
      if (allowedAdapterImport(e)) return false;
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
    // Exceção documentada (P10): a verificação de integridade valida os campos de modalidade com as mesmas regras
    // puras do domínio de treinamento, sempre pela API pública (docs/ARQUITETURA.md).
    // P12: a mesma exceção para as metas (validação de metas nos backups pela API pública de '@/modules/goals').
    // P13: idem para o planejamento ('@/modules/planner').
    const integrityRules = (e: Edge) =>
      e.from === 'lib/integrity.ts' && (e.target === 'modules/training/index.ts' || e.target === 'modules/goals/index.ts' || e.target === 'modules/planner/index.ts');
    const toDomain = edges.filter(
      (e) => inDir(e.from, 'lib') && e.target && inDir(e.target, 'modules') && e.from !== 'lib/types.ts' && !DEPRECATED_SHIMS.includes(e.from) && !integrityRules(e),
    );
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

// Fundação de IA (IronTrack 2.0 F01/P04). Regras e motivos em docs/IA_ARQUITETURA.md.
describe('arquitetura do módulo de IA', () => {
  const AI = 'modules/ai';
  /** Código da funcionalidade de assistente (P05). */
  const ASSISTANT = ['integrations/ai', 'features/assistant', 'pages/AIAssistantPage.tsx'];
  const aiFiles = files.map(rel).filter((f) => inDir(f, AI));
  /** Código sem comentários (os comentários podem citar o que é proibido). */
  const source = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('o módulo existe com camadas domain, application e adapters', () => {
    expect(aiFiles).toEqual(expect.arrayContaining([`${AI}/index.ts`, `${AI}/domain/contracts.ts`, `${AI}/application/AIService.ts`, `${AI}/adapters/MockAIProvider.ts`]));
  });

  it('domínio de IA não importa React, Dexie nem nada fora de domain/', () => {
    const bad = edges.filter((e) => inDir(e.from, `${AI}/domain`) && (!e.target || !inDir(e.target, `${AI}/domain`)));
    expect(bad.map(fmt)).toEqual([]);
  });

  it('aplicação de IA depende só do domínio de IA e de lib/dates (nunca de adaptadores, banco ou interface)', () => {
    const bad = edges.filter((e) => inDir(e.from, `${AI}/application`) && (!e.target || !(inDir(e.target, `${AI}/domain`, `${AI}/application`) || e.target === 'lib/dates.ts')));
    expect(bad.map(fmt)).toEqual([]);
  });

  it('adaptadores dependem só dos contratos do domínio de IA', () => {
    const bad = edges.filter((e) => inDir(e.from, `${AI}/adapters`) && (!e.target || !inDir(e.target, `${AI}/domain`)));
    expect(bad.map(fmt)).toEqual([]);
  });

  it('treinamento e evolução corporal não importam o módulo de IA nem adaptadores', () => {
    const bad = edges.filter((e) => inDir(e.from, 'modules/training', 'modules/body') && e.target && inDir(e.target, AI));
    expect(bad.map(fmt)).toEqual([]);
  });

  it('fora do módulo, ninguém importa adaptadores nem internals de provedores (exceto a raiz de composição)', () => {
    // P05: a raiz de composição do assistente é o único ponto que registra um adaptador.
    const bad = edges.filter((e) => !inDir(e.from, AI) && e.target && inDir(e.target, AI) && e.target !== `${AI}/index.ts` && !allowedAdapterImport(e));
    expect(bad.map(fmt)).toEqual([]);
    expect(source(`${AI}/index.ts`)).not.toMatch(/adapters/);
  });

  it('só o assistente usa o módulo de IA: hooks, banco, backup, compartilhado e as outras telas não', () => {
    const bad = edges.filter((e) => e.target && inDir(e.target, AI) && !inDir(e.from, AI, ...ASSISTANT));
    expect(bad.map(fmt)).toEqual([]);
  });

  it('o módulo de IA não persiste nem acessa rede: sem IndexedDB, storage, fetch, XHR, WebSocket ou beacon', () => {
    const FORBIDDEN = /\b(indexedDB|localStorage|sessionStorage|fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|document\.cookie|caches\.)/;
    const bad = aiFiles.filter((f) => FORBIDDEN.test(source(f)));
    expect(bad).toEqual([]);
  });

  it('adaptadores não modificam dados persistidos (sem banco, backup, repositórios ou Dexie)', () => {
    const bad = edges.filter((e) => inDir(e.from, `${AI}/adapters`) && (e.spec.startsWith('dexie') || (e.target && inDir(e.target, 'db', 'hooks', 'lib'))));
    expect(bad.map(fmt)).toEqual([]);
  });

  it('sem endpoints, variáveis de ambiente ou credenciais no módulo de IA', () => {
    const bad = aiFiles.filter((f) => /https?:\/\/|import\.meta\.env|VITE_|process\.env|api[_-]?key\s*[:=]|Bearer\s|sk-[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{10,}/i.test(source(f)));
    expect(bad).toEqual([]);
  });

  it('nenhum SDK de provedor de IA instalado nesta etapa', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /openai|anthropic|@google\/(genai|generative-ai)|ollama|langchain|@ai-sdk|^ai$/.test(d))).toEqual([]);
  });

  it('sem segredos de IA em variáveis VITE_ do projeto', () => {
    const envFiles = readdirSync(process.cwd()).filter((f) => f.startsWith('.env'));
    const bad = envFiles.filter((f) => /VITE_[A-Z_]*(KEY|TOKEN|SECRET|OPENAI|ANTHROPIC|GEMINI)/.test(readFileSync(resolve(process.cwd(), f), 'utf8')));
    expect(bad).toEqual([]);
  });
});

// Interface do assistente (IronTrack 2.0 F01/P05). Regras e motivos em docs/IA_ARQUITETURA.md.
describe('arquitetura do assistente de IA', () => {
  const INTEGRATION = 'integrations/ai';
  const UI_ASSISTANT = ['features/assistant', 'pages/AIAssistantPage.tsx'];
  const assistantFiles = files.map(rel).filter((f) => inDir(f, INTEGRATION, ...UI_ASSISTANT));
  const TRANSPORT = 'integrations/ai/gatewayTransport.ts';
  const source = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('os arquivos do assistente existem', () => {
    expect(assistantFiles).toEqual(
      expect.arrayContaining(['integrations/ai/assistantService.ts', 'integrations/ai/contextSources.ts', 'features/assistant/useAssistant.ts', 'pages/AIAssistantPage.tsx']),
    );
  });

  it('a tela do assistente não acessa banco nem adaptadores: passa pela integração', () => {
    const bad = edges.filter((e) => inDir(e.from, ...UI_ASSISTANT) && e.target && (inDir(e.target, 'db', 'modules/ai/adapters') || e.spec.startsWith('dexie')));
    expect(bad.map(fmt)).toEqual([]);
  });

  it('a integração só usa funções de LEITURA da persistência', () => {
    const READS = new Set(['getSettings', 'completedSessionsSince', 'recentCompletedSessions', 'listBodyEntries', 'recentBodyEntries']);
    const dbEdges = edges.filter((e) => inDir(e.from, INTEGRATION) && e.target && inDir(e.target, 'db'));
    expect(dbEdges.flatMap((e) => e.names.filter((n) => !READS.has(n)).map((n) => `${fmt(e)} (${n})`))).toEqual([]);
    // Nem o objeto do banco, nem métodos de escrita do Dexie.
    const WRITE = /\.(put|add|bulkPut|bulkAdd|update|delete|bulkDelete|clear|modify)\s*\(/;
    expect(assistantFiles.filter((f) => WRITE.test(source(f)))).toEqual([]);
  });

  it('sem HTML arbitrário, execução de código, armazenamento do navegador ou rede no assistente', () => {
    const FORBIDDEN = /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(|new\s+Function\s*\(|\b(localStorage|sessionStorage|indexedDB)\b|fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|document\.cookie|caches\.|console\.(log|info|debug|warn|error)/;
    // P06: a única exceção de rede é o transporte do gateway (verificado no teste seguinte).
    expect(assistantFiles.filter((f) => f !== TRANSPORT && FORBIDDEN.test(source(f)))).toEqual([]);
    const NO_NETWORK = new RegExp(FORBIDDEN.source.replace('fetch\\s*\\(|', ''));
    expect(NO_NETWORK.test(source(TRANSPORT))).toBe(false);
  });

  it('P06: rede de IA só no transporte do gateway, sem redirecionamento, cookies ou Referer', () => {
    const net = files.map(rel).filter((f) => /fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(source(f)));
    // Fora do transporte, só o registro do service worker e a importação de arquivos locais podem usar fetch.
    expect(net.filter((f) => inDir(f, 'modules/ai', 'integrations/ai', 'features/assistant', 'pages/AIAssistantPage.tsx'))).toEqual([TRANSPORT]);
    const t = source(TRANSPORT);
    expect(t).toMatch(/redirect:\s*'error'/);
    expect(t).toMatch(/credentials:\s*'omit'/);
    expect(t).toMatch(/referrerPolicy:\s*'no-referrer'/);
    // O transporte só é usado pela raiz de composição (nunca pelas telas).
    expect(edges.filter((e) => e.target === TRANSPORT).map((e) => e.from)).toEqual(['integrations/ai/assistantService.ts']);
  });

  it('P06: o app não importa o gateway (services/) nem SDKs; o adaptador Ollama não está ativo', () => {
    expect(edges.filter((e) => /(^|\/)services\//.test(e.spec)).map(fmt)).toEqual([]);
    expect(edges.filter((e) => e.target === 'modules/ai/adapters/OllamaProvider.ts').map(fmt)).toEqual([]);
  });

  it('P06: o gateway não importa código do app (implantação independente)', () => {
    const dir = resolve(process.cwd(), 'services/ai-gateway');
    const gw = (d: string): string[] => readdirSync(d).flatMap((f) => (f === 'node_modules' ? [] : statSync(join(d, f)).isDirectory() ? gw(join(d, f)) : /\.ts$/.test(f) ? [join(d, f)] : []));
    const bad = gw(dir).filter((f) => /from\s+['"](@\/|(\.\.\/){3,})/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });

  it('P06: o token de acesso e o endereço do gateway não são persistidos nem registrados', () => {
    for (const f of assistantFiles) expect(source(f), f).not.toMatch(/\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b|db\.\w+\.(put|add)/);
  });

  it('sem endpoints, variáveis de ambiente ou credenciais no assistente', () => {
    // O transporte monta o cabeçalho `Bearer ${token}` com o token digitado (nenhum valor fixo).
    const code = (f: string) => (f === TRANSPORT ? source(f).replace('`Bearer ${token}`', '') : source(f));
    const bad = assistantFiles.filter((f) => /https?:\/\/|import\.meta\.env|VITE_|process\.env|api[_-]?key\s*[:=]|Bearer\s|sk-[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{10,}/i.test(code(f)));
    expect(bad).toEqual([]);
  });

  it('a rota do assistente é carregada sob demanda pela tela, sem substituir outras', () => {
    const app = readFileSync(join(ROOT, 'App.tsx'), 'utf8');
    expect(app).toMatch(/lazy\(\(\) => import\('@\/pages\/AIAssistantPage'\)\)/);
    expect(app).toMatch(/path="\/assistente"/);
    for (const r of ['/treinos', '/historico', '/evolucao', '/config']) expect(app).toContain(`path="${r}"`);
  });
});

// Motor de análise de treinos (IronTrack 2.0 F01/P08). Regras e motivos em docs/ANALYTICS_TREINAMENTO.md.
describe('arquitetura do motor de analytics', () => {
  const AN = 'modules/analytics';
  const anFiles = files.map(rel).filter((f) => inDir(f, AN));
  const source = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('o módulo existe com domain, application e API pública', () => {
    expect(anFiles).toEqual(
      expect.arrayContaining([`${AN}/index.ts`, `${AN}/domain/types.ts`, `${AN}/domain/metrics.ts`, `${AN}/domain/periods.ts`, `${AN}/domain/trends.ts`, `${AN}/application/TrainingAnalyticsService.ts`, `${AN}/application/InsightsEngine.ts`]),
    );
  });

  it('domínio de analytics: sem React, Dexie ou banco; só o próprio domínio, lib/dates e a API pública do treinamento', () => {
    const ok = new Set(['lib/dates.ts', 'modules/training/index.ts']);
    const bad = edges.filter((e) => inDir(e.from, `${AN}/domain`) && (!e.target || !(inDir(e.target, `${AN}/domain`) || ok.has(e.target))));
    expect(bad.map(fmt)).toEqual([]);
  });

  it('aplicação de analytics: só domain/application do módulo, lib/dates e a API pública do treinamento', () => {
    const ok = new Set(['lib/dates.ts', 'modules/training/index.ts']);
    const bad = edges.filter((e) => inDir(e.from, `${AN}/application`) && (!e.target || !(inDir(e.target, `${AN}/domain`, `${AN}/application`) || ok.has(e.target))));
    expect(bad.map(fmt)).toEqual([]);
  });

  it('analytics não depende de IA, corpo, banco, hooks, integrações ou interface', () => {
    const bad = edges.filter((e) => inDir(e.from, AN) && e.target && inDir(e.target, 'modules/ai', 'modules/body', 'db', 'hooks', 'integrations', ...UI));
    expect(bad.map(fmt)).toEqual([]);
    const pkgs = edges.filter((e) => inDir(e.from, AN) && !e.target);
    expect(pkgs.map(fmt)).toEqual([]);
  });

  it('analytics não grava, não persiste e não acessa rede', () => {
    // Set.add/Map.delete são usados em memória; o acesso ao banco já é barrado pelo teste anterior.
    const FORBIDDEN = /\b(indexedDB|localStorage|sessionStorage|fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|document\.cookie|caches\.)|\.(put|bulkPut|bulkAdd|update|bulkDelete|modify|transaction)\s*\(|https?:\/\/|import\.meta\.env|process\.env/;
    expect(anFiles.filter((f) => FORBIDDEN.test(source(f)))).toEqual([]);
  });

  it('o resumo para IA não é usado: IA, assistente, treinamento e corpo não importam analytics', () => {
    const bad = edges.filter((e) => e.target && inDir(e.target, AN) && inDir(e.from, 'modules/ai', 'modules/training', 'modules/body', 'integrations', 'features/assistant', 'pages/AIAssistantPage.tsx', 'db', 'hooks', 'lib'));
    expect(bad.map(fmt)).toEqual([]);
  });

  it('fora do módulo, importa-se só a API pública de analytics', () => {
    const deep = edges.filter((e) => !inDir(e.from, AN) && e.target && inDir(e.target, AN) && e.target !== `${AN}/index.ts`);
    expect(deep.map(fmt)).toEqual([]);
  });

  it('a página é carregada sob demanda numa sub-rota de /evolucao, sem novo item na navegação', () => {
    const app = readFileSync(join(ROOT, 'App.tsx'), 'utf8');
    expect(app).toMatch(/lazy\(\(\) => import\('@\/pages\/TrainingAnalyticsPage'\)\)/);
    expect(app).toMatch(/path="\/evolucao\/desempenho"/);
    for (const r of ['/treinos', '/historico', '/evolucao', '/assistente', '/config']) expect(app).toContain(`path="${r}"`);
    const layout = readFileSync(join(ROOT, 'components/AppLayout.tsx'), 'utf8');
    expect((layout.match(/^\s*\{ to: '\//gm) ?? []).length).toBe(6);
    expect(layout).toContain('grid-cols-6');
  });
});

describe('arquitetura das metas de treinamento (P12)', () => {
  const GO = 'modules/goals';
  const rels = files.map(rel);
  const goalFiles = rels.filter((f) => inDir(f, GO));
  const source = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('o domínio de metas existe e depende só de treinamento, analytics (API pública) e utilitários puros', () => {
    expect(goalFiles).toEqual(expect.arrayContaining([`${GO}/index.ts`, `${GO}/progress.ts`, `${GO}/validation.ts`]));
    const bad = edges.filter((e) => inDir(e.from, GO) && e.target && !inDir(e.target, GO) && !['modules/training/index.ts', 'modules/analytics/index.ts', 'lib/dates.ts', 'lib/utils.ts'].includes(e.target));
    expect(bad.map(fmt)).toEqual([]);
    expect(edges.filter((e) => inDir(e.from, GO) && !e.target && !e.spec.startsWith('.')).map(fmt)).toEqual([]);
  });

  it('o motor de metas não grava nem acessa rede: sem IndexedDB, storage, fetch, IA ou escrita em sessões', () => {
    const FORBIDDEN = /\b(indexedDB|localStorage|sessionStorage|fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|document\.cookie|caches\.|Math\.random|Date\.now\s*\(\s*\))/;
    expect(goalFiles.filter((f) => FORBIDDEN.test(source(f)))).toEqual([]);
  });

  it('metas não vão para a IA: módulo de IA, integrações e assistente não importam metas nem src/db/goals', () => {
    const bad = edges.filter((e) => e.target && (inDir(e.target, GO) || e.target === 'db/goals.ts' || e.target === 'hooks/useGoals.ts') && inDir(e.from, 'modules/ai', 'integrations', 'features/assistant', 'pages/AIAssistantPage.tsx'));
    expect(bad.map(fmt)).toEqual([]);
  });

  it('só src/db (gravações) e a restauração de backup tocam a tabela de metas', () => {
    const writers = rels.filter((f) => !inDir(f, 'db') && f !== 'lib/backup.ts' && /\bdb\.goals\b/.test(source(f)));
    expect(writers).toEqual([]);
  });

  it('a página de metas é carregada sob demanda em /metas, sem novo item na navegação', () => {
    const app = readFileSync(join(ROOT, 'App.tsx'), 'utf8');
    expect(app).toMatch(/lazy\(\(\) => import\('@\/pages\/TrainingGoalsPage'\)\)/);
    expect(app).toMatch(/path="\/metas"/);
    const layout = readFileSync(join(ROOT, 'components/AppLayout.tsx'), 'utf8');
    expect((layout.match(/^\s*\{ to: '\//gm) ?? []).length).toBe(6);
  });
});

describe('arquitetura do planejamento semanal (P13)', () => {
  const PL = 'modules/planner';
  const rels = files.map(rel);
  const plannerFiles = rels.filter((f) => inDir(f, PL));
  const source = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('o domínio existe e depende só de treinamento, analytics e metas (APIs públicas)', () => {
    expect(plannerFiles).toEqual(expect.arrayContaining([`${PL}/index.ts`, `${PL}/operations.ts`, `${PL}/week.ts`, `${PL}/validation.ts`]));
    const allowed = ['modules/training/index.ts', 'modules/analytics/index.ts', 'modules/goals/index.ts'];
    const bad = edges.filter((e) => inDir(e.from, PL) && e.target && !inDir(e.target, PL) && !allowed.includes(e.target));
    expect(bad.map(fmt)).toEqual([]);
    expect(edges.filter((e) => inDir(e.from, PL) && !e.target && !e.spec.startsWith('.')).map(fmt)).toEqual([]);
  });

  it('o domínio não grava nem acessa rede, relógio ou aleatoriedade', () => {
    const FORBIDDEN = /\b(indexedDB|localStorage|sessionStorage|fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|document\.cookie|caches\.|Math\.random|Date\.now\s*\(\s*\)|new Date\(\s*\))/;
    expect(plannerFiles.filter((f) => FORBIDDEN.test(source(f)))).toEqual([]);
  });

  it('planejamento não vai para a IA: IA, integrações e assistente não o importam nem citam a tabela', () => {
    const bad = edges.filter(
      (e) => e.target && (inDir(e.target, PL) || e.target === 'db/planner.ts' || e.target === 'hooks/usePlanner.ts') && inDir(e.from, 'modules/ai', 'integrations', 'features/assistant', 'pages/AIAssistantPage.tsx'),
    );
    expect(bad.map(fmt)).toEqual([]);
    const mentions = rels.filter((f) => inDir(f, 'modules/ai', 'integrations', 'features/assistant') && /planEntries|planejamento/i.test(source(f)));
    expect(mentions).toEqual([]);
  });

  it('só src/db e a restauração de backup tocam a tabela; o planejamento não grava sessões, rotinas nem rotação', () => {
    expect(rels.filter((f) => !inDir(f, 'db') && f !== 'lib/backup.ts' && /\bdb\.planEntries\b/.test(source(f)))).toEqual([]);
    expect(/db\.(sessions|routines|rotations|overrides|goals)\b/.test(source('db/planner.ts'))).toBe(false);
  });

  it('a página é carregada sob demanda em /planejamento, sem novo item na navegação', () => {
    const app = readFileSync(join(ROOT, 'App.tsx'), 'utf8');
    expect(app).toMatch(/lazy\(\(\) => import\('@\/pages\/WeeklyPlannerPage'\)\)/);
    expect(app).toMatch(/path="\/planejamento"/);
    const layout = readFileSync(join(ROOT, 'components/AppLayout.tsx'), 'utf8');
    expect((layout.match(/^\s*\{ to: '\//gm) ?? []).length).toBe(6);
  });
});
