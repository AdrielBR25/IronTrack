// Operações extraídas das telas para os módulos e repositórios (IronTrack 2.0 F01/P03).
// Cada teste reproduz o que a tela fazia antes, agora sem React.
// Dados fictícios: nunca use medidas ou registros reais do usuário aqui.
import { beforeEach, describe, expect, it } from 'vitest';
import { IronTrackDB, clearLocalData, db, saveSettings, setDb } from '@/db/db';
import { getCurrentProfile } from '@/db/profiles';
import { addRoutine, getRoutine, markRestNotified, saveSession, startSession } from '@/db/repo';
import { importBodyEvaluations, saveBodyEntryWithPhotos } from '@/db/body';
import { substituteOptions, startRest, type Routine } from '@/modules/training';
import type { ParsedEvaluation } from '@/modules/body';
import { entry, PHOTO, routine } from './fixtures';

let n = 0;
beforeEach(async () => {
  setDb(new IronTrackDB(`boundaries-${++n}`));
  await db.open();
});

describe('substituteOptions (antes dentro de ActiveWorkoutPage)', () => {
  const r: Routine = routine('r1');
  r.workouts[0].exercises[0] = { ...r.workouts[0].exercises[0], substitutes: ['Supino com halteres', 'Exercício r1-B1'] };
  const ex = { templateId: r.workouts[0].exercises[0].id, muscleGroup: 'Peito', name: r.workouts[0].exercises[0].name };

  it('substitutos do modelo primeiro, depois o mesmo grupo, sem repetir e sem o próprio exercício', () => {
    expect(substituteOptions(r, ex)).toEqual(['Supino com halteres', 'Exercício r1-B1', 'Exercício r1-A2', 'Exercício r1-B2', 'Exercício r1-C1', 'Exercício r1-C2']);
  });

  it('no máximo 8 e sem rotina nenhuma sugestão', () => {
    const many: Routine = { ...r, workouts: [{ ...r.workouts[0], exercises: Array.from({ length: 12 }, (_, i) => ({ ...r.workouts[0].exercises[1], id: `x${i}`, name: `Outro ${i}` })) }] };
    expect(substituteOptions(many, ex)).toHaveLength(8);
    expect(substituteOptions(undefined, ex)).toEqual([]);
  });
});

describe('repositórios usados pelas telas', () => {
  it('getRoutine devolve a rotina gravada', async () => {
    await addRoutine(routine('r1'));
    expect((await getRoutine('r1'))?.name).toBe('Rotina r1');
    expect(await getRoutine('nao-existe')).toBeUndefined();
  });

  it('markRestNotified marca o descanso uma única vez e ignora descanso que mudou', async () => {
    await addRoutine(routine('r1'));
    const s = await startSession('r1', 'r1-A');
    const rest = startRest(60, 1_000, { nextLabel: 'x', exerciseId: s.exercises[0].id, setId: s.exercises[0].sets[0].id });
    await saveSession({ ...s, rest });
    expect(await markRestNotified(s.id, rest.endsAt + 1)).toBe(false);
    expect(await markRestNotified(s.id, rest.endsAt)).toBe(true);
    expect(await markRestNotified(s.id, rest.endsAt)).toBe(false);
    expect((await db.sessions.get(s.id))?.rest?.notified).toBe(true);
  });

  it('importBodyEvaluations grava só meses novos e preserva as avaliações existentes', async () => {
    await db.bodyEntries.put(entry('b1', { date: '2030-01-05', weightKg: 80 }));
    const ev = (date: string, weightKg: number): ParsedEvaluation => ({ date, values: { weightKg }, skinfolds: {}, circumferences: {} });
    const r = await importBodyEvaluations([ev('2030-01-10', 81), ev('2030-02-12', 82)], 5);
    expect(r.fresh.map((e) => e.date)).toEqual(['2030-02-12']);
    expect(r.skipped.map((e) => e.date)).toEqual(['2030-01-10']);
    const all = await db.bodyEntries.orderBy('date').toArray();
    expect(all.map((e) => [e.date, e.weightKg, e.source])).toEqual([
      ['2030-01-05', 80, 'manual'],
      ['2030-02-12', 82, 'pdf'],
    ]);
    expect(all.every((e) => e.profileId === db.currentProfileId)).toBe(true);
  });

  it('clearLocalData apaga todos os dados, mas mantém o perfil local', async () => {
    const before = await getCurrentProfile();
    await saveSettings({ userName: 'Teste' });
    await addRoutine(routine('r1'));
    await saveBodyEntryWithPhotos(entry('b1'), [PHOTO]);
    await clearLocalData();
    for (const t of [db.settings, db.routines, db.sessions, db.rotations, db.overrides, db.bodyEntries, db.photos]) expect(await t.count()).toBe(0);
    expect(await getCurrentProfile()).toEqual(before);
  });
});
