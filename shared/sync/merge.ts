// Mesclagem de três vias da sincronização (Prompt 21, docs/NUVEM_SINCRONIZACAO.md §5). Pura e determinística.
// base   = última versão do servidor que este aparelho conhecia;
// local  = registro atual do aparelho (com a alteração pendente);
// remote = versão atual do servidor (alterada por outro aparelho).
// Só mescla sozinha quando as mudanças NÃO se sobrepõem. Se os dois lados mudaram a mesma coisa de formas diferentes,
// devolve os caminhos em conflito e nada é escolhido: a operação fica pendente até a pessoa decidir.
// Nunca usa horário do aparelho para escolher um lado (sem "última gravação vence").
import { canonicalJson } from '../canonical.ts';
import type { SyncCollection } from './collections.ts';

export type MergeResult = { ok: true; merged: Record<string, unknown> } | { ok: false; conflicts: string[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const eq = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const hasId = (v: unknown): v is Obj & { id: string } => isObj(v) && typeof v.id === 'string';
const idArray = (v: unknown): v is (Obj & { id: string })[] => Array.isArray(v) && v.every(hasId) && new Set(v.map((x) => x.id)).size === v.length;

/**
 * Chaves que, se mudarem em um lado enquanto o outro mudou QUALQUER coisa, exigem decisão (por coleção).
 * Ex.: treino finalizado num aparelho enquanto séries eram registradas em outro.
 */
const GUARD_KEYS: Partial<Record<SyncCollection, readonly string[]>> = {
  sessions: ['status', 'finishedAt', 'timing'],
};

/** Contadores de concorrência local (por aba) e carimbos: os dois lados sempre mudam; fica o maior. */
const MAX_KEYS = new Set(['updatedAt', 'revision']);

export function threeWayMerge(collection: SyncCollection, base: Obj | null, local: Obj, remote: Obj): MergeResult {
  if (eq(local, remote)) return { ok: true, merged: local };
  // Sem base conhecida (entidade criada nos dois lados com o mesmo ID): só é seguro se forem iguais.
  if (!base) return { ok: false, conflicts: ['(registro inteiro)'] };
  const guards = GUARD_KEYS[collection] ?? [];
  const changedL = changedKeys(base, local);
  const changedR = changedKeys(base, remote);
  const meaningful = (s: Set<string>) => [...s].some((k) => !MAX_KEYS.has(k));
  for (const g of guards) if ((changedL.has(g) && meaningful(changedR)) || (changedR.has(g) && meaningful(changedL))) return { ok: false, conflicts: [g] };
  const conflicts: string[] = [];
  const merged = mergeObj(base, local, remote, '', conflicts, true) as Obj;
  return conflicts.length ? { ok: false, conflicts } : { ok: true, merged };
}

function changedKeys(base: Obj, side: Obj): Set<string> {
  const keys = new Set([...Object.keys(base), ...Object.keys(side)]);
  return new Set([...keys].filter((k) => !eq(base[k], side[k])));
}

function mergeValue(b: unknown, l: unknown, r: unknown, path: string, conflicts: string[]): unknown {
  if (eq(l, r)) return l;
  if (eq(b, l)) return r;
  if (eq(b, r)) return l;
  if (isObj(l) && isObj(r) && (isObj(b) || b === undefined)) return mergeObj(isObj(b) ? b : {}, l, r, path, conflicts, false);
  if (idArray(l) && idArray(r) && (b === undefined || idArray(b))) return mergeIdArray((b as (Obj & { id: string })[] | undefined) ?? [], l, r, path, conflicts);
  conflicts.push(path || '(raiz)');
  return l;
}

function mergeObj(b: Obj, l: Obj, r: Obj, path: string, conflicts: string[], root: boolean): Obj {
  const out: Obj = {};
  const keys = [...new Set([...Object.keys(r), ...Object.keys(l)])];
  for (const k of keys) {
    const p = path ? `${path}.${k}` : k;
    let v: unknown;
    if (root && MAX_KEYS.has(k) && typeof l[k] === 'number' && typeof r[k] === 'number') v = Math.max(l[k] as number, r[k] as number);
    else v = mergeValue(b[k], l[k], r[k], p, conflicts);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Arrays de objetos com `id` (exercícios, séries, treinos da ficha): mescla item a item. */
function mergeIdArray(b: (Obj & { id: string })[], l: (Obj & { id: string })[], r: (Obj & { id: string })[], path: string, conflicts: string[]): Obj[] {
  const byId = (a: (Obj & { id: string })[]) => new Map(a.map((x) => [x.id, x]));
  const B = byId(b);
  const L = byId(l);
  const R = byId(r);
  const items = new Map<string, Obj>();
  const all = new Set([...B.keys(), ...L.keys(), ...R.keys()]);
  for (const id of all) {
    const p = `${path}[${id}]`;
    const bi = B.get(id);
    const li = L.get(id);
    const ri = R.get(id);
    if (bi) {
      // Existia na base.
      if (!li && !ri) continue; // removido nos dois
      if (!li) {
        if (eq(bi, ri)) continue; // removido aqui, intacto lá
        conflicts.push(`${p} (removido neste aparelho e alterado em outro)`);
        continue;
      }
      if (!ri) {
        if (eq(bi, li)) continue; // removido lá, intacto aqui
        conflicts.push(`${p} (removido em outro aparelho e alterado neste)`);
        continue;
      }
      items.set(id, mergeValue(bi, li, ri, p, conflicts) as Obj);
    } else if (li && ri) {
      // Criado nos dois lados com o mesmo ID.
      if (eq(li, ri)) items.set(id, li);
      else conflicts.push(`${p} (criado nos dois aparelhos)`);
    } else items.set(id, (li ?? ri)!);
  }
  // Ordem: se só um lado reordenou, vale a ordem dele; se os dois reordenaram de formas diferentes, é conflito.
  const orderOf = (a: (Obj & { id: string })[]) => a.map((x) => x.id).filter((id) => items.has(id) && B.has(id));
  const ob = orderOf(b);
  const ol = orderOf(l);
  const or = orderOf(r);
  let order: string[];
  if (eq(ol, or) || eq(ob, ol)) order = or;
  else if (eq(ob, or)) order = ol;
  else {
    conflicts.push(`${path} (ordem alterada nos dois aparelhos)`);
    order = or;
  }
  // Itens novos: entram na posição relativa do lado que os criou (depois do item anterior conhecido).
  const result = [...order];
  for (const side of [r, l]) {
    side.forEach((x, i) => {
      if (B.has(x.id) || !items.has(x.id) || result.includes(x.id)) return;
      const prev = side
        .slice(0, i)
        .reverse()
        .find((y) => result.includes(y.id));
      const at = prev ? result.indexOf(prev.id) + 1 : 0;
      result.splice(at, 0, x.id);
    });
  }
  return result.map((id) => items.get(id)!);
}
