import { OWNED_COLLECTIONS, type CollectionName, type DataSnapshot } from './types';
import { isValidProfileId } from './profile';
import { exerciseModelIssues, setModelIssues, type ModelIssue } from '@/modules/training';
import { goalIssues } from '@/modules/goals';
import { planEntryIssues } from '@/modules/planner';

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
  | 'SETTINGS_ACTIVE_ROUTINE_MISSING'
  | 'PROFILE_INVALID_ID'
  | 'PROFILE_DEFAULT_MISSING'
  | 'PROFILE_DEFAULT_DUPLICATE'
  | 'RECORD_UNOWNED'
  | 'RECORD_PROFILE_UNKNOWN'
  | 'CROSS_PROFILE_REFERENCE'
  // P10: campos de modalidade (docs/MIGRACAO_EXERCICIOS_V3.md §2).
  | 'INVALID_MODALITY_FIELD'
  | 'MODALITY_CONTRADICTION'
  // P12: metas de treinamento (docs/METAS_TREINAMENTO.md §5).
  | 'INVALID_GOAL'
  | 'GOAL_EXERCISE_UNAVAILABLE'
  // P13: planejamento semanal (docs/PLANEJAMENTO_SEMANAL.md §8).
  | 'INVALID_PLAN_ENTRY'
  | 'PLAN_ROUTINE_MISSING'
  | 'PLAN_WORKOUT_MISSING'
  | 'PLAN_DAY_CONFLICT';

/** Coleções citadas nos problemas: as do retrato e a tabela de perfis. */
export type IssueCollection = CollectionName | 'profiles';

/**
 * Contexto de propriedade para a verificação (ver docs/PERFIL_LOCAL.md):
 *  - local: banco deste aparelho; `profiles` = tabela de perfis;
 *  - backup: arquivo v2; `profiles` = [perfil do arquivo]; todo registro precisa de dono;
 *  - legacy: backup v0/v1, sem perfil; nenhum registro pode declarar dono.
 * Sem contexto, as regras de perfil não são aplicadas (compatível com o Prompt 01).
 */
export interface OwnershipContext {
  scope: 'local' | 'backup' | 'legacy';
  profiles: { id: string; isDefault?: boolean }[];
}

export interface IntegrityIssue {
  code: IssueCode;
  severity: IssueSeverity;
  collection: IssueCollection;
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

export function checkIntegrity(d: DataSnapshot, ownership?: OwnershipContext): IntegrityReport {
  const issues: IntegrityIssue[] = [];
  const add = (severity: IssueSeverity, code: IssueCode, collection: IssueCollection, id: string | undefined, message: string, action: string) =>
    issues.push({ severity, code, collection, id, message, action });

  // ---- IDs: vazios e duplicados em cada coleção ----
  const collections: Exclude<CollectionName, 'settings'>[] = ['routines', 'sessions', 'rotations', 'overrides', 'bodyEntries', 'photos', 'goals', 'planEntries'];
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
  const templateIds = new Set<string>();
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
        templateIds.add(e.id);
        if (!isFiniteNum(e.sets) || e.sets < 0 || !isFiniteNum(e.repMin) || !isFiniteNum(e.repMax) || e.repMin < 0)
          add('warning', 'INVALID_NUMBER', 'routines', r.id, `Exercício ${e.id} com número de séries ou repetições inválido.`, 'Revise o exercício no editor de treinos.');
        else if (e.repMin > e.repMax)
          add('warning', 'ROUTINE_INVALID_REP_RANGE', 'routines', r.id, `Exercício ${e.id} com faixa de repetições invertida (mínimo > máximo).`, 'Revise a faixa de repetições no editor de treinos.');
        if (e.restSec !== undefined && (!isFiniteNum(e.restSec) || e.restSec < 0))
          add('warning', 'INVALID_NUMBER', 'routines', r.id, `Exercício ${e.id} com descanso inválido.`, 'Revise o descanso no editor de treinos.');
        if (e.targetWeight != null && (!isFiniteNum(e.targetWeight) || e.targetWeight < 0))
          add('warning', 'INVALID_NUMBER', 'routines', r.id, `Exercício ${e.id} com carga planejada inválida.`, 'Revise a carga no editor de treinos.');
        reportModel(add, 'routines', r.id, `Exercício ${e.id}`, exerciseModelIssues(e));
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
    const model: ModelIssue[] = [];
    for (const ex of s.exercises) {
      const exIssues = ex ? exerciseModelIssues(ex) : [];
      model.push(...exIssues);
      // Com metadados inválidos, as séries não são comparadas com eles (evita avisos derivados de um erro).
      const ctx = exIssues.some((i) => i.severity === 'error') ? {} : (ex ?? {});
      for (const set of Array.isArray(ex?.sets) ? ex.sets : []) {
        if (set) model.push(...setModelIssues(set, ctx));
        const w = set?.weight;
        const reps = set?.reps;
        if ((w !== null && w !== undefined && (!isFiniteNum(w) || w < 0)) || (reps !== null && reps !== undefined && (!isFiniteNum(reps) || reps < 0))) badNumbers++;
      }
    }
    if (badNumbers)
      add('warning', 'INVALID_NUMBER', 'sessions', s.id, `${badNumbers} série(s) com carga ou repetições inválidas (negativas ou não numéricas).`, 'O treino é preservado; revise as séries no histórico.');
    reportModel(add, 'sessions', s.id, 'Treino', model);

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

  // ---- Metas (P12): valores, unidades e datas válidos; exercício referenciado por ID da ficha ----
  for (const g of d.goals ?? []) {
    if (!isNonEmptyId(g?.id)) continue;
    const problems = goalIssues(g);
    if (problems.length) {
      const examples = [...new Set(problems.map((i) => i.message.replace(/\.$/, '')))].slice(0, 3).join('; ');
      add('error', 'INVALID_GOAL', 'goals', g.id, `Meta com ${problems.length} campo(s) inválido(s): ${examples}.`, 'Corrija o arquivo: metas inválidas não são importadas nem descartadas automaticamente.');
      continue;
    }
    if (g.exercise && !g.exercise.templateIds.some((id) => templateIds.has(id)))
      add('info', 'GOAL_EXERCISE_UNAVAILABLE', 'goals', g.id, 'Meta de um exercício que não está mais em nenhuma ficha.', 'Nenhuma: a meta é preservada e continua usando o histórico registrado.');
  }

  // ---- Planejamento semanal (P13): campos válidos; rotina/treino ausentes são preservados com aviso ----
  const validPlan: NonNullable<DataSnapshot['planEntries']> = [];
  for (const e of d.planEntries ?? []) {
    if (!isNonEmptyId(e?.id)) continue;
    const problems = planEntryIssues(e);
    if (problems.length) {
      const examples = [...new Set(problems.map((i) => i.message.replace(/\.$/, '')))].slice(0, 3).join('; ');
      add('error', 'INVALID_PLAN_ENTRY', 'planEntries', e.id, `Entrada de planejamento com ${problems.length} campo(s) inválido(s): ${examples}.`, 'Corrija o arquivo: entradas inválidas não são importadas nem descartadas automaticamente.');
      continue;
    }
    validPlan.push(e);
    if (e.kind !== 'workout' || !e.routineId) continue;
    const r = routines.get(e.routineId);
    if (!r) add('warning', 'PLAN_ROUTINE_MISSING', 'planEntries', e.id, 'Planejamento de uma rotina que não existe.', 'A entrada é preservada e aparece no painel como "rotina excluída"; remova ou troque a rotina no Planejamento.');
    else if (e.workoutId && !r.workoutIds.has(e.workoutId))
      add('warning', 'PLAN_WORKOUT_MISSING', 'planEntries', e.id, 'Planejamento aponta para um treino que não existe na rotina.', 'A entrada é preservada e aparece no painel como "treino removido"; escolha outro treino no Planejamento.');
  }
  // Descanso/dia livre junto com atividades no mesmo dia (ex.: após mesclar backups): as atividades valem.
  const conflictDays = new Set<string>();
  for (const e of validPlan) {
    const key = e.scope === 'date' ? `data ${e.date}` : `dia ${e.weekday}`;
    if (conflictDays.has(key)) continue;
    const same = validPlan.filter((x) => (e.scope === 'date' ? x.scope === 'date' && x.date === e.date : x.scope === 'weekly' && x.weekday === e.weekday && x.enabled && x.validUntil === null));
    if (same.some((x) => x.kind === 'workout') && same.some((x) => x.kind !== 'workout')) {
      conflictDays.add(key);
      add('warning', 'PLAN_DAY_CONFLICT', 'planEntries', e.id, `Descanso ou dia livre planejado junto com treinos (${key}).`, 'Nada é apagado: o painel mostra os treinos e avisa; ajuste o dia no Planejamento.');
    }
  }

  // ---- Configurações (referência opcional) ----
  const active_ = d.settings?.activeRoutineId;
  if (active_ && !routines.has(active_))
    add('warning', 'SETTINGS_ACTIVE_ROUTINE_MISSING', 'settings', 'settings', 'A rotina ativa configurada não existe.', 'O app usa a primeira rotina disponível; escolha a rotina ativa em Treinos.');

  if (ownership) checkOwnership(d, ownership, add);

  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  return { ok: counts.error === 0, issues, counts };
}

type AddIssue = (severity: IssueSeverity, code: IssueCode, collection: IssueCollection, id: string | undefined, message: string, action: string) => void;

/**
 * Campos de modalidade (P10): valor fora do tipo ou dos limites é erro (a restauração é recusada inteira, nada é
 * descartado em silêncio); combinação contraditória é aviso (o registro é preservado como está e as análises a
 * tratam como incompatível). Um problema por registro e severidade, com até 3 exemplos.
 */
function reportModel(add: AddIssue, collection: 'routines' | 'sessions', id: string, what: string, issues: ModelIssue[]) {
  for (const severity of ['error', 'warning'] as const) {
    const list = issues.filter((i) => i.severity === severity);
    if (!list.length) continue;
    const examples = [...new Set(list.map((i) => i.message))].slice(0, 3).join('; ');
    if (severity === 'error')
      add('error', 'INVALID_MODALITY_FIELD', collection, id, `${what}: ${list.length} campo(s) de modalidade inválido(s): ${examples}.`, 'Corrija o arquivo: valores fora do formato não são importados nem descartados automaticamente.');
    else
      add('warning', 'MODALITY_CONTRADICTION', collection, id, `${what}: ${list.length} combinação(ões) contraditória(s): ${examples}.`, 'Os dados são preservados como estão; as análises ignoram a parte contraditória. Revise no editor ou no histórico.');
  }
}

/** Regras de propriedade dos registros (perfil local). */
function checkOwnership(d: DataSnapshot, ctx: OwnershipContext, add: AddIssue) {
  const known = new Set<string>();
  for (const p of ctx.profiles) {
    if (!isValidProfileId(p?.id)) add('error', 'PROFILE_INVALID_ID', 'profiles', undefined, 'Perfil com identificador inválido (esperado UUID v4).', ctx.scope === 'local' ? 'Exporte um backup; o perfil não é alterado automaticamente.' : 'O arquivo foi alterado manualmente; use um backup original.');
    else known.add(p.id);
  }
  if (ctx.scope === 'local') {
    const defaults = ctx.profiles.filter((p) => p.isDefault === true && isValidProfileId(p.id));
    if (!defaults.length) add('error', 'PROFILE_DEFAULT_MISSING', 'profiles', undefined, 'Nenhum perfil principal encontrado.', 'Recarregue o app: o perfil principal é recriado ou restabelecido ao abrir, sem apagar dados.');
    if (defaults.length > 1)
      add('warning', 'PROFILE_DEFAULT_DUPLICATE', 'profiles', defaults.map((p) => p.id).join(', '), `${defaults.length} perfis marcados como principal; o app usa o mais antigo.`, 'Nenhum perfil é apagado automaticamente; exporte um backup antes de qualquer correção.');
  }

  const owners = new Map<string, Map<string, string | undefined>>();
  for (const c of OWNED_COLLECTIONS) {
    const map = new Map<string, string | undefined>();
    owners.set(c, map);
    for (const r of (d[c] ?? []) as { id?: unknown; profileId?: unknown }[]) {
      if (!isNonEmptyId(r?.id)) continue;
      const id = r.id as string;
      const pid = r.profileId;
      const missing = pid === undefined || pid === null || pid === '';
      map.set(id, missing ? undefined : String(pid));
      if (ctx.scope === 'legacy') {
        if (!missing) add('error', 'RECORD_PROFILE_UNKNOWN', c, id, 'Backup sem perfil contém registro com perfil proprietário declarado.', 'O arquivo foi alterado manualmente; use um backup original.');
        continue;
      }
      if (missing) {
        if (ctx.scope === 'local') add('warning', 'RECORD_UNOWNED', c, id, 'Registro ainda sem perfil proprietário (dado legado não migrado).', 'Recarregue o app: registros sem dono são atribuídos ao perfil principal ao abrir.');
        else add('error', 'RECORD_UNOWNED', c, id, 'Registro sem perfil proprietário num backup que identifica o perfil.', 'O arquivo foi alterado manualmente; use um backup original.');
      } else if (!isValidProfileId(pid)) add('error', 'PROFILE_INVALID_ID', c, id, 'Registro com identificador de perfil inválido.', 'O registro é preservado; não é atribuído a nenhum perfil automaticamente.');
      else if (!known.has(pid)) add('error', 'RECORD_PROFILE_UNKNOWN', c, id, 'Registro pertence a um perfil que não existe.', 'O registro é preservado e não é associado a outro perfil automaticamente.');
    }
  }

  // Referências diretas entre registros devem ficar dentro do mesmo perfil.
  // Rotações e agenda não têm dono próprio: herdam o da rotina (sem verificação cruzada possível).
  const routines = owners.get('routines')!;
  const entries = owners.get('bodyEntries')!;
  for (const s of d.sessions ?? []) {
    const a = owners.get('sessions')!.get(s?.id);
    const b = routines.get(s?.routineId);
    // Rotina excluída: referência histórica legítima, o treino mantém o próprio dono.
    if (a && b && a !== b) add('error', 'CROSS_PROFILE_REFERENCE', 'sessions', s.id, 'Treino aponta para uma rotina de outro perfil.', 'Nenhum dado é reatribuído automaticamente; restaure um backup consistente.');
  }
  for (const p of d.photos ?? []) {
    const a = owners.get('photos')!.get(p?.id);
    const b = entries.get(p?.entryId);
    if (a && b && a !== b) add('error', 'CROSS_PROFILE_REFERENCE', 'photos', p.id, 'Foto ligada a uma avaliação de outro perfil.', 'Nenhum dado é reatribuído automaticamente; restaure um backup consistente.');
  }
  for (const g of d.goals ?? []) {
    const a = owners.get('goals')!.get(g?.id);
    const b = g?.exercise ? routines.get(g.exercise.routineId) : undefined;
    if (a && b && a !== b) add('error', 'CROSS_PROFILE_REFERENCE', 'goals', g.id, 'Meta ligada a uma rotina de outro perfil.', 'Nenhum dado é reatribuído automaticamente; restaure um backup consistente.');
  }
  for (const e of d.planEntries ?? []) {
    const a = owners.get('planEntries')!.get(e?.id);
    const b = e?.routineId ? routines.get(e.routineId) : undefined;
    if (a && b && a !== b) add('error', 'CROSS_PROFILE_REFERENCE', 'planEntries', e.id, 'Planejamento ligado a uma rotina de outro perfil.', 'Nenhum dado é reatribuído automaticamente; restaure um backup consistente.');
  }
  const activeOwner = d.settings?.activeRoutineId ? routines.get(d.settings.activeRoutineId) : undefined;
  const def = ctx.scope === 'local' ? ctx.profiles.find((p) => p.isDefault === true)?.id : ctx.profiles[0]?.id;
  if (activeOwner && def && activeOwner !== def)
    add('warning', 'CROSS_PROFILE_REFERENCE', 'settings', 'settings', 'A rotina ativa pertence a outro perfil.', 'Escolha a rotina ativa em Treinos.');
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
export function snapshotFingerprint(d: DataSnapshot, profiles?: unknown[]): string {
  const parts: string[] = [`settings=${d.settings ? hash64(stableStringify(d.settings)) : '-'}`];
  // Identidade local: qualquer mudança nos perfis (criação, nome, principal) também invalida a prévia.
  if (profiles) parts.push(`profiles=${profiles.length}:${hash64(profiles.map((p) => stableStringify(p)).sort().join('\n'))}`);
  for (const c of ['routines', 'sessions', 'rotations', 'overrides', 'bodyEntries', 'photos', 'goals', 'planEntries'] as const) {
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
