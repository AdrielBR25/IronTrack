// Substituição durante o treino e edição de treinos finalizados (IronTrack 2.0 F01/P20). Ver docs/EDICAO_HISTORICO.md.
// Regras puras (sem banco): cada função devolve uma nova sessão; a gravação transacional fica em src/db/sessionEdits.ts.
//
// Identidades (nunca por nome):
// - o exercício da sessão tem ID próprio (`SessionExercise.id`); a instância da ficha é `templateId`; a origem na
//   biblioteca é `catalogId`/`customExerciseId` (só referência);
// - um substituto é SEMPRE um exercício novo (ID novo, sem `templateId`): metas ligadas à instância da ficha não são
//   redirecionadas e o desempenho do anterior continua dele;
// - séries já feitas nunca são apagadas, convertidas nem reatribuídas a outro exercício.
import type { SessionExercise, SessionRevision, SessionRevisionKind, SessionRevisionSnapshot, SessionSet, WorkoutSession } from './types';
import { exerciseMeasures, setCompletionErrors, type ExerciseMeasures } from './exerciseModel';
import { MAX_SESSION_DURATION_SEC } from './timing';
import { setLabel } from './session';

/** Revisões guardadas por treino (as mais antigas saem). */
export const MAX_SESSION_REVISIONS = 10;

const isWork = (s: SessionSet) => s.type !== 'warmup';
const doneSets = (e: SessionExercise) => e.sets.filter((s) => s.status === 'done');

/** As duas formas registram as mesmas medidas (carga, repetições, duração, distância, assistência)? */
export function sameMeasures(a: ExerciseMeasures, b: ExerciseMeasures): boolean {
  return a.reps === b.reps && a.weight === b.weight && a.assistance === b.assistance && a.duration === b.duration && a.distance === b.distance;
}

const MEASURE_LABEL: [keyof ExerciseMeasures, string][] = [
  ['reps', 'repetições'],
  ['assistance', 'assistência'],
  ['duration', 'duração'],
  ['distance', 'distância'],
];

/** Diferenças de registro entre dois exercícios, em texto (para avisos de incompatibilidade). */
export function measureDifferences(from: SessionExercise, to: SessionExercise): string[] {
  const a = exerciseMeasures(from);
  const b = exerciseMeasures(to);
  const out: string[] = [];
  if (a.weight !== b.weight) {
    const w = (x: ExerciseMeasures['weight']) => (x === 'none' ? 'sem carga' : x === 'adicional' ? 'carga adicional' : 'carga externa');
    out.push(`Carga: ${w(a.weight)} → ${w(b.weight)}.`);
  }
  for (const [k, label] of MEASURE_LABEL) if (a[k] !== b[k]) out.push(b[k] ? `O novo exercício registra ${label}.` : `O novo exercício não registra ${label}.`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Substituição durante o treino ativo
// ---------------------------------------------------------------------------------------------------------------

export type SwapMode = 'replace' | 'split';

export interface SwapPreview {
  mode: SwapMode;
  current: SessionExercise;
  next: SessionExercise;
  /** Séries de trabalho planejadas no atual (sem aquecimento e sem puladas). */
  plannedWork: number;
  doneWork: number;
  doneWarmup: number;
  /** Cargas registradas nas séries feitas do atual (kg, na ordem). */
  doneLoads: (number | null)[];
  pendingWork: number;
  /** Séries que o novo exercício receberá. */
  nextSets: number;
  restOnThis: boolean;
  incompatibilities: string[];
  /** O que acontece com as séries e com a identidade (texto para a tela). */
  policy: string[];
}

/**
 * Prévia da troca de um exercício do treino em andamento.
 * - Sem série feita (`replace`): o novo ocupa a posição do atual; o atual sai da sessão (não foi executado). Se o
 *   registro é compatível, mantém séries, faixa de repetições e descanso do plano; cargas vêm só do histórico do
 *   PRÓPRIO novo exercício (nunca do atual).
 * - Com séries feitas (`split`): o atual fica com as séries feitas (as pendentes saem) e é marcado como encerrado por
 *   substituição; o novo entra logo depois com as séries restantes. Nada já registrado muda.
 */
export function swapPreview(session: WorkoutSession, exId: string, candidate: SessionExercise): SwapPreview | null {
  const current = session.exercises.find((e) => e.id === exId);
  if (!current || candidate.id === current.id) return null;
  const work = current.sets.filter((s) => isWork(s) && s.status !== 'skipped');
  const done = doneSets(current);
  const doneWork = done.filter(isWork).length;
  const doneWarmup = done.length - doneWork;
  const pendingWork = current.sets.filter((s) => isWork(s) && s.status === 'pending').length;
  const mode: SwapMode = done.length ? 'split' : 'replace';
  const compatible = sameMeasures(exerciseMeasures(current), exerciseMeasures(candidate));
  const nextSets = mode === 'split' ? Math.max(1, pendingWork) : compatible ? Math.max(1, current.plannedSets) : candidate.plannedSets;
  const incompatibilities = measureDifferences(current, candidate);
  if (current.laterality !== candidate.laterality && (current.laterality === 'unilateral' || candidate.laterality === 'unilateral'))
    incompatibilities.push(candidate.laterality === 'unilateral' ? 'O novo exercício é unilateral: o lado é registrado em cada série.' : 'O novo exercício é bilateral.');
  const policy =
    mode === 'split'
      ? [
          `As ${done.length} série(s) já feitas de ${current.name} ficam registradas nele, sem mudança.`,
          `${current.name} é encerrado aqui; ${candidate.name} entra logo depois com ${nextSets} série(s).`,
          'As cargas já registradas não passam para o novo exercício.',
        ]
      : [
          `${current.name} ainda não tem série feita: ${candidate.name} ocupa o lugar dele neste treino.`,
          compatible ? 'Séries, faixa de repetições e descanso planejados são mantidos.' : 'O registro é diferente: o plano do novo exercício é usado.',
          'Cargas sugeridas só vêm do seu histórico do novo exercício.',
        ];
  policy.push('A ficha não muda e metas ligadas ao exercício anterior não são redirecionadas.');
  return {
    mode,
    current,
    next: candidate,
    plannedWork: work.length,
    doneWork,
    doneWarmup,
    doneLoads: done.filter(isWork).map((s) => s.weight),
    pendingWork,
    nextSets,
    restOnThis: session.rest?.exerciseId === current.id,
    incompatibilities,
    policy,
  };
}

/** Ajusta as séries pendentes do novo exercício para `n` séries de trabalho (copia a primeira como modelo). */
function withWorkSets(e: SessionExercise, n: number, newId: () => string): SessionExercise {
  const warm = e.sets.filter((s) => s.type === 'warmup');
  const work = e.sets.filter(isWork);
  const model = work[0] ?? e.sets[0];
  const out: SessionSet[] = [];
  for (let i = 0; i < n; i++) {
    if (work[i]) out.push(work[i]);
    else {
      const { completedAt: _c, ...copy } = model ?? { id: '', type: 'normal' as const, status: 'pending' as const, weight: null, reps: null };
      out.push({ ...copy, id: newId(), status: 'pending' });
    }
  }
  return { ...e, plannedSets: n, sets: [...warm, ...out] };
}

/**
 * Aplica a troca confirmada (ver `swapPreview`). `candidate` deve ser um exercício NOVO (ID novo, sem `templateId`),
 * montado a partir da biblioteca. Devolve a sessão e o ID do exercício que passa a receber as séries.
 */
export function applySwap(session: WorkoutSession, exId: string, candidate: SessionExercise, newId: () => string, now = Date.now()): { session: WorkoutSession; nextId: string } | null {
  const p = swapPreview(session, exId, candidate);
  if (!p) return null;
  const { current } = p;
  const compatible = sameMeasures(exerciseMeasures(current), exerciseMeasures(candidate));
  const { templateId: _t, ...base } = candidate;
  let next: SessionExercise = { ...base, substitutedFrom: current.substitutedFrom ?? current.name };
  if (p.mode === 'replace' && compatible) next = { ...next, repMin: current.repMin, repMax: current.repMax, restSec: current.restSec };
  next = withWorkSets(next, p.nextSets, newId);
  if (p.mode === 'split') next.replacesExerciseId = current.id;
  // Aquecimento só se o atual ainda não começou (no `split` o aquecimento já ficou com o anterior).
  if (p.mode === 'split') next = { ...next, sets: next.sets.filter(isWork) };

  const exercises: SessionExercise[] = [];
  for (const e of session.exercises) {
    if (e.id !== current.id) {
      exercises.push(e);
      continue;
    }
    if (p.mode === 'split') {
      exercises.push({ ...e, replacedBy: next.id, sets: e.sets.filter((s) => s.status !== 'pending') });
      exercises.push(next);
    } else exercises.push(next);
  }
  // O descanso em curso continua contando; se apontava para uma série que saiu, passa a apontar para a do novo.
  const rest = session.rest ?? null;
  const firstPending = next.sets.find((s) => s.status === 'pending');
  const out: WorkoutSession = { ...session, exercises, rest, focusExerciseId: session.focusExerciseId === current.id ? next.id : session.focusExerciseId, updatedAt: now };
  if (rest && rest.exerciseId === current.id && !exercises.some((e) => e.id === rest.exerciseId && e.sets.some((s) => s.id === rest.setId)))
    out.rest = firstPending ? { ...rest, exerciseId: next.id, setId: firstPending.id, nextLabel: setLabel(out, { exerciseId: next.id, setId: firstPending.id }) } : null;
  return { session: out, nextId: next.id };
}

/** Acrescenta ao treino (ativo ou em edição) um exercício novo, no fim. */
export function appendExercise(session: WorkoutSession, ex: SessionExercise, now = Date.now(), afterFinish = false): WorkoutSession {
  if (session.exercises.some((e) => e.id === ex.id)) return session;
  const { templateId: _t, ...rest } = ex;
  const added: SessionExercise = afterFinish ? { ...rest, addedAfterFinishAt: now } : rest;
  return { ...session, exercises: [...session.exercises, added], updatedAt: now };
}

// ---------------------------------------------------------------------------------------------------------------
// Edição de treino finalizado
// ---------------------------------------------------------------------------------------------------------------

export class SessionEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionEditError';
  }
}

/**
 * Correção de identidade (cenário A do Prompt 20 §18): o exercício registrado estava errado e a pessoa informa qual fez
 * de fato. Mantém o ID do exercício na sessão e as séries (foram realmente executadas); troca nome, grupo, equipamento,
 * modalidade e origem. Só é permitida quando os dois registram as mesmas medidas: séries nunca são convertidas.
 * O `templateId` sai (a instância da ficha era outra): metas não são redirecionadas. A identidade anterior fica em
 * `correctedFrom` (a primeira, se houver correções seguidas).
 */
export function correctExerciseIdentity(session: WorkoutSession, exId: string, target: SessionExercise, now = Date.now()): WorkoutSession {
  const cur = session.exercises.find((e) => e.id === exId);
  if (!cur) throw new SessionEditError('O exercício não está mais neste treino.');
  const diffs = measureDifferences(cur, target);
  if (diffs.length && cur.sets.some((s) => s.status !== 'pending'))
    throw new SessionEditError(`Não é possível corrigir para ${target.name}: o registro é diferente (${diffs.join(' ')}). Remova o exercício e adicione o correto.`);
  const correctedFrom = cur.correctedFrom ?? {
    name: cur.name,
    exerciseKey: cur.exerciseKey,
    ...(cur.templateId ? { templateId: cur.templateId } : {}),
    ...(cur.catalogId ? { catalogId: cur.catalogId } : {}),
    ...(cur.customExerciseId ? { customExerciseId: cur.customExerciseId } : {}),
    at: now,
  };
  const { templateId: _t, catalogId: _c, catalogVersion: _v, customExerciseId: _x, modality: _m, laterality: _l, loadMode: _lm, secondaryMuscles: _s, distanceUnit: _d, ...keep } = cur;
  const fixed: SessionExercise = {
    ...keep,
    name: target.name,
    exerciseKey: target.exerciseKey,
    muscleGroup: target.muscleGroup,
    category: target.category,
    equipment: target.equipment,
    ...(target.modality ? { modality: target.modality } : {}),
    ...(target.laterality ? { laterality: target.laterality } : {}),
    ...(target.loadMode ? { loadMode: target.loadMode } : {}),
    ...(target.secondaryMuscles ? { secondaryMuscles: [...target.secondaryMuscles] } : {}),
    ...(target.distanceUnit ? { distanceUnit: target.distanceUnit } : {}),
    ...(target.catalogId ? { catalogId: target.catalogId } : {}),
    ...(target.catalogId && target.catalogVersion != null ? { catalogVersion: target.catalogVersion } : {}),
    ...(target.customExerciseId ? { customExerciseId: target.customExerciseId } : {}),
    correctedFrom,
  };
  return { ...session, exercises: session.exercises.map((e) => (e.id === exId ? fixed : e)), updatedAt: now };
}

export function removeExercise(session: WorkoutSession, exId: string, now = Date.now()): WorkoutSession {
  return { ...session, exercises: session.exercises.filter((e) => e.id !== exId), updatedAt: now };
}

/** Move o exercício uma posição (±1). Fora dos limites, nada muda. */
export function moveExercise(session: WorkoutSession, exId: string, delta: -1 | 1, now = Date.now()): WorkoutSession {
  const i = session.exercises.findIndex((e) => e.id === exId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= session.exercises.length) return session;
  const list = [...session.exercises];
  [list[i], list[j]] = [list[j], list[i]];
  return { ...session, exercises: list, updatedAt: now };
}

/** Marca uma série como feita ou não feita (edição do histórico). Não mexe nos valores. */
export function setDone(session: WorkoutSession, exId: string, setId: string, done: boolean, now = Date.now()): WorkoutSession {
  return {
    ...session,
    updatedAt: now,
    exercises: session.exercises.map((e) =>
      e.id !== exId ? e : { ...e, sets: e.sets.map((s) => (s.id !== setId ? s : done ? { ...s, status: 'done', completedAt: s.completedAt ?? now } : { ...s, status: 'pending', completedAt: undefined })) },
    ),
  };
}

export interface EditIssue {
  exerciseId: string | null;
  setId: string | null;
  message: string;
}

/**
 * Valida o treino editado antes de gravar: séries feitas com valores válidos para o registro do exercício (carga,
 * repetições, duração, distância, lado e assistência — as mesmas regras de concluir uma série), IDs únicos e duração.
 */
export function validateSessionEdit(s: WorkoutSession): EditIssue[] {
  const out: EditIssue[] = [];
  const ids = new Set<string>();
  if (!s.exercises.length) out.push({ exerciseId: null, setId: null, message: 'O treino precisa ter pelo menos um exercício. Para apagá-lo, use "Excluir este treino".' });
  for (const e of s.exercises) {
    if (ids.has(e.id)) out.push({ exerciseId: e.id, setId: null, message: `${e.name}: identificador repetido.` });
    ids.add(e.id);
    const setIds = new Set<string>();
    for (const x of e.sets) {
      if (setIds.has(x.id)) out.push({ exerciseId: e.id, setId: x.id, message: `${e.name}: série com identificador repetido.` });
      setIds.add(x.id);
      if (x.status !== 'done') continue;
      for (const m of setCompletionErrors(e, x)) out.push({ exerciseId: e.id, setId: x.id, message: `${e.name}: ${m}` });
    }
  }
  if (typeof s.durationSec === 'number' && (!Number.isFinite(s.durationSec) || s.durationSec < 0 || s.durationSec > MAX_SESSION_DURATION_SEC))
    out.push({ exerciseId: null, setId: null, message: 'Duração do treino inválida (0 a 24 horas).' });
  return out;
}

const setSig = (x: SessionSet) => JSON.stringify([x.type, x.status, x.weight ?? null, x.reps ?? null, x.durationSec ?? null, x.distance ?? null, x.side ?? null, x.assistanceKg ?? null, x.rir ?? null, x.rpe ?? null, x.note ?? null]);

/** Resumo legível do que mudou entre duas versões do mesmo treino. */
export function describeSessionChanges(before: WorkoutSession, after: WorkoutSession): string[] {
  const out: string[] = [];
  const b = new Map(before.exercises.map((e) => [e.id, e]));
  const a = new Map(after.exercises.map((e) => [e.id, e]));
  for (const e of after.exercises) if (!b.has(e.id)) out.push(e.replacesExerciseId ? `Substituto adicionado: ${e.name}.` : `Exercício adicionado: ${e.name}.`);
  for (const e of before.exercises) if (!a.has(e.id)) out.push(`Exercício removido: ${e.name}.`);
  for (const e of after.exercises) {
    const old = b.get(e.id);
    if (!old) continue;
    if (old.name !== e.name || old.exerciseKey !== e.exerciseKey) out.push(`Exercício corrigido: ${old.name} → ${e.name}.`);
    const os = new Map(old.sets.map((x) => [x.id, x]));
    const ns = new Map(e.sets.map((x) => [x.id, x]));
    const added = e.sets.filter((x) => !os.has(x.id)).length;
    const removed = old.sets.filter((x) => !ns.has(x.id)).length;
    const changed = e.sets.filter((x) => os.has(x.id) && setSig(os.get(x.id)!) !== setSig(x)).length;
    const parts = [added && `${added} série(s) adicionada(s)`, removed && `${removed} série(s) removida(s)`, changed && `${changed} série(s) alterada(s)`].filter(Boolean);
    if (parts.length) out.push(`${e.name}: ${parts.join(', ')}.`);
  }
  const keptOrder = (list: WorkoutSession['exercises'], other: Map<string, unknown>) => list.filter((e) => other.has(e.id)).map((e) => e.id).join('|');
  if (keptOrder(before.exercises, a) !== keptOrder(after.exercises, b)) out.push('Ordem dos exercícios alterada.');
  if ((before.durationSec ?? null) !== (after.durationSec ?? null)) out.push('Duração corrigida.');
  if ((before.notes ?? '') !== (after.notes ?? '')) out.push('Observações alteradas.');
  return out;
}

export const snapshotOf = (s: WorkoutSession): SessionRevisionSnapshot => ({
  exercises: s.exercises,
  ...(s.durationSec !== undefined ? { durationSec: s.durationSec } : {}),
  ...(s.notes !== undefined ? { notes: s.notes } : {}),
});

/** Acrescenta uma revisão (o `before` é o estado gravado antes da alteração). Mantém só as mais recentes. */
export function withRevision(next: WorkoutSession, before: WorkoutSession, kind: SessionRevisionKind, summary: string[], now: number): WorkoutSession {
  const revision = (before.revision ?? 0) + 1;
  const entry: SessionRevision = { revision, kind, at: now, summary, before: snapshotOf(before) };
  return { ...next, revision, revisions: [...(before.revisions ?? []), entry].slice(-MAX_SESSION_REVISIONS) };
}

/** Problemas estruturais em `revisions` (verificação de integridade de backups). */
export function revisionIssues(r: unknown): string[] {
  if (r === undefined) return [];
  if (!Array.isArray(r)) return ['revisões em formato inválido'];
  if (r.length > MAX_SESSION_REVISIONS) return ['mais revisões do que o limite'];
  const bad = r.some((x) => !x || typeof x !== 'object' || typeof x.revision !== 'number' || typeof x.at !== 'number' || !Array.isArray(x.summary) || !x.before || !Array.isArray(x.before.exercises));
  return bad ? ['revisão em formato inválido'] : [];
}
