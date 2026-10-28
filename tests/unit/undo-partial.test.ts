// Desfazer inteligente da importação (IronTrack 2.0 F01/P16): prévia por item (seguro, alterado depois, excluído
// depois, passado, já desfeito), "desfazer tudo" só quando tudo é seguro, "desfazer só os seguros", revalidação entre a
// prévia e a confirmação, concorrência entre abas, passado e repetição (termina, não apaga), registro "desfeita em
// parte" e compatibilidade com o registro do P15. Dados fictícios.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IronTrackDB, db, saveSettings, setDb } from '@/db/db';
import { listPlanEntries, removePlanEntry, updatePlanActivity } from '@/db/planner';
import { applyImport, checkUndoImport, previewImport, readLastImport, undoLastImport } from '@/db/legacyImport';
import { routine, session } from './fixtures';

const WED = '2026-10-28';
const FRI = '2026-10-30';
const MON = '2026-11-02';

let n = 0;
let dbName = '';
beforeEach(async () => {
  dbName = `undo-partial-${++n}`;
  setDb(new IronTrackDB(dbName));
  await db.open();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const clock = (today = WED, now = 1_800_000_000_000) => {
  let i = 0;
  return { today, now, newId: () => `gen-${today}-${now}-${++i}` };
};

/** Mesmo cenário da consolidação: r1 ativa, seg/qua/sex, sexta → C, segunda descanso; importa tudo (5 itens). */
async function seedAndImport() {
  const pid = db.currentProfileId!;
  await db.routines.put({ ...routine('r1'), profileId: pid });
  await db.rotations.put({ routineId: 'r1', nextIndex: 1, updatedAt: 5 });
  await saveSettings({ activeRoutineId: 'r1', trainingDays: [1, 3, 5] });
  await db.overrides.bulkPut([
    { routineId: 'r1', date: FRI, kind: 'workout', workoutId: 'r1-C' },
    { routineId: 'r1', date: MON, kind: 'rest' },
  ]);
  await db.sessions.put({ ...session('s1'), profileId: pid });
  const c = clock();
  const p = await previewImport({ mode: 'empty_only' }, c);
  return applyImport({ operationId: 'op', mode: 'empty_only', expectedFingerprint: p.fingerprint }, c);
}
const statuses = async (c = clock()) => Object.fromEntries((await checkUndoImport(c)).preview!.items.map((i) => [i.key, i.status]));

describe('prévia por item', () => {
  it('sem mudanças depois: tudo seguro e "desfazer tudo" funciona como no P15', async () => {
    const r = await seedAndImport();
    const { preview } = await checkUndoImport(clock());
    expect(preview!.allSafe).toBe(true);
    expect(preview!.items.every((i) => i.status === 'safe')).toBe(true);
    expect(preview!.items).toHaveLength(5);
    await undoLastImport({ recordId: r.record.id, mode: 'all', expectedFingerprint: preview!.fingerprint }, clock());
    expect(await listPlanEntries()).toEqual([]);
    expect((await readLastImport())!.status).toBe('undone');
  });

  it('dia alterado e entrada excluída depois: classificados; "desfazer tudo" bloqueado sem mexer em nada', async () => {
    const r = await seedAndImport();
    const all = await listPlanEntries();
    const fri = all.find((e) => e.date === FRI)!;
    const mon = all.find((e) => e.scope === 'weekly' && e.weekday === 1)!;
    await updatePlanActivity({ id: fri.id, expectedRevision: fri.revision, activity: { routineId: 'r1', workoutId: 'r1-A' } }, clock());
    await removePlanEntry({ id: mon.id, expectedRevision: mon.revision }, clock());
    const s = await statuses();
    expect(s).toMatchObject({ [`date:${FRI}`]: 'modified', 'weekly:1': 'deleted', 'weekly:3': 'safe', 'weekly:5': 'safe', [`date:${MON}`]: 'safe' });
    const snapshot = await listPlanEntries();
    await expect(undoLastImport({ recordId: r.record.id, mode: 'all' }, clock())).rejects.toMatchObject({ kind: 'undo_blocked' });
    expect(await listPlanEntries()).toEqual(snapshot);
  });
});

describe('desfazer só os seguros', () => {
  it('reverte os seguros, preserva o que a pessoa mudou e marca "desfeita em parte"', async () => {
    const r = await seedAndImport();
    const fri = (await listPlanEntries()).find((e) => e.date === FRI)!;
    await updatePlanActivity({ id: fri.id, expectedRevision: fri.revision, activity: { routineId: 'r1', workoutId: 'r1-A' } }, clock());
    const edited = (await listPlanEntries()).find((e) => e.date === FRI)!;
    const { preview } = await checkUndoImport(clock());
    expect(preview!.safeCount).toBe(4);
    await undoLastImport({ recordId: r.record.id, mode: 'safe', expectedFingerprint: preview!.fingerprint }, clock());
    expect(await listPlanEntries()).toEqual([edited]); // só a alteração posterior ficou, intacta
    const rec = (await readLastImport())!;
    expect(rec.status).toBe('partial');
    expect(rec.reverted).toHaveLength(4);
    // Nova prévia: os revertidos aparecem como "já desfeito"; o pendente continua para revisão; nada seguro sobrou.
    const s = await statuses();
    expect(Object.values(s).filter((x) => x === 'reverted')).toHaveLength(4);
    expect(s[`date:${FRI}`]).toBe('modified');
    await expect(undoLastImport({ recordId: r.record.id, mode: 'safe' }, clock())).rejects.toMatchObject({ kind: 'undo_nothing' });
    // A agenda anterior, a rotação e as sessões nunca são tocadas.
    expect(await db.overrides.count()).toBe(2);
    expect((await db.rotations.get('r1'))!.nextIndex).toBe(1);
    expect(await db.sessions.count()).toBe(1);
  });

  it('a pessoa devolve o dia ao estado importado? continua pendente (nunca sobrescreve sem prévia nova)', async () => {
    const r = await seedAndImport();
    const fri = (await listPlanEntries()).find((e) => e.date === FRI)!;
    await updatePlanActivity({ id: fri.id, expectedRevision: fri.revision, activity: { routineId: 'r1', workoutId: 'r1-A' } }, clock());
    await undoLastImport({ recordId: r.record.id, mode: 'safe' }, clock());
    const cur = (await listPlanEntries())[0];
    await updatePlanActivity({ id: cur.id, expectedRevision: cur.revision, activity: { routineId: 'r1', workoutId: 'r1-C' } }, clock());
    expect((await statuses())[`date:${FRI}`]).toBe('modified'); // revisão mudou: não é mais a entrada importada
    expect((await readLastImport())!.status).toBe('partial');
  });
});

describe('revalidação e concorrência', () => {
  it('mudança entre a prévia e a confirmação: nada é desfeito', async () => {
    const r = await seedAndImport();
    const { preview } = await checkUndoImport(clock());
    const tabB = new IronTrackDB(dbName);
    await tabB.open();
    const tabA = db;
    setDb(tabB);
    const wed = (await listPlanEntries()).find((e) => e.scope === 'weekly' && e.weekday === 3)!;
    await updatePlanActivity({ id: wed.id, expectedRevision: wed.revision, activity: { routineId: 'r1', workoutId: 'r1-B' } }, clock());
    setDb(tabA);
    const snapshot = await listPlanEntries();
    for (const mode of ['all', 'safe'] as const)
      await expect(undoLastImport({ recordId: r.record.id, mode, expectedFingerprint: preview!.fingerprint }, clock())).rejects.toMatchObject({ kind: 'undo_changed' });
    expect(await listPlanEntries()).toEqual(snapshot);
    expect((await readLastImport())!.status).toBe('applied');
    tabB.close();
  });

  it('duas confirmações da mesma prévia (toque duplo ou duas abas): só uma aplica', async () => {
    const r = await seedAndImport();
    const fri = (await listPlanEntries()).find((e) => e.date === FRI)!;
    await updatePlanActivity({ id: fri.id, expectedRevision: fri.revision, activity: { routineId: 'r1', workoutId: 'r1-A' } }, clock());
    const { preview } = await checkUndoImport(clock());
    const input = { recordId: r.record.id, mode: 'safe' as const, expectedFingerprint: preview!.fingerprint };
    const res = await Promise.allSettled([undoLastImport(input, clock()), undoLastImport(input, clock())]);
    expect(res.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await listPlanEntries()).toHaveLength(1);
  });

  it('falha no meio: nada desfeito e o registro continua como estava', async () => {
    const r = await seedAndImport();
    const before = await listPlanEntries();
    vi.spyOn(db.planEntries, 'bulkDelete').mockImplementationOnce(() => Promise.reject(new Error('falha simulada')) as never);
    await expect(undoLastImport({ recordId: r.record.id, mode: 'safe' }, clock())).rejects.toThrow('falha simulada');
    expect(await listPlanEntries()).toEqual(before);
    expect((await readLastImport())!.status).toBe('applied');
  });
});

describe('política temporal', () => {
  it('dias já passados ficam como estão; a repetição criada termina ontem em vez de ser apagada', async () => {
    const r = await seedAndImport();
    const later = clock('2026-11-10', 1_800_000_100_000);
    const { preview } = await checkUndoImport(later);
    const s = Object.fromEntries(preview!.items.map((i) => [i.key, i]));
    expect(s[`date:${FRI}`].status).toBe('past');
    expect(s[`date:${MON}`].status).toBe('past');
    expect(s['weekly:3']).toMatchObject({ status: 'safe', endsRecurrence: true });
    expect(preview!.allSafe).toBe(true); // passado não bloqueia: só não é reescrito
    await undoLastImport({ recordId: r.record.id, mode: 'all', expectedFingerprint: preview!.fingerprint }, later);
    const all = await listPlanEntries();
    expect(all.filter((e) => e.scope === 'date').map((e) => e.date).sort()).toEqual([FRI, MON]);
    expect(all.filter((e) => e.scope === 'weekly').every((e) => e.validUntil === '2026-11-09')).toBe(true);
    expect((await readLastImport())!.status).toBe('undone');
  });
});

describe('compatibilidade', () => {
  it('registro do P15 (sem lista de revertidos) continua desfazendo', async () => {
    const r = await seedAndImport();
    const key = (await db.settings.toArray()).find((x) => String(x.id).includes(db.currentProfileId!) && (x as { kind?: string }).kind === 'planImport')!;
    const stored = key as unknown as { record: Record<string, unknown> };
    delete stored.record.reverted;
    await db.settings.put(key);
    expect((await checkUndoImport(clock())).plan!.ok).toBe(true);
    await undoLastImport({ recordId: r.record.id }, clock());
    expect(await listPlanEntries()).toEqual([]);
  });
});
