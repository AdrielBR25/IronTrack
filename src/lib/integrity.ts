import type { CollectionName, DataSnapshot } from './types';

// Verificação de integridade dos dados em memória (sem acesso ao banco nem à interface).
// Usada antes de qualquer restauração de backup e para diagnosticar o banco local.
// Política completa em docs/INTEGRIDADE_DADOS.md.
//
// Severidades:
//  - error: impede a importação (aplicar levaria a perda de dados ou a um estado inutilizável);
//  - warning: inconsistência tolerada pelo app; o registro é preservado e o problema, informado;
//  - info: situação legítima registrada para transparência (ex.: referência histórica).
//
// As mensagens citam apenas coleção e ID; nunca nomes, medidas ou observações do usuário.

export type IssueSeverity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'INVALID_ID'
  | 'DUPLICATE_ID'
  | 'DUPLICATE_ID_IDENTICAL'
  | 'MISSING_REQUIRED_FIELD'
  | 'INVALID_NUMBER'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_DATE'
  | 'ROUTINE_DUPLICATE_WORKOUT_ID'
  | 'ROUTINE_DUPLICATE_EXERCISE_ID'
  | 'ROUTINE_INVALID_REP_RANGE'
  | 'ROTATION_ORPHAN'
  | 'ROTATION_INDEX_OUT_OF_RANGE'
  | 'OVERRIDE_ORPHAN'
  | 'OVERRIDE_WORKOUT_MISSING'
  | 'SESSION_HISTORICAL_REFERENCE'
  | 'SESSION_ACTIVE_ORPHAN'
  | 'SESSION_MULTIPLE_ACTIVE'
  | 'PHOTO_ORPHAN'
  | 'PHOTO_INVALID_DATA'
  | 'SETTINGS_ACTIVE_ROUTINE_MISSING';

export interface IntegrityIssue {
  code: IssueCode;
  severity: IssueSeverity;
  collection: CollectionName;
  id?: string;
  message: string;
  action: string;
}

export interface IntegrityReport {
  /** true quando não há nenhum problema de severidade "error". */
  ok: boolean;
  issues: IntegrityIssue[];
  counts: Record<IssueSeverity, number>;
}

/** Chave primária de cada coleção (a mesma do IndexedDB). */
export function recordKey(collection: CollectionName, rec: unknown): string {
  const r = (rec ?? {}) as Record<string, unknown>;
  switch (collection) {
    case 'settings':
      return String(r.id ?? '');
    case 'rotations':
      return String(r.routineId ?? '');
    case 'overrides':
      return `${String(r.routineId ?? '')}|${String(r.date ?? '')}`;
    default:
      return String(r.id ?? '');
  }
}

/** JSON canônico (chaves ordenadas, `undefined` omitido) para comparar conteúdos. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canon(value));
}

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : canon(x)));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = canon(x);
    }
    return out;
  }
  return v;
}

const isNonEmptyId = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidISODate(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const BODY_NUMERIC_FIELDS = [
  'weightKg',
  'bodyFatPct',
  'waistCm',
  'abdomenCm',
  'armCm',
  'thighCm',
  'hipCm',
  'heightM',
  'bmi',
  'fatMassKg',
  'leanMassKg',
  'leanPct',
  'waistHipRatio',
  'bodyDensity',
  'skinfoldSumMm',
  'armMuscleArea',
  'armFatArea',
] as const;

export function checkIntegrity(d: DataSnapshot): IntegrityReport {
  const issues: IntegrityIssue[] = [];
  const add = (severity: IssueSeverity, code: IssueCode, collection: CollectionName, id: string | undefined, message: string, action: string) =>
    issues.push({ severity, code, collection, id, message, action });

  // ---- IDs: vazios e duplicados em cada coleção ----
  const collections: Exclude<CollectionName, 'settings'>[] = ['routines', 'sessions', 'rotations', 'overrides', 'bodyEntries', 'photos'];
  for (const c of collections) {
    const seen = new Map<string, string>();
    const list = (d[c] ?? []) as unknown[];
    list.forEach((rec, i) => {
      const r = (rec ?? {}) as Record<string, unknown>;
      const idFields = c === 'rotations' ? ['routineId'] : c === 'overrides' ? ['routineId', 'date'] : ['id'];
      if (idFields.some((f) => !isNonEmptyId(r[f]))) {
        add('error', 'INVALID_ID', c, undefined, `Registro na posição ${i + 1} de "${c}" sem identificador válido.`, 'Corrija ou remova o registro no arquivo antes de importar.');
        return;
      }
      const key = recordKey(c, r);
      const body = stableStringify(r);
      const prev = seen.get(key);
      if (prev === undefined) seen.set(key, body);
      else if (prev === body)
        add('warning', 'DUPLICATE_ID_IDENTICAL', c, key, `Registro repetido com o mesmo ID e o mesmo conteúdo.`, 'Nenhuma: as cópias idênticas são gravadas uma única vez.');
      else
        add('error', 'DUPLICATE_ID', c, key, `Dois registros diferentes usam o mesmo ID; gravar ambos faria um sobrescrever o outro.`, 'Corrija o arquivo para que cada registro tenha um ID único.');
    });
  }

  // ---- Rotinas ----
  const routines = new Map<string, { workoutIds: Set<string>; count: number }>();
  for (const r of d.routines ?? []) {
    if (!isNonEmptyId(r?.id)) continue;
    if (!Array.isArray(r.workouts)) {
      add('error', 'MISSING_REQUIRED_FIELD', 'routines', r.id, 'Rotina sem a lista de treinos.', 'Corrija o arquivo: "workouts" é obrigatório.');
      continue;
    }
    const wIds = new Set<string>();
    const exIds = new Set<string>();
    for (const w of r.workouts) {
      if (!isNonEmptyId(w?.id)) {
        add('error', 'INVALID_ID', 'routines', r.id, 'Treino da rotina sem identificador válido.', 'Corrija o ID do treino no arquivo.');
        continue;
      }
      if (wIds.has(w.id))
        add('warning', 'ROUTINE_DUPLICATE_WORKOUT_ID', 'routines', r.id, `Dois treinos da rotina usam o mesmo ID (${w.id}).`, 'Edite a rotina e recrie um dos treinos; a rotação pode apontar para o treino errado.');
      wIds.add(w.id);
      for (const e of Array.isArray(w.exercises) ? w.exercises : []) {
        if (!isNonEmptyId(e?.id)) {
          add('error', 'INVALID_ID', 'routines', r.id, 'Exercício da rotina sem identificador válido.', 'Corrija o ID do exercício no arquivo.');
          continue;
        }
        if (exIds.has(e.id))
          add('warning', 'ROUTINE_DUPLICATE_EXERCISE_ID', 'routines', r.id, `Dois exercícios da rotina usam o mesmo ID (${e.id}).`, 'Edite a rotina; a edição de um exercício pode afetar o outro.');
        exIds.add(e.id);
        if (!isFiniteNum(e.sets) || e.sets < 0 || !isFiniteNum(e.repMin) || !isFiniteNum(e.repMax) || e.repMin < 0)
          add('warning', 'INVALID_NUMBER', 'routines', r.id, `Exercício ${e.id} com número de séries ou repetições inválido.`, 'Revise o exercício no editor de treinos.');
        else if (e.repMin > e.repMax)
          add('warning', 'ROUTINE_INVALID_REP_RANGE', 'routines', r.id, `Exercício ${e.id} com faixa de repetições invertida (mínimo > máximo).`, 'Revise a faixa de repetições no editor de treinos.');
        if (e.restSec !== undefined && (!isFiniteNum(e.restSec) || e.restSec < 0))
          add('warning', 'INVALID_NUMBER', 'routines', r.id, `Exercício ${e.id} com descanso inválido.`, 'Revise o descanso no editor de treinos.');
        if (e.targetWeight != null && (!isFiniteNum(e.targetWeight) || e.targetWeight < 0))
          add('warning', 'INVALID_NUMBER', 'routines', r.id, `Exercício ${e.id} com carga planejada inválida.`, 'Revise a carga no editor de treinos.');
      }
    }
    routines.set(r.id, { workoutIds: wIds, count: r.workouts.length });
  }

  // ---- Rotações (referência obrigatória à rotina) ----
  for (const rot of d.rotations ?? []) {
    if (!isNonEmptyId(rot?.routineId)) continue;
    const r = routines.get(rot.routineId);
    if (!r) {
      add('warning', 'ROTATION_ORPHAN', 'rotations', rot.routineId, 'Ponteiro de rotação de uma rotina que não existe.', 'Nenhuma ação obrigatória: o registro é inofensivo e é preservado.');
      continue;
    }
    if (!isFiniteNum(rot.nextIndex) || !Number.isInteger(rot.nextIndex))
      add('error', 'INVALID_NUMBER', 'rotations', rot.routineId, 'Índice da rotação não é um número inteiro.', 'Corrija "nextIndex" no arquivo.');
    else if (r.count > 0 && (rot.nextIndex < 0 || rot.nextIndex >= r.count))
      add('warning', 'ROTATION_INDEX_OUT_OF_RANGE', 'rotations', rot.routineId, `Índice da rotação (${rot.nextIndex}) fora dos ${r.count} treinos da rotina.`, 'O app normaliza o índice ao exibir; ajuste o próximo treino na tela inicial se necessário.');
  }

  // ---- Substituições de calendário ----
  for (const o of d.overrides ?? []) {
    if (!isNonEmptyId(o?.routineId) || !isNonEmptyId(o?.date)) continue;
    const key = `${o.routineId}|${o.date}`;
    if (!isValidISODate(o.date)) add('warning', 'INVALID_DATE', 'overrides', key, 'Data da substituição de calendário inexistente.', 'O registro é preservado, mas não aparece na agenda.');
    const r = routines.get(o.routineId);
    if (!r) {
      add('warning', 'OVERRIDE_ORPHAN', 'overrides', key, 'Substituição de calendário de uma rotina que não existe.', 'Nenhuma ação obrigatória: o registro é ignorado pela agenda e preservado.');
      continue;
    }
    if (o.kind === 'workout' && (!o.workoutId || !r.workoutIds.has(o.workoutId)))
      add('warning', 'OVERRIDE_WORKOUT_MISSING', 'overrides', key, 'Substituição de calendário aponta para um treino que não existe na rotina.', 'A agenda ignora essa substituição; reagende o dia pela tela inicial.');
  }

  // ---- Sessões ----
  const active: string[] = [];
  for (const s of d.sessions ?? []) {
    if (!isNonEmptyId(s?.id)) continue;
    if (!Array.isArray(s.exercises)) {
      add('error', 'MISSING_REQUIRED_FIELD', 'sessions', s.id, 'Treino registrado sem a lista de exercícios.', 'Corrija o arquivo: "exercises" é obrigatório.');
      continue;
    }
    if (!isFiniteNum(s.startedAt) || s.startedAt <= 0)
      add('error', 'INVALID_TIMESTAMP', 'sessions', s.id, 'Treino com horário de início inválido.', 'Corrija "startedAt" no arquivo.');
    if (s.finishedAt !== undefined && s.finishedAt !== null) {
      if (!isFiniteNum(s.finishedAt)) add('warning', 'INVALID_TIMESTAMP', 'sessions', s.id, 'Treino com horário de término inválido.', 'O treino é preservado; a duração pode aparecer incorreta.');
      else if (isFiniteNum(s.startedAt) && s.finishedAt < s.startedAt)
        add('warning', 'INVALID_TIMESTAMP', 'sessions', s.id, 'Treino termina antes de começar.', 'O treino é preservado; a duração pode aparecer incorreta.');
    }
    if (s.durationSec !== undefined && (!isFiniteNum(s.durationSec) || s.durationSec < 0))
      add('warning', 'INVALID_NUMBER', 'sessions', s.id, 'Treino com duração inválida.', 'O treino é preservado; a duração pode aparecer incorreta.');
    let badNumbers = 0;
    for (const ex of s.exercises) {
      for (const set of Array.isArray(ex?.sets) ? ex.sets : []) {
        const w = set?.weight;
        const reps = set?.reps;
        if ((w !== null && w !== undefined && (!isFiniteNum(w) || w < 0)) || (reps !== null && reps !== undefined && (!isFiniteNum(reps) || reps < 0))) badNumbers++;
      }
    }
    if (badNumbers)
      add('warning', 'INVALID_NUMBER', 'sessions', s.id, `${badNumbers} série(s) com carga ou repetições inválidas (negativas ou não numéricas).`, 'O treino é preservado; revise as séries no histórico.');

    const r = routines.get(s.routineId);
    const refOk = !!r && r.workoutIds.has(s.workoutId);
    if (s.status === 'active') {
      active.push(s.id);
      if (!refOk)
        add('warning', 'SESSION_ACTIVE_ORPHAN', 'sessions', s.id, 'Treino em andamento de uma rotina ou treino que não existe mais.', 'O treino pode ser concluído normalmente; a rotação não avança.');
    } else if (!refOk) {
      add('info', 'SESSION_HISTORICAL_REFERENCE', 'sessions', s.id, 'Treino do histórico referente a uma rotina ou treino que não existe mais.', 'Nenhuma: o treino guarda o retrato dos exercícios realizados e é preservado.');
    }
  }
  if (active.length > 1)
    add('warning', 'SESSION_MULTIPLE_ACTIVE', 'sessions', active.join(', '), `${active.length} treinos marcados como "em andamento"; o app retoma apenas um.`, 'Conclua ou descarte os treinos em andamento extras.');

  // ---- Avaliações corporais ----
  const entryIds = new Set<string>();
  for (const e of d.bodyEntries ?? []) {
    if (!isNonEmptyId(e?.id)) continue;
    entryIds.add(e.id);
    if (!isValidISODate(e.date)) add('warning', 'INVALID_DATE', 'bodyEntries', e.id, 'Avaliação com data inválida.', 'A avaliação é preservada, mas pode ficar fora de ordem nos gráficos.');
    const bad = BODY_NUMERIC_FIELDS.filter((f) => {
      const v = (e as unknown as Record<string, unknown>)[f];
      return v !== null && v !== undefined && (!isFiniteNum(v) || v < 0);
    });
    if (bad.length)
      add('warning', 'INVALID_NUMBER', 'bodyEntries', e.id, `Avaliação com ${bad.length} medida(s) inválida(s) (${bad.join(', ')}).`, 'A avaliação é preservada; os gráficos ignoram valores inválidos.');
  }

  // ---- Fotos (referência obrigatória à avaliação) ----
  for (const p of d.photos ?? []) {
    if (!isNonEmptyId(p?.id)) continue;
    if (typeof p.dataUrl !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(p.dataUrl))
      add('error', 'PHOTO_INVALID_DATA', 'photos', p.id, 'Foto sem imagem embutida válida (esperado data:image/...;base64).', 'Remova a foto do arquivo; o IronTrack não carrega imagens externas.');
    if (!isNonEmptyId(p.entryId) || !entryIds.has(p.entryId))
      add('warning', 'PHOTO_ORPHAN', 'photos', p.id, 'Foto associada a uma avaliação que não existe.', 'A foto é preservada (nunca apagada automaticamente), mas não aparece na tela; exporte um backup para guardá-la.');
  }

  // ---- Configurações (referência opcional) ----
  const active_ = d.settings?.activeRoutineId;
  if (active_ && !routines.has(active_))
    add('warning', 'SETTINGS_ACTIVE_ROUTINE_MISSING', 'settings', 'settings', 'A rotina ativa configurada não existe.', 'O app usa a primeira rotina disponível; escolha a rotina ativa em Treinos.');

  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  return { ok: counts.error === 0, issues, counts };
}

// ---------- Impressão digital dos dados ----------

/** Hash síncrono de 64 bits (dois FNV-1a de 32 bits com sementes diferentes), em hexadecimal. */
function hash64(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/**
 * Impressão digital determinística do conteúdo de um retrato dos dados: muda se qualquer
 * campo de qualquer registro mudar, mesmo sem mudar a quantidade de registros.
 * É síncrona para poder rodar dentro de uma transação do IndexedDB (que não aceita
 * aguardar promessas externas, como crypto.subtle).
 */
export function snapshotFingerprint(d: DataSnapshot): string {
  const parts: string[] = [`settings=${d.settings ? hash64(stableStringify(d.settings)) : '-'}`];
  for (const c of ['routines', 'sessions', 'rotations', 'overrides', 'bodyEntries', 'photos'] as const) {
    const list = (d[c] ?? []) as unknown[];
    const entries = list
      .map((r) => {
        const body = stableStringify(r);
        return `${recordKey(c, r)}:${body.length}:${hash64(body)}`;
      })
      .sort();
    parts.push(`${c}=${list.length}:${hash64(entries.join('\n'))}`);
  }
  return parts.join(';');
}
