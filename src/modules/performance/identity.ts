// Resolvedor de identidade dos painéis de desempenho (IronTrack 2.0 F01/P19). Ver docs/DESEMPENHO_EXERCICIOS.md §1.
//
// Só os painéis de desempenho usam estas identidades. O analytics do P08/P09 continua agrupando por `exerciseKey`
// e as metas continuam pelos IDs da ficha: nada aqui muda esses agrupamentos nem grava qualquer registro.
//
// Níveis (do mais seguro ao agregado):
// - `instancia` (`i:<ExerciseTemplate.id>`): a cópia na sessão guarda o `templateId` da ficha e não foi trocada
//   durante o treino. É a mesma identidade das metas (P12).
// - `historico` (`h:<hash>`): cópia sem `templateId` (sessões antigas) ou trocada durante o treino. Só é agrupada
//   dentro do mesmo treino da mesma rotina, com o mesmo nome normalizado, o mesmo equipamento e a mesma família de
//   medida; sem treino/rotina/nome, fica isolada na própria sessão. Nunca recebe origem da biblioteca.
// - `catalogo` (`c:<catalogId>`) e `personalizado` (`p:<customExerciseId>`): visão agregada, só com cópias que
//   registraram a origem NA SESSÃO (o vínculo feito depois na ficha, P18, não alcança sessões antigas).
import { MODALITIES, type SessionExercise, type TrainingModality, type WorkoutSession } from '@/modules/training';
import type { IdentityKind, MeasureFamily, PerformanceIdentity } from './types';

const KEY_RE = /^(i|h|c|p):([A-Za-z0-9._~-]{1,128})$/;

export const IDENTITY_KIND_BY_PREFIX: Record<string, IdentityKind> = { i: 'instancia', h: 'historico', c: 'catalogo', p: 'personalizado' };
const PREFIX: Record<IdentityKind, string> = { instancia: 'i', historico: 'h', catalogo: 'c', personalizado: 'p' };

export const IDENTITY_KIND_LABEL: Record<IdentityKind, string> = {
  instancia: 'Instância da ficha',
  historico: 'Histórico sem vínculo',
  catalogo: 'Visão agregada (catálogo)',
  personalizado: 'Visão agregada (meu exercício)',
};

/** Texto obrigatório das visões agregadas. */
export const AGGREGATE_NOTICE = 'Visão agregada de instâncias vinculadas a este exercício.';

/** IDs vindos de registros: só caracteres seguros para a rota (o resto não vira identidade). */
const safeId = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9._~-]{1,128}$/.test(v) ? v : null);

/**
 * Família de medida da cópia na sessão. Com modalidade gravada, vale a modalidade; sem ela, equipamento "peso
 * corporal" é lido como peso corporal (como no analytics, P09) e o resto como musculação (carga × repetições).
 */
export function measureFamilyOf(ex: Pick<SessionExercise, 'modality' | 'equipment'>): MeasureFamily {
  const m = (MODALITIES as readonly unknown[]).includes(ex.modality) ? (ex.modality as TrainingModality) : null;
  if (m === 'timed') return 'tempo';
  if (m === 'cardio') return 'cardio';
  if (m === 'bodyweight') return 'corporal';
  if (m === 'resistance') return 'carga';
  return ex.equipment === 'bodyweight' ? 'corporal' : 'carga';
}

/** FNV-1a de 64 bits (dois acumuladores de 32), em hexadecimal. Determinístico, sem dependências. */
export function stableHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 = (h2 ^ (h2 >>> 15)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function identityKey(kind: IdentityKind, id: string): string {
  return `${PREFIX[kind]}:${id}`;
}

/** Lê uma chave de identidade (ex.: parâmetro da rota). Chaves fora do formato devolvem null. */
export function parseIdentityKey(key: unknown): PerformanceIdentity | null {
  if (typeof key !== 'string') return null;
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return { kind: IDENTITY_KIND_BY_PREFIX[m[1]], id: m[2], key };
}

/** Segmento de rota codificado. A rota nunca contém o nome do exercício. */
export const identityPath = (key: string) => `/desempenho/exercicio/${encodeURIComponent(key)}`;

export interface ResolvedIdentity {
  /** Identidade segura (instância ou histórico sem vínculo). Toda cópia executada tem exatamente uma. */
  primary: PerformanceIdentity;
  /** Visão agregada pela origem registrada na sessão (catálogo ou personalizado), quando existe. */
  aggregate: PerformanceIdentity | null;
  /** Motivo do nível histórico. */
  historicReason: 'sem_ficha' | 'substituido' | 'isolado' | null;
}

const make = (kind: IdentityKind, id: string): PerformanceIdentity => ({ kind, id, key: identityKey(kind, id) });

/**
 * Identidades de uma cópia executada. Não lê a ficha atual: só o que a própria sessão registrou, para que um vínculo
 * ou uma substituição posterior na ficha nunca reclassifique o histórico.
 */
export function resolveIdentity(session: Pick<WorkoutSession, 'id' | 'routineId' | 'workoutId'>, ex: SessionExercise): ResolvedIdentity {
  const substituted = typeof ex.substitutedFrom === 'string' && ex.substitutedFrom.length > 0;
  const templateId = safeId(ex.templateId);
  let primary: PerformanceIdentity;
  let historicReason: ResolvedIdentity['historicReason'] = null;
  if (templateId && !substituted) primary = make('instancia', templateId);
  else {
    const name = typeof ex.exerciseKey === 'string' && ex.exerciseKey ? ex.exerciseKey : '';
    const scoped = typeof session.routineId === 'string' && session.routineId && typeof session.workoutId === 'string' && session.workoutId && name;
    historicReason = scoped ? (substituted ? 'substituido' : 'sem_ficha') : 'isolado';
    const basis = scoped
      ? ['v1', historicReason, session.routineId, session.workoutId, substituted ? (templateId ?? '') : '', name, String(ex.equipment ?? ''), measureFamilyOf(ex)]
      : ['v1', 'isolado', String(session.id), String(ex.id)];
    primary = make('historico', stableHash(basis.join('\u0001')));
  }
  // A troca durante o treino já remove a origem da cópia (P17); a checagem aqui é defensiva.
  const catalogId = !substituted ? safeId(ex.catalogId) : null;
  const customId = !substituted && !catalogId ? safeId(ex.customExerciseId) : null;
  const aggregate = catalogId ? make('catalogo', catalogId) : customId ? make('personalizado', customId) : null;
  return { primary, aggregate, historicReason };
}
