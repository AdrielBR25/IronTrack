import type { SessionExercise, SessionSet, WorkoutSession } from './types';

// Mescla em três vias do treino em andamento (IronTrack 2.0 F01/P11, docs/CRONOMETROS_E_CONCORRENCIA.md §9).
// Usada quando a aba vai gravar e descobre que o banco mudou desde a última versão que ela conhecia (outra aba,
// o aviso de descanso, etc.). Em vez de sobrescrever o registro inteiro, aplica só o que ESTA aba mudou sobre a
// versão do banco, campo a campo e série a série (por ID). Se as duas mudaram o mesmo campo de forma diferente,
// vale o que já está no banco (quem gravou primeiro) e o conflito é informado. Funções puras.
//
// Garantias: nenhuma série é duplicada (séries são identificadas por ID); uma série concluída em outra aba não volta a
// pendente por causa de uma tela desatualizada; nada é apagado sem que esta aba tenha removido explicitamente uma
// série que a outra não alterou.

export interface SessionMergeResult {
  merged: WorkoutSession;
  /** Campos em que as duas versões divergiram (prevaleceu o banco). Vazio = mescla limpa. */
  conflicts: string[];
}

function stable(v: unknown): string {
  if (v === undefined) return 'u';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`;
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

function merge3<T extends object>(base: T | undefined, local: T, fresh: T, path: string, conflicts: string[], skip: readonly string[] = []): T {
  const b = (base ?? {}) as Record<string, unknown>;
  const l = local as Record<string, unknown>;
  const f = fresh as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(l), ...Object.keys(f), ...Object.keys(b)])) {
    if (skip.includes(k)) continue;
    let v: unknown;
    if (same(l[k], b[k])) v = f[k];
    else if (same(f[k], b[k]) || same(l[k], f[k])) v = l[k];
    else {
      v = f[k];
      conflicts.push(`${path}${k}`);
    }
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

function mergeSets(base: SessionSet[], local: SessionSet[], fresh: SessionSet[], path: string, conflicts: string[]): SessionSet[] {
  const bMap = new Map(base.map((s) => [s.id, s]));
  const lMap = new Map(local.map((s) => [s.id, s]));
  const fIds = new Set(fresh.map((s) => s.id));
  const out: SessionSet[] = [];
  for (const f of fresh) {
    const b = bMap.get(f.id);
    const l = lMap.get(f.id);
    if (!l) {
      // Removida nesta aba: só sai se a outra não a alterou.
      if (b && same(f, b)) continue;
      if (b) conflicts.push(`${path}${f.id}`);
      out.push(f);
      continue;
    }
    out.push(b ? merge3(b, l, f, `${path}${f.id}.`, conflicts) : f);
  }
  // Séries que só esta aba tem: novas (inseridas depois da antecessora local) ou removidas na outra aba.
  local.forEach((l, i) => {
    if (fIds.has(l.id)) return;
    const b = bMap.get(l.id);
    if (b) {
      if (!same(l, b)) conflicts.push(`${path}${l.id}`);
      return;
    }
    let at = out.length;
    for (let j = i - 1; j >= 0; j--) {
      const idx = out.findIndex((s) => s.id === local[j].id);
      if (idx >= 0) {
        at = idx + 1;
        break;
      }
    }
    out.splice(at, 0, l);
  });
  return out;
}

/**
 * `base`: a versão do banco que esta aba conhecia; `local`: o que esta aba quer gravar; `fresh`: o banco agora.
 * O resultado mantém a ordem dos exercícios do banco.
 */
export function mergeSessionEdits(base: WorkoutSession, local: WorkoutSession, fresh: WorkoutSession): SessionMergeResult {
  const conflicts: string[] = [];
  const top = merge3(base, local, fresh, '', conflicts, ['exercises', 'updatedAt']);
  const bEx = new Map(base.exercises.map((e) => [e.id, e]));
  const lEx = new Map(local.exercises.map((e) => [e.id, e]));
  const exercises: SessionExercise[] = fresh.exercises.map((f) => {
    const l = lEx.get(f.id);
    const b = bEx.get(f.id);
    if (!l) return f;
    const fields = merge3(b, l, f, `${f.id}.`, conflicts, ['sets']);
    return { ...fields, sets: mergeSets(b?.sets ?? [], l.sets, f.sets, `${f.id}.sets.`, conflicts) };
  });
  for (const l of local.exercises) if (!fresh.exercises.some((f) => f.id === l.id) && !bEx.has(l.id)) exercises.push(l);
  return { merged: { ...top, exercises, updatedAt: fresh.updatedAt }, conflicts };
}
