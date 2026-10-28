// Decisões lembradas no banco (IronTrack 2.0 F01/P16): persistência (Dexie v5) depois de reabrir, isolamento por
// perfil, registros corrompidos, limite, revalidação na transação, concorrência entre abas, nada além das decisões é
// gravado, backup v6 (exportar, substituir, mesclar, transferência de perfil, v5 → v6, inválidos, rollback), "apagar
// tudo" e exclusão de rotina. Dados fictícios.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_SCHEMA_VERSION, IronTrackDB, clearLocalData, db, saveSettings, setDb } from '@/db/db';
import { addPlanActivity, listPlanEntries, updatePlanActivity } from '@/db/planner';
import { listCalendarDecisions, readDecisionSources } from '@/db/calendarDecisions';
import { cleanupDecisions, rememberDecision, removeDecision, removeInvalidDecisions, showDecisionAgain } from '@/features/calendar/decisionActions';
import {
  BACKUP_SCHEMA_VERSION,
  PROFILE_MERGE_BLOCKED_MESSAGE,
  assignOwner,
  checkBackupIntegrity,
  exportBackup,
  parseBackup,
  previewRestore,
  readSnapshot,
  restoreBackupMerge,
  restoreBackupReplace,
  type BackupFile,
} from '@/lib/backup';
import { resolveDay, type CalendarConflict, type CalendarInput } from '@/modules/calendar';
import { DECISION_LIMITS, conflictIdentity, decisionRecordId, type CalendarDecision } from '@/modules/planner';
import { routine } from './fixtures';

const WED = '2026-10-28';
const OTHER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', displayName: 'Outro perfil', createdAt: 1_600_000_000_000 };
const NOW = 1_800_000_000_000;
const KIND = 'plan_vs_legacy_workout';

let n = 0;
let dbName = '';
beforeEach(async () => {
  dbName = `calendar-decisions-db-${++n}`;
  setDb(new IronTrackDB(dbName));
  await db.open();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const clock = (today = WED, now = NOW) => {
  let i = 0;
  return { today, now, newId: () => `gen-${today}-${now}-${++i}` };
};
const parse = (o: unknown): BackupFile => {
  const r = parseBackup(JSON.stringify(o));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.value;
};

/** Rotina ativa r1 (A, B, C), seg/qua/sex na agenda anterior (rotação aponta A) e B planejado toda quarta. */
async function seed() {
  const pid = db.currentProfileId!;
  await db.routines.put({ ...routine('r1'), profileId: pid });
  await db.rotations.put({ routineId: 'r1', nextIndex: 0, updatedAt: 5 });
  await saveSettings({ activeRoutineId: 'r1', trainingDays: [1, 3, 5] });
  await addPlanActivity({ id: 'qua-b', slot: { scope: 'weekly', weekday: 3 }, activity: { routineId: 'r1', workoutId: 'r1-B' } }, clock());
  return pid;
}

/** O que a tela mostraria agora (fontes lidas do banco + decisões guardadas). */
async function screen(today = WED): Promise<CalendarInput> {
  const s = await readDecisionSources(db.currentProfileId!);
  return { today, profileId: s.profileId, entries: s.entries, sessions: s.sessions, routines: s.routines, rotations: s.rotations, legacy: s.legacy, decisions: (await listCalendarDecisions()).decisions };
}
async function shown(date = WED, kind = KIND): Promise<CalendarConflict> {
  const c = resolveDay(await screen(), date).conflicts.find((x) => x.kind === kind);
  if (!c) throw new Error('conflito esperado');
  return c;
}
async function remember(date = WED, kind = KIND, decision: 'keep_plan' | 'hide_info' = 'keep_plan', c = clock()) {
  const s = await shown(date, kind);
  await rememberDecision({ date, conflictId: s.id, decision, expectedFingerprint: s.fingerprint, expectedRevision: s.stored?.revision ?? null }, c);
  return s;
}
const nonDecisionData = async () => ({ ...(await readSnapshot()), calendarDecisions: [] });

describe('persistência', () => {
  it('lembrar grava uma decisão validada, só nas decisões; o aviso não volta depois de reabrir o app', async () => {
    await seed();
    const before = await nonDecisionData();
    expect((await shown()).remembered).toBeNull();
    await remember();
    const [d] = (await listCalendarDecisions()).decisions;
    expect(d).toMatchObject({ id: decisionRecordId(db.currentProfileId!, conflictIdentity(KIND, WED, null)), decision: 'keep_plan', scope: 'conflict_day', date: WED, revision: 1, createdAt: NOW });
    expect(await nonDecisionData()).toEqual(before); // planejamento, sessões, rotação, agenda anterior, fichas intactos
    db.close();
    setDb(new IronTrackDB(dbName));
    await db.open();
    expect(DB_SCHEMA_VERSION).toBe(5);
    expect(db.verno).toBe(5);
    expect(resolveDay(await screen(), WED).hasWarning).toBe(false);
    expect((await shown()).remembered?.decisionId).toBe(d.id);
  });

  it('repetir (toque duplo) não cria registro novo; voltar a mostrar e remover conferem a revisão', async () => {
    await seed();
    await remember();
    await remember(); // já lembrada: idempotente
    const [d] = (await listCalendarDecisions()).decisions;
    expect(d.revision).toBe(1);
    await showDecisionAgain(d.id, 1, { now: NOW + 1 });
    expect((await listCalendarDecisions()).decisions[0]).toMatchObject({ decision: 'show', revision: 2 });
    expect(resolveDay(await screen(), WED).hasWarning).toBe(true);
    await expect(removeDecision(d.id, 1)).rejects.toMatchObject({ kind: 'changed' });
    await removeDecision(d.id, 2);
    expect(await db.calendarDecisions.count()).toBe(0);
  });

  it('mudança relevante no planejamento invalida; lembrar de novo atualiza o mesmo registro', async () => {
    await seed();
    await remember();
    const e = (await listPlanEntries())[0];
    await updatePlanActivity({ id: e.id, expectedRevision: e.revision, activity: { routineId: 'r1', workoutId: 'r1-C' } }, clock());
    const c = await shown();
    expect(c.remembered).toBeNull();
    expect(c.stored).toMatchObject({ revision: 1, decision: 'keep_plan' });
    await remember();
    expect((await listCalendarDecisions()).decisions[0]).toMatchObject({ revision: 2, sourceFingerprint: c.fingerprint });
  });

  it('a tela desatualizada (dia mudou em outra aba antes de confirmar) não grava nada', async () => {
    await seed();
    const s = await shown();
    const e = (await listPlanEntries())[0];
    await updatePlanActivity({ id: e.id, expectedRevision: e.revision, activity: { routineId: 'r1', workoutId: 'r1-C' } }, clock());
    await expect(rememberDecision({ date: WED, conflictId: s.id, decision: 'keep_plan', expectedFingerprint: s.fingerprint, expectedRevision: null }, clock())).rejects.toMatchObject({ kind: 'changed' });
    expect(await db.calendarDecisions.count()).toBe(0);
  });

  it('passado, divergência inexistente e decisão não permitida são recusados', async () => {
    await seed();
    const s = await shown();
    const req = { date: WED, conflictId: s.id, decision: 'keep_plan' as const, expectedFingerprint: s.fingerprint, expectedRevision: null };
    await expect(rememberDecision(req, clock('2026-10-29'))).rejects.toMatchObject({ kind: 'past' });
    await expect(rememberDecision({ ...req, conflictId: conflictIdentity(KIND, '2026-10-29', null), date: '2026-10-29' }, clock())).rejects.toMatchObject({ kind: 'gone' });
    await expect(rememberDecision({ ...req, decision: 'hide_info' }, clock())).rejects.toMatchObject({ kind: 'not_allowed' });
    expect(await db.calendarDecisions.count()).toBe(0);
  });
});

describe('perfis, corrupção e limites', () => {
  it('decisão de outro perfil não vale aqui e não é listada', async () => {
    await seed();
    await remember();
    const [d] = (await listCalendarDecisions()).decisions;
    await db.calendarDecisions.put({ ...d, id: decisionRecordId(OTHER.id, d.conflictId), profileId: OTHER.id });
    expect((await listCalendarDecisions()).decisions).toHaveLength(1);
    const own = db.currentProfileId;
    db.currentProfileId = OTHER.id;
    expect((await listCalendarDecisions()).decisions.map((x) => x.profileId)).toEqual([OTHER.id]);
    db.currentProfileId = own;
  });

  it('registros corrompidos são ignorados (o aviso aparece), informados e removíveis sem tocar nos válidos', async () => {
    await seed();
    await remember();
    const [d] = (await listCalendarDecisions()).decisions;
    const pid = db.currentProfileId!;
    await db.calendarDecisions.bulkPut([
      { ...d, id: `${pid}~lixo`, conflictId: 'lixo', decision: 'ignore_all' } as unknown as CalendarDecision,
      { ...d, id: decisionRecordId(pid, conflictIdentity(KIND, '2026-11-04', null)), conflictId: conflictIdentity(KIND, '2026-11-04', null), date: '2026-13-04' } as CalendarDecision,
    ]);
    const s = await listCalendarDecisions();
    expect(s.decisions.map((x) => x.id)).toEqual([d.id]);
    expect(s.invalidIds).toHaveLength(2);
    expect(await removeInvalidDecisions()).toBe(2);
    expect((await listCalendarDecisions()).invalidIds).toEqual([]);
    expect(await db.calendarDecisions.count()).toBe(1);
    // Corromper a decisão que valia: o aviso volta (nada fica escondido por dado ilegível).
    await db.calendarDecisions.put({ ...d, sourceFingerprint: '' });
    expect(resolveDay(await screen(), WED).hasWarning).toBe(true);
  });

  it(`limite de ${DECISION_LIMITS.maxPerProfile} decisões por perfil: a próxima é recusada sem gravar`, async () => {
    await seed();
    const s = await shown();
    const pid = db.currentProfileId!;
    const filler: CalendarDecision[] = Array.from({ length: DECISION_LIMITS.maxPerProfile }, (_, i) => {
      const cid = conflictIdentity('session_off_plan', '2026-10-28', `s${i}`);
      return { id: decisionRecordId(pid, cid), profileId: pid, conflictId: cid, conflictType: 'session_off_plan', scope: 'info_notice', date: WED, subject: `s${i}`, decision: 'show', severity: 'warning', sourceFingerprint: 'f', summary: 'x', createdAt: 1, updatedAt: 1, revision: 1 };
    });
    await db.calendarDecisions.bulkPut(filler);
    await expect(rememberDecision({ date: WED, conflictId: s.id, decision: 'keep_plan', expectedFingerprint: s.fingerprint, expectedRevision: null }, clock())).rejects.toMatchObject({ kind: 'limit' });
    expect(await db.calendarDecisions.count()).toBe(DECISION_LIMITS.maxPerProfile);
  });

  it('limpar remove só as sem efeito, reavaliadas na transação', async () => {
    await seed();
    await remember();
    const [d] = (await listCalendarDecisions()).decisions;
    // A mesma decisão vista no dia seguinte já venceu; hoje ainda vale.
    expect((await cleanupDecisions([d.id], { today: WED })).delete).toEqual([]);
    expect((await cleanupDecisions([d.id], { today: '2026-10-29' })).delete).toEqual([d.id]);
    expect(await db.calendarDecisions.count()).toBe(0);
  });
});

describe('concorrência entre abas', () => {
  it('duas confirmações simultâneas (toque duplo) e outra aba depois: um único registro, revisão 1', async () => {
    await seed();
    const s = await shown();
    const req = { date: WED, conflictId: s.id, decision: 'keep_plan' as const, expectedFingerprint: s.fingerprint, expectedRevision: null };
    await Promise.all([rememberDecision(req, clock()), rememberDecision(req, clock())]);
    // A outra aba confirma a mesma tela antiga depois: idempotente, nada muda.
    const tabB = new IronTrackDB(dbName);
    await tabB.open();
    const tabA = db;
    setDb(tabB);
    await rememberDecision(req, clock());
    setDb(tabA);
    const all = await db.calendarDecisions.toArray();
    expect(all).toHaveLength(1);
    expect(all[0].revision).toBe(1);
    tabB.close();
  });

  it('outra aba volta a mostrar; esta aba, com a tela antiga, não consegue remover a versão nova', async () => {
    await seed();
    await remember();
    const [d] = (await listCalendarDecisions()).decisions;
    const tabB = new IronTrackDB(dbName);
    await tabB.open();
    const tabA = db;
    setDb(tabB);
    await showDecisionAgain(d.id, 1);
    setDb(tabA);
    await expect(removeDecision(d.id, 1)).rejects.toMatchObject({ kind: 'changed' });
    expect((await db.calendarDecisions.get(d.id))!.decision).toBe('show');
    tabB.close();
  });

  it('uma aba remove enquanto a outra volta a mostrar: a segunda falha sem recriar', async () => {
    await seed();
    await remember();
    const [d] = (await listCalendarDecisions()).decisions;
    await removeDecision(d.id, 1);
    await expect(showDecisionAgain(d.id, 1)).rejects.toMatchObject({ kind: 'missing' });
    expect(await db.calendarDecisions.count()).toBe(0);
  });

  it('falha no meio da gravação: nada muda', async () => {
    await seed();
    vi.spyOn(db.calendarDecisions, 'bulkPut').mockImplementationOnce(() => Promise.reject(new Error('falha simulada')) as never);
    await expect(remember()).rejects.toThrow('falha simulada');
    expect(await db.calendarDecisions.count()).toBe(0);
  });
});

describe('backup v6', () => {
  const roundTrip = async () => parse(JSON.parse(JSON.stringify(await exportBackup())));

  it('exporta as decisões; substituir devolve exatamente; o aviso continua reconhecido', async () => {
    await seed();
    await remember();
    const b = await roundTrip();
    expect(BACKUP_SCHEMA_VERSION).toBe(6);
    expect(b.data.calendarDecisions).toHaveLength(1);
    const before = await readSnapshot();
    await db.calendarDecisions.clear();
    const p = await previewRestore(b);
    expect(p.incoming.calendarDecisions).toBe(1);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint });
    expect(await readSnapshot()).toEqual(before);
    expect(resolveDay(await screen(), WED).hasWarning).toBe(false);
  });

  it('mesclar: decisão nova entra, idêntica é ignorada, em conflito de ID fica a local (com confirmação)', async () => {
    await seed();
    await remember();
    const b = await roundTrip();
    const [d] = (await listCalendarDecisions()).decisions;
    let p = await previewRestore(b);
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint });
    expect(await db.calendarDecisions.count()).toBe(1);
    await showDecisionAgain(d.id, 1, { now: NOW + 1 });
    p = await previewRestore(b);
    await expect(restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow();
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true });
    expect((await db.calendarDecisions.get(d.id))!.decision).toBe('show'); // a local (mais nova) não foi sobrescrita
    await db.calendarDecisions.clear();
    p = await previewRestore(b);
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint });
    expect((await db.calendarDecisions.get(d.id))!.decision).toBe('keep_plan');
  });

  it('backup de outro perfil: substituir com transferência remapeia dono e ID; mesclar é bloqueado', async () => {
    const pid = await seed();
    await remember();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.profile = OTHER;
    raw.data = assignOwner(raw.data, OTHER.id);
    const b = parse(raw);
    expect(b.data.calendarDecisions[0].id.startsWith(`${OTHER.id}~`)).toBe(true);
    const p = await previewRestore(b);
    await expect(restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true })).rejects.toThrow(PROFILE_MERGE_BLOCKED_MESSAGE);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint, acceptProfileTransfer: true });
    const [d] = await db.calendarDecisions.toArray();
    expect(d).toMatchObject({ profileId: pid, id: decisionRecordId(pid, conflictIdentity(KIND, WED, null)) });
    expect(resolveDay(await screen(), WED).hasWarning).toBe(false);
  });

  it('backup v5 (sem decisões) migra para v6 com lista vazia; restaurar apaga as decisões locais', async () => {
    await seed();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.schemaVersion = 5;
    delete raw.data.calendarDecisions;
    await remember();
    const b = parse(raw);
    expect(b.schemaVersion).toBe(6);
    expect(b.data.calendarDecisions).toEqual([]);
    const p = await previewRestore(b);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint });
    expect(await db.calendarDecisions.count()).toBe(0);
    expect(resolveDay(await screen(), WED).hasWarning).toBe(true);
  });

  it('decisão inválida, de outro dono ou com ID incoerente bloqueia a restauração; nada é gravado', async () => {
    await seed();
    await remember();
    const before = await readSnapshot();
    for (const bad of [
      (d: CalendarDecision) => ({ ...d, decision: 'ignore_all' }),
      (d: CalendarDecision) => ({ ...d, date: '2026-02-31' }),
      (d: CalendarDecision) => ({ ...d, profileId: OTHER.id }),
      (d: CalendarDecision) => ({ ...d, id: 'sem-perfil' }),
    ]) {
      const raw = JSON.parse(JSON.stringify(await exportBackup()));
      raw.data.calendarDecisions[0] = bad(raw.data.calendarDecisions[0]);
      const r = parseBackup(JSON.stringify(raw));
      if (!r.ok) continue; // recusado já na leitura
      expect(checkBackupIntegrity(r.value).ok).toBe(false);
      const p = await previewRestore(r.value);
      expect(p.blocked).toBe(true);
      await expect(restoreBackupReplace(r.value, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow();
    }
    expect(await readSnapshot()).toEqual(before);
  });

  it('falha no meio da restauração: decisões e demais dados ficam como estavam', async () => {
    await seed();
    await remember();
    const before = await readSnapshot();
    const b = await roundTrip();
    const p = await previewRestore(b);
    vi.spyOn(db.calendarDecisions, 'bulkPut').mockImplementationOnce(() => Promise.reject(new Error('falha simulada')) as never);
    await expect(restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow();
    expect(await readSnapshot()).toEqual(before);
  });
});

describe('limpeza e exclusão', () => {
  it('"apagar tudo" apaga as decisões', async () => {
    await seed();
    await remember();
    await clearLocalData();
    expect(await db.calendarDecisions.count()).toBe(0);
  });

  it('rotina removida: a divergência some e a decisão fica sem efeito (resolvida), sem esconder nada', async () => {
    await seed();
    await remember();
    await db.routines.delete('r1');
    const day = resolveDay(await screen(), WED);
    expect(day.conflicts.some((c) => c.kind === KIND)).toBe(false);
    expect((await cleanupDecisions((await listCalendarDecisions()).decisions.map((d) => d.id))).delete).toHaveLength(1);
  });
});
