import { dataTables, db, mergeSettings } from '@/db/db';
import type { CollectionName, LocalProfile } from './types';
import { checkIntegrity, snapshotFingerprint, type IntegrityIssue, type IntegrityReport, type OwnershipContext } from './integrity';
import { pickDefaultProfile } from './profile';
import { applyPlan, planMerge } from './merge';
import {
  BACKUP_APP,
  BACKUP_SCHEMA_VERSION,
  BackupRestoreError,
  PROFILE_MERGE_BLOCKED_MESSAGE,
  PROFILE_TRANSFER_REQUIRED_MESSAGE,
  STALE_PREVIEW_MESSAGE,
  assignOwner,
  checkBackupIntegrity,
  restoreIdentity,
  type BackupData,
  type BackupFile,
  type ImportSummary,
  type RestoreConfirmation,
  type RestorePreview,
} from './backupFormat';

// Operações de backup sobre o banco local: exportar, diagnosticar, prever e restaurar
// (substituir ou mesclar), sempre em transações. O formato do arquivo e as regras puras
// estão em ./backupFormat.ts, reexportado aqui para manter os imports de '@/lib/backup'.
export * from './backupFormat';

const ALL_TABLES = dataTables;

/**
 * Lê todas as tabelas numa única transação de leitura: o retrato é consistente
 * mesmo com gravações simultâneas (ex.: concluir um treino durante a exportação).
 */
export async function readSnapshot(): Promise<BackupData> {
  return db.transaction('r', ALL_TABLES(), readTables);
}

/** Dados + perfis, lidos juntos (para prévia, restauração e diagnóstico). */
export async function readLocalState(): Promise<{ data: BackupData; profiles: LocalProfile[] }> {
  return db.transaction('r', [...ALL_TABLES(), db.profiles], async () => ({ data: await readTables(), profiles: await db.profiles.toArray() }));
}

async function readTables(): Promise<BackupData> {
  const [settings, routines, sessions, rotations, overrides, bodyEntries, photos, goals, planEntries, calendarDecisions, customExercises, exerciseFavorites] = await Promise.all([
    db.settings.get('settings'),
    db.routines.toArray(),
    db.sessions.toArray(),
    db.rotations.toArray(),
    db.overrides.toArray(),
    db.bodyEntries.toArray(),
    db.photos.toArray(),
    db.goals.toArray(),
    db.planEntries.toArray(),
    db.calendarDecisions.toArray(),
    db.customExercises.toArray(),
    db.exerciseFavorites.toArray(),
  ]);
  return { settings: settings ?? null, routines, sessions, rotations, overrides, bodyEntries, photos, goals, planEntries, calendarDecisions, customExercises, exerciseFavorites };
}

function requireDefaultProfile(profiles: LocalProfile[]): LocalProfile {
  const p = pickDefaultProfile(profiles);
  if (!p) throw new BackupRestoreError('Perfil local não encontrado. Recarregue o app (o perfil é restabelecido ao abrir) e tente novamente. Nada foi alterado.');
  return p;
}

export async function exportBackup(): Promise<BackupFile> {
  const { data, profiles } = await readLocalState();
  const p = requireDefaultProfile(profiles);
  return {
    app: BACKUP_APP,
    kind: 'backup',
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    profile: { id: p.id, displayName: p.displayName, createdAt: p.createdAt },
    data,
  };
}

const localOwnership = (profiles: LocalProfile[]): OwnershipContext => ({ scope: 'local', profiles });

/** Diagnóstico de integridade dos dados deste aparelho (somente leitura). */
export async function checkLocalIntegrity(): Promise<IntegrityReport> {
  const { data, profiles } = await readLocalState();
  return checkIntegrity(data, localOwnership(profiles));
}

function assertFresh(local: BackupData, profiles: LocalProfile[], opts: RestoreConfirmation) {
  if (opts.expectedLocalFingerprint !== undefined && snapshotFingerprint(local, profiles) !== opts.expectedLocalFingerprint) throw new BackupRestoreError(STALE_PREVIEW_MESSAGE);
}

/** Erros de integridade presentes no resultado da mesclagem e ausentes nos dados locais. */
function newMergeErrors(local: BackupData, merged: BackupData, profiles: LocalProfile[]): IntegrityIssue[] {
  const key = (i: IntegrityIssue) => `${i.code}|${i.collection}|${i.id ?? ''}`;
  const ctx = localOwnership(profiles);
  const before = new Set(checkIntegrity(local, ctx).issues.filter((i) => i.severity === 'error').map(key));
  return checkIntegrity(merged, ctx).issues.filter((i) => i.severity === 'error' && !before.has(key(i)));
}

const countOf = (d: BackupData): Record<CollectionName, number> => ({
  settings: d.settings ? 1 : 0,
  routines: d.routines.length,
  sessions: d.sessions.length,
  rotations: d.rotations.length,
  overrides: d.overrides.length,
  bodyEntries: d.bodyEntries.length,
  photos: d.photos.length,
  goals: d.goals.length,
  planEntries: d.planEntries.length,
  calendarDecisions: d.calendarDecisions.length,
  customExercises: d.customExercises.length,
  exerciseFavorites: d.exerciseFavorites.length,
});

/** Analisa o backup contra os dados atuais sem gravar nada. */
export async function previewRestore(b: BackupFile): Promise<RestorePreview> {
  const integrity = checkBackupIntegrity(b);
  const { data: local, profiles } = await readLocalState();
  const identity = restoreIdentity(b, requireDefaultProfile(profiles));
  const profileBlocked = identity.relation === 'different';
  const plan = planMerge(local, assignOwner(b.data, identity.localProfile.id));
  return {
    exportedAt: b.exportedAt,
    identity,
    integrity,
    blocked: !integrity.ok,
    incoming: countOf(b.data),
    local: countOf(local),
    merge: {
      counts: plan.counts,
      totals: plan.totals,
      items: plan.items,
      notRestored: plan.notRestored,
      newErrors: integrity.ok && !profileBlocked ? newMergeErrors(local, applyPlan(local, plan), profiles) : [],
      profileBlocked,
    },
    replaceRequiresProfileTransfer: profileBlocked,
    localFingerprint: snapshotFingerprint(local, profiles),
  };
}

function assertRestorable(b: BackupFile) {
  const integrity = checkBackupIntegrity(b);
  if (!integrity.ok) {
    const errors = integrity.issues.filter((i) => i.severity === 'error');
    throw new BackupRestoreError(
      `O backup tem ${errors.length} problema(s) de integridade e não foi aplicado. Nenhum dado foi alterado.`,
      errors.slice(0, 12).map((i) => `${i.collection}${i.id ? ` (${i.id})` : ''}: ${i.message}`),
    );
  }
}

/**
 * Substitui todos os dados locais pelo backup. Valida antes de gravar e roda numa
 * única transação: qualquer falha desfaz tudo e os dados anteriores ficam intactos.
 */
export async function restoreBackupReplace(b: BackupFile, opts: RestoreConfirmation = {}): Promise<ImportSummary> {
  assertRestorable(b);
  const d0 = b.data;
  // O perfil local entra só para leitura: substituir troca os dados, nunca a identidade local.
  await db.transaction('rw', [...ALL_TABLES(), db.profiles], async () => {
    const profiles = await db.profiles.toArray();
    // Não apagar dados que o usuário não viu na prévia (ex.: treino concluído em outra aba).
    assertFresh(await readTables(), profiles, opts);
    const identity = restoreIdentity(b, requireDefaultProfile(profiles));
    if (identity.relation === 'different' && !opts.acceptProfileTransfer) throw new BackupRestoreError(PROFILE_TRANSFER_REQUIRED_MESSAGE);
    const d = assignOwner(d0, identity.localProfile.id);
    await Promise.all(ALL_TABLES().map((t) => t.clear()));
    if (d.settings) await db.settings.put(mergeSettings(d.settings));
    // bulkPut: cópias idênticas repetidas no arquivo (aviso DUPLICATE_ID_IDENTICAL) viram um registro;
    // IDs repetidos com conteúdo diferente já foram barrados por assertRestorable.
    await db.routines.bulkPut(d.routines);
    await db.sessions.bulkPut(d.sessions);
    await db.rotations.bulkPut(d.rotations);
    await db.overrides.bulkPut(d.overrides);
    await db.bodyEntries.bulkPut(d.bodyEntries);
    await db.photos.bulkPut(d.photos);
    await db.goals.bulkPut(d.goals);
    await db.planEntries.bulkPut(d.planEntries);
    // P16: decisões do backup voltam com o dono local; só valem se o calendário atual tiver o MESMO conflito com a
    // MESMA impressão digital (senão ficam sem efeito e aparecem como tal em "Decisões lembradas").
    await db.calendarDecisions.bulkPut(d.calendarDecisions);
    // P17: personalizados e favoritos voltam com o dono local. Nada é associado por nome: fichas do backup mantêm a
    // origem gravada nelas (ou nenhuma, em backups anteriores à biblioteca).
    await db.customExercises.bulkPut(d.customExercises);
    await db.exerciseFavorites.bulkPut(d.exerciseFavorites);
  });
  return {
    routines: d0.routines.length,
    sessions: d0.sessions.length,
    bodyEntries: d0.bodyEntries.length,
    photos: d0.photos.length,
    goals: d0.goals.length,
    planEntries: d0.planEntries.length,
    calendarDecisions: d0.calendarDecisions.length,
    customExercises: d0.customExercises.length,
    exerciseFavorites: d0.exerciseFavorites.length,
    skipped: 0,
    duplicates: 0,
    conflicts: 0,
    notRestored: 0,
  };
}

/**
 * Mescla o backup com os dados atuais (política em src/lib/merge.ts). Dentro da transação:
 * 1. confere a impressão digital dos dados locais da prévia (qualquer mudança cancela);
 * 2. refaz o plano; se parte do backup não será restaurada, exige `acceptPartial`;
 * 3. confere que o resultado não cria erros de integridade (referências);
 * 4. só insere: nunca sobrescreve um registro existente.
 * Qualquer falha desfaz tudo.
 */
export async function restoreBackupMerge(b: BackupFile, opts: RestoreConfirmation = {}): Promise<ImportSummary> {
  assertRestorable(b);
  return db.transaction('rw', [...ALL_TABLES(), db.profiles], async () => {
    const profiles = await db.profiles.toArray();
    const local = await readTables();
    assertFresh(local, profiles, opts);
    const identity = restoreIdentity(b, requireDefaultProfile(profiles));
    if (identity.relation === 'different') throw new BackupRestoreError(PROFILE_MERGE_BLOCKED_MESSAGE);
    const plan = planMerge(local, assignOwner(b.data, identity.localProfile.id));
    if (plan.notRestored > 0 && !opts.acceptPartial)
      throw new BackupRestoreError(
        `${plan.notRestored} registro(s) do backup não serão restaurados (conflitos ou ignorados). Confirme explicitamente para continuar. Nada foi gravado.`,
        plan.items.filter((i) => i.kind === 'conflict' || i.kind === 'kept-local' || i.kind === 'skipped').slice(0, 12).map((i) => `${i.collection} (${i.id}): ${i.message}`),
      );
    const broken = newMergeErrors(local, applyPlan(local, plan), profiles);
    if (broken.length)
      throw new BackupRestoreError(
        'A mesclagem deixaria referências inconsistentes e foi cancelada. Nada foi gravado.',
        broken.slice(0, 12).map((i) => `${i.collection}${i.id ? ` (${i.id})` : ''}: ${i.message}`),
      );
    const a = plan.toAdd;
    if (a.settings) await db.settings.add(mergeSettings(a.settings));
    await db.routines.bulkAdd(a.routines);
    await db.sessions.bulkAdd(a.sessions);
    await db.rotations.bulkAdd(a.rotations);
    await db.overrides.bulkAdd(a.overrides);
    await db.bodyEntries.bulkAdd(a.bodyEntries);
    await db.photos.bulkAdd(a.photos);
    await db.goals.bulkAdd(a.goals);
    await db.planEntries.bulkAdd(a.planEntries);
    await db.calendarDecisions.bulkAdd(a.calendarDecisions);
    await db.customExercises.bulkAdd(a.customExercises);
    await db.exerciseFavorites.bulkAdd(a.exerciseFavorites);
    const t = plan.totals;
    return {
      routines: a.routines.length,
      sessions: a.sessions.length,
      bodyEntries: a.bodyEntries.length,
      photos: a.photos.length,
      goals: a.goals.length,
      planEntries: a.planEntries.length,
      calendarDecisions: a.calendarDecisions.length,
      customExercises: a.customExercises.length,
      exerciseFavorites: a.exerciseFavorites.length,
      skipped: t.duplicate + t.conflict + t.skipped,
      duplicates: t.duplicate,
      conflicts: t.conflict,
      notRestored: plan.notRestored,
    };
  });
}
