import { z } from 'zod';
import { OWNED_COLLECTIONS, type CollectionName, type DataSnapshot, type LocalProfile } from './types';
import { formatZodError, parseJsonText, type ParseResult } from './validation';
import { checkIntegrity, type IntegrityIssue, type IntegrityReport, type OwnershipContext } from './integrity';
import type { CollectionCounts, MergeItem } from './merge';

// Contrato do arquivo de backup (JSON versionado): tipos, validação, migrações v0 → v1 → v2,
// limites, identidade do perfil e mensagens. Funções puras, sem acesso ao banco: a leitura e a
// gravação no IndexedDB ficam em ./backup.ts, que reexporta tudo daqui (mesmos imports de antes).
// Formato documentado em docs/BACKUP_RESTAURACAO.md; não altere sem uma nova versão do esquema.

export const BACKUP_APP = 'irontrack';
// Versão do formato JSON do backup. Independente da versão do esquema IndexedDB (DB_SCHEMA_VERSION).
// v0: tabelas na raiz · v1: { data } · v2: + perfil proprietário (`profile`) e `profileId` nos registros ·
// v3 (P10): + campos opcionais de modalidade em exercícios e séries (modality, laterality, loadMode,
// secondaryMuscles, distanceUnit, durationSec, distance, side, assistanceKg). Estrutura igual à v2 ·
// v4 (P12): + coleção `goals` (metas de treinamento, com `profileId`). Backups v0–v3 viram v4 com `goals: []` ·
// v5 (P13): + coleção `planEntries` (planejamento semanal, com `profileId`). Backups v0–v4 viram v5 com `planEntries: []` ·
// v6 (P16): + coleção `calendarDecisions` (decisões lembradas do calendário, com `profileId`). Backups v0–v5 viram v6
// com `calendarDecisions: []` ·
// v7 (P17): + coleções `customExercises` (exercícios personalizados) e `exerciseFavorites` (favoritos da biblioteca),
// ambas com `profileId`; + origem opcional na biblioteca nos exercícios das fichas e sessões (`catalogId`,
// `catalogVersion`, `customExerciseId`). Backups v0–v6 viram v7 com as duas coleções vazias; nada mais muda ·
// v8 (P20): + campos opcionais nas sessões para edição e retomada de treinos finalizados (`timing`, `revision`,
// `revisions`) e nos exercícios da sessão (`catalogVersion`, `replacedBy`, `replacesExerciseId`, `addedAfterFinishAt`,
// `correctedFrom`). Estrutura igual à v7; nada é preenchido na migração (ausente = treino nunca editado/retomado).
export const BACKUP_SCHEMA_VERSION = 8;

export type BackupData = DataSnapshot;

/** Identidade do perfil gravada no backup v2 (o nome é só informativo). */
export interface BackupProfile {
  id: string;
  displayName: string;
  createdAt?: number;
}

export interface BackupFile {
  app: typeof BACKUP_APP;
  kind: 'backup';
  schemaVersion: number;
  exportedAt: string;
  /** Perfil dono dos dados; null em backups legados (v0/v1), que não tinham perfil. */
  profile: BackupProfile | null;
  data: BackupData;
}

// Validação estrutural: campos essenciais conferidos, demais preservados.
const setSchema = z
  .object({
    id: z.string(),
    type: z.enum(['warmup', 'normal', 'drop']),
    status: z.enum(['pending', 'done', 'skipped']),
    weight: z.number().nullable(),
    reps: z.number().nullable(),
  })
  .passthrough();

const sessionSchema = z
  .object({
    id: z.string(),
    routineId: z.string(),
    workoutId: z.string(),
    workoutName: z.string(),
    status: z.enum(['active', 'completed', 'discarded']),
    startedAt: z.number(),
    exercises: z.array(
      z.object({ id: z.string(), exerciseKey: z.string(), name: z.string(), sets: z.array(setSchema) }).passthrough(),
    ),
  })
  .passthrough();

const routineSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    workouts: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          name: z.string(),
          exercises: z.array(z.object({ id: z.string(), name: z.string(), sets: z.number(), repMin: z.number(), repMax: z.number() }).passthrough()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const backupSchema = z.object({
  app: z.literal(BACKUP_APP, { errorMap: () => ({ message: 'este arquivo não é um backup do IronTrack' }) }),
  kind: z.literal('backup', { errorMap: () => ({ message: 'este arquivo não é um backup completo (talvez seja uma ficha de treino?)' }) }),
  schemaVersion: z.number().int(),
  exportedAt: z.string(),
  profile: z.object({ id: z.string(), displayName: z.string() }).passthrough().nullable(),
  data: z.object({
    settings: z.object({ id: z.literal('settings') }).passthrough().nullable(),
    routines: z.array(routineSchema),
    sessions: z.array(sessionSchema),
    rotations: z.array(z.object({ routineId: z.string(), nextIndex: z.number().int() }).passthrough()),
    overrides: z.array(z.object({ routineId: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), kind: z.enum(['rest', 'workout']) }).passthrough()),
    bodyEntries: z.array(z.object({ id: z.string(), date: z.string() }).passthrough()),
    photos: z.array(z.object({ id: z.string(), entryId: z.string(), dataUrl: z.string() }).passthrough()),
    // P12: estrutura mínima aqui; a validação completa (tipo, unidade, valores, datas, exercício) é da verificação
    // de integridade, que recusa o arquivo inteiro se uma meta for inválida (nada é descartado em silêncio).
    goals: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()),
    // P13: idem para o planejamento (validação completa em checkIntegrity › INVALID_PLAN_ENTRY).
    planEntries: z.array(z.object({ id: z.string(), scope: z.string(), kind: z.string() }).passthrough()),
    // P16: idem para as decisões lembradas (validação completa em checkIntegrity › INVALID_CALENDAR_DECISION).
    calendarDecisions: z.array(z.object({ id: z.string(), conflictId: z.string() }).passthrough()),
    // P17: idem para a biblioteca (validação completa em checkIntegrity › INVALID_CUSTOM_EXERCISE / INVALID_FAVORITE).
    customExercises: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
    exerciseFavorites: z.array(z.object({ id: z.string(), target: z.string() }).passthrough()),
  }),
});

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migrações de backup: chave = versão de origem. Cada uma leva à versão seguinte.
 * v0 era o formato preliminar com as tabelas na raiz do arquivo.
 */
const MIGRATIONS: Record<number, Migration> = {
  0: (raw) => ({
    app: BACKUP_APP,
    kind: 'backup',
    schemaVersion: 1,
    exportedAt: (raw.exportedAt as string) ?? new Date().toISOString(),
    data: {
      settings: raw.settings ?? null,
      routines: raw.routines ?? [],
      sessions: raw.sessions ?? [],
      rotations: raw.rotations ?? [],
      overrides: raw.overrides ?? [],
      bodyEntries: raw.bodyEntries ?? [],
      photos: raw.photos ?? [],
    },
  }),
  // v1 não identificava o perfil: o arquivo vira "legado sem dono" (profile: null). A atribuição
  // ao perfil local acontece só na restauração, de forma explícita (ver docs/PERFIL_LOCAL.md).
  1: (raw) => ({ ...raw, schemaVersion: 2, profile: null }),
  // v2 → v3: nenhum registro muda. Os campos novos são opcionais e ausentes em v2 (= não informados); nada é
  // preenchido. A versão nova existe para que um app anterior recuse um arquivo com dados de modalidade em vez
  // de importá-lo sem entendê-los. Os campos são validados pela verificação de integridade.
  2: (raw) => ({ ...raw, schemaVersion: 3 }),
  // v3 → v4: metas não existiam; a coleção entra vazia. Nenhum outro registro muda. A versão nova faz um app anterior
  // recusar o arquivo (com orientação para atualizar) em vez de restaurá-lo e perder as metas sem avisar.
  3: (raw) => {
    const data = (raw.data ?? {}) as Record<string, unknown>;
    return { ...raw, schemaVersion: 4, data: { ...data, goals: data.goals ?? [] } };
  },
  // v4 → v5: o planejamento semanal não existia; a coleção entra vazia e nada mais muda. Um app anterior recusa v5
  // (com orientação para atualizar) em vez de restaurar e perder o planejamento sem avisar.
  4: (raw) => {
    const data = (raw.data ?? {}) as Record<string, unknown>;
    return { ...raw, schemaVersion: 5, data: { ...data, planEntries: data.planEntries ?? [] } };
  },
  // v5 → v6: decisões lembradas do calendário não existiam; a coleção entra vazia e nada mais muda. Um app anterior
  // recusa v6 (com orientação para atualizar) em vez de restaurar e perder as decisões sem avisar.
  5: (raw) => {
    const data = (raw.data ?? {}) as Record<string, unknown>;
    return { ...raw, schemaVersion: 6, data: { ...data, calendarDecisions: data.calendarDecisions ?? [] } };
  },
  // v6 → v7: a biblioteca não existia; as duas coleções entram vazias. Fichas e sessões antigas não têm origem na
  // biblioteca e continuam válidas assim: nada é associado por nome. Um app anterior recusa v7 (com orientação para
  // atualizar) em vez de restaurar e perder exercícios personalizados e favoritos sem avisar.
  6: (raw) => {
    const data = (raw.data ?? {}) as Record<string, unknown>;
    return { ...raw, schemaVersion: 7, data: { ...data, customExercises: data.customExercises ?? [], exerciseFavorites: data.exerciseFavorites ?? [] } };
  },
  // v7 → v8: nenhum registro muda. Os campos de edição/retomada são opcionais e ausentes em v7. A versão nova faz um app
  // anterior recusar o arquivo (com orientação para atualizar) em vez de restaurar um treino retomado sem entender o tempo
  // com pausas nem as revisões.
  7: (raw) => ({ ...raw, schemaVersion: 8 }),
};

export function migrateBackup(raw: unknown): ParseResult<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['O arquivo não contém um objeto JSON de backup.'] };
  let obj = raw as Record<string, unknown>;
  if (obj.app !== BACKUP_APP) {
    if ((obj as { formato?: string }).formato === 'irontrack.ficha')
      return { ok: false, errors: ['Este arquivo é uma ficha de treino. Importe-o em Treinos › Importar ficha.'] };
    return { ok: false, errors: ['Este arquivo não é um backup do IronTrack.'] };
  }
  let v = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 0;
  if (v > BACKUP_SCHEMA_VERSION)
    return { ok: false, errors: [`Backup criado por uma versão mais nova do app (esquema ${v}). Atualize o IronTrack antes de importar.`] };
  while (v < BACKUP_SCHEMA_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) return { ok: false, errors: [`Não há migração disponível da versão ${v}.`] };
    obj = m(obj);
    v = obj.schemaVersion as number;
  }
  return { ok: true, value: obj };
}

// ---------- Limites de tamanho e complexidade ----------
// Fotos são data URLs (JPEG ~1080 px, normalmente 100–400 KB cada); os limites
// cabem com folga em vários anos de uso e evitam travar o navegador com arquivos absurdos.

export const BACKUP_LIMITS = {
  maxBytes: 100 * 1024 * 1024,
  maxRecords: { routines: 1_000, sessions: 50_000, rotations: 1_000, overrides: 20_000, bodyEntries: 10_000, photos: 2_000, goals: 2_000, planEntries: 5_000, calendarDecisions: 1_000, customExercises: 2_000, exerciseFavorites: 5_000 } as Record<Exclude<CollectionName, 'settings'>, number>,
  maxPhotoChars: 15 * 1024 * 1024,
  maxWorkoutsPerRoutine: 100,
  maxExercisesPerItem: 300,
  maxSetsPerExercise: 200,
};

const fmtMB = (n: number) => `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/** Confere o tamanho do arquivo antes de lê-lo. */
export function checkBackupSize(bytes: number): string | null {
  if (bytes > BACKUP_LIMITS.maxBytes) return `Arquivo muito grande (${fmtMB(bytes)}). O limite para restaurar é ${fmtMB(BACKUP_LIMITS.maxBytes)}.`;
  return null;
}

function checkComplexity(d: BackupData): string[] {
  const errors: string[] = [];
  const L = BACKUP_LIMITS;
  for (const [c, max] of Object.entries(L.maxRecords) as [Exclude<CollectionName, 'settings'>, number][])
    if (d[c].length > max) errors.push(`"${c}" tem ${d[c].length} registros; o limite é ${max}.`);
  d.photos.forEach((p, i) => {
    if (p.dataUrl.length > L.maxPhotoChars) errors.push(`Foto ${i + 1} (${p.id}) tem ${fmtMB(p.dataUrl.length)}; o limite por foto é ${fmtMB(L.maxPhotoChars)}.`);
  });
  for (const r of d.routines) {
    if (r.workouts.length > L.maxWorkoutsPerRoutine) errors.push(`Rotina ${r.id} tem ${r.workouts.length} treinos; o limite é ${L.maxWorkoutsPerRoutine}.`);
    for (const w of r.workouts) if (w.exercises.length > L.maxExercisesPerItem) errors.push(`Rotina ${r.id} tem um treino com ${w.exercises.length} exercícios; o limite é ${L.maxExercisesPerItem}.`);
  }
  for (const s of d.sessions) {
    if (s.exercises.length > L.maxExercisesPerItem) errors.push(`Treino ${s.id} tem ${s.exercises.length} exercícios; o limite é ${L.maxExercisesPerItem}.`);
    for (const e of s.exercises) if (e.sets.length > L.maxSetsPerExercise) errors.push(`Treino ${s.id} tem um exercício com ${e.sets.length} séries; o limite é ${L.maxSetsPerExercise}.`);
  }
  return errors.slice(0, 12);
}

export function parseBackup(text: string): ParseResult<BackupFile> {
  const sizeError = checkBackupSize(text.length);
  if (sizeError) return { ok: false, errors: [sizeError] };
  const raw = parseJsonText(text);
  if (!raw.ok) return raw;
  const mig = migrateBackup(raw.value);
  if (!mig.ok) return mig;
  const res = backupSchema.safeParse(mig.value);
  if (!res.success) return { ok: false, errors: formatZodError(res.error) };
  const value = res.data as unknown as BackupFile;
  const tooBig = checkComplexity(value.data);
  if (tooBig.length) return { ok: false, errors: tooBig };
  return { ok: true, value };
}
const backupOwnership = (b: BackupFile): OwnershipContext => (b.profile ? { scope: 'backup', profiles: [b.profile] } : { scope: 'legacy', profiles: [] });

/** Integridade do conteúdo do arquivo, incluindo as regras de propriedade do formato. */
export function checkBackupIntegrity(b: BackupFile): IntegrityReport {
  return checkIntegrity(b.data, backupOwnership(b));
}

// ---------- Identidade do perfil na restauração ----------
//
//  backup do próprio perfil (mesmo ID)  → mesclar e substituir normalmente
//  backup legado (v0/v1, sem perfil)    → registros atribuídos ao perfil local, informado na prévia
//  backup de outro perfil (ID diferente) → mesclar BLOQUEADO (misturaria donos);
//                                          substituir exige confirmação explícita de transferência
// Em nenhum caso o ID ou o nome do perfil local são alterados por uma restauração.

export type ProfileRelation = 'same' | 'legacy' | 'different';

export interface RestoreIdentity {
  relation: ProfileRelation;
  backupProfile: BackupProfile | null;
  localProfile: { id: string; displayName: string };
}

export function restoreIdentity(b: BackupFile, local: LocalProfile): RestoreIdentity {
  const relation: ProfileRelation = !b.profile ? 'legacy' : b.profile.id === local.id ? 'same' : 'different';
  return { relation, backupProfile: b.profile, localProfile: { id: local.id, displayName: local.displayName } };
}

export const PROFILE_MERGE_BLOCKED_MESSAGE =
  'Este backup pertence a outro perfil. Mesclar misturaria dados de perfis diferentes e foi bloqueado. Nada foi gravado.';
export const PROFILE_TRANSFER_REQUIRED_MESSAGE =
  'Este backup pertence a outro perfil. Confirme explicitamente que os dados dele passarão a pertencer ao perfil local. Nada foi gravado.';

/**
 * Atribui explicitamente ao perfil local os registros com dono do backup (legado ou transferência confirmada).
 * P16: o ID de uma decisão lembrada inclui o perfil (`<perfil>~<conflito>`, ver `decisionRecordId` em
 * '@/modules/planner'); ao trocar o dono, o ID acompanha — senão a decisão ficaria presa à identidade do outro perfil.
 */
export function assignOwner(d: BackupData, profileId: string): BackupData {
  const out = { ...d };
  for (const c of OWNED_COLLECTIONS) (out[c] as { profileId?: string }[]) = (d[c] ?? []).map((r) => (r.profileId === profileId ? r : { ...r, profileId }));
  out.calendarDecisions = (d.calendarDecisions ?? []).map((r) => (r.profileId === profileId && r.id === `${profileId}~${r.conflictId}` ? r : { ...r, profileId, id: `${profileId}~${r.conflictId}` }));
  // P17: o ID do favorito também inclui o perfil (`<perfil>~<alvo>`, ver `favoriteId` em '@/modules/exercises').
  out.exerciseFavorites = (d.exerciseFavorites ?? []).map((r) => (r.profileId === profileId && r.id === `${profileId}~${r.target}` ? r : { ...r, profileId, id: `${profileId}~${r.target}` }));
  return out;
}

export interface ImportSummary {
  routines: number;
  sessions: number;
  bodyEntries: number;
  photos: number;
  /** P12: metas restauradas. */
  goals: number;
  /** P13: entradas de planejamento restauradas. */
  planEntries: number;
  /** P16: decisões lembradas do calendário restauradas. */
  calendarDecisions: number;
  /** P17: exercícios personalizados e favoritos restaurados. */
  customExercises: number;
  exerciseFavorites: number;
  /** Registros do backup não aplicados (duplicatas + conflitos + ignorados). */
  skipped: number;
  duplicates: number;
  conflicts: number;
  /** Registros do backup não restaurados (conflitos + ignorados); 0 na substituição. */
  notRestored: number;
}

export class BackupRestoreError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'BackupRestoreError';
  }
}

export interface RestorePreview {
  exportedAt: string;
  /** Relação entre o perfil do backup e o perfil local. */
  identity: RestoreIdentity;
  /** Integridade do conteúdo do backup. Erros impedem qualquer restauração. */
  integrity: IntegrityReport;
  blocked: boolean;
  incoming: Record<CollectionName, number>;
  local: Record<CollectionName, number>;
  merge: {
    counts: Record<CollectionName, CollectionCounts>;
    totals: CollectionCounts;
    items: MergeItem[];
    /** Registros do backup que não serão restaurados na mesclagem (conflitos + ignorados). */
    notRestored: number;
    /** Erros de integridade que a mesclagem criaria no resultado (bloqueiam a mesclagem). */
    newErrors: IntegrityIssue[];
    /** Backup de outro perfil: mesclagem indisponível. */
    profileBlocked: boolean;
  };
  /** Substituir exige `acceptProfileTransfer` (backup de outro perfil). */
  replaceRequiresProfileTransfer: boolean;
  /**
   * Impressão digital dos dados locais no momento da prévia. A restauração a confere
   * dentro da própria transação e é cancelada se qualquer registro local tiver mudado.
   */
  localFingerprint: string;
}

/** Confirmação dada pelo usuário sobre uma prévia específica. */
export interface RestoreConfirmation {
  /** `localFingerprint` da prévia exibida. */
  expectedLocalFingerprint?: string;
  /** Obrigatório quando parte do backup não será restaurada (conflitos ou ignorados). */
  acceptPartial?: boolean;
  /** Obrigatório para substituir pelos dados de um backup de outro perfil. */
  acceptProfileTransfer?: boolean;
}

export const STALE_PREVIEW_MESSAGE = 'Os dados deste aparelho mudaram desde a prévia. Nada foi gravado; abra o backup novamente para ver a prévia atualizada.';
