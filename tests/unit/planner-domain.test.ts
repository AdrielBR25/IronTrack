// Planejamento semanal (IronTrack 2.0 F01/P13): calendário, recorrência, exceções, vigência, associação planejado ×
// realizado, consistência e metas semanais. Domínio puro, sem banco. Dados fictícios.
import { afterEach, describe, expect, it } from 'vitest';
import {
  PlanConflictError,
  addActivity,
  buildWeek,
  clearException,
  compareWeeks,
  isValidPlanEntry,
  matchDay,
  planEntryIssues,
  planForDate,
  planWeekday,
  removeEntry,
  sessionDay,
  setMarker,
  shiftWeek,
  slotFingerprint,
  updateActivity,
  weekDates,
  weekOf,
  weeklyGoalsForWeek,
  type PlanContext,
  type PlanEntry,
} from '@/modules/planner';
import type { TrainingGoal } from '@/modules/goals';
import { routine, session } from './fixtures';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

/** Instante local (fuso do processo) de uma data, numa hora do dia. */
const at = (date: string, hour = 10) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, hour).getTime();
};

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function ctx(today: string, now = at(today, 8)): PlanContext {
  let n = 0;
  return { today, now, newId: () => `gen-${today}-${++n}` };
}

/** Aplica as mudanças de uma regra (como faria a persistência). */
function apply(all: PlanEntry[], ch: { put: PlanEntry[]; delete: string[] }): PlanEntry[] {
  const map = new Map(all.map((e) => [e.id, e]));
  for (const id of ch.delete) map.delete(id);
  for (const e of ch.put) map.set(e.id, { ...e, profileId: e.profileId ?? PID });
  return [...map.values()];
}

const R = routine('r1');
const R2 = routine('r2', { name: 'Cardio' });
const MON = '2026-10-26';
const WED = '2026-10-28';

function weekly(all: PlanEntry[], id: string, weekday: number, workoutId: string | null, c: PlanContext, routineId = 'r1') {
  return apply(all, addActivity(all, { id, slot: { scope: 'weekly', weekday }, activity: { routineId, workoutId } }, c));
}

describe('calendário', () => {
  it('semana de segunda a domingo; anterior e próxima', () => {
    expect(weekOf('2026-10-28')).toBe('2026-10-26');
    expect(weekOf('2026-11-01')).toBe('2026-10-26'); // domingo pertence à semana que começou na segunda
    expect(weekOf('2026-10-26')).toBe('2026-10-26');
    expect(weekDates('2026-10-26')).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    expect(shiftWeek('2026-10-26', -1)).toBe('2026-10-19');
    expect(shiftWeek('2026-10-26', 1)).toBe('2026-11-02');
  });

  it('virada de mês e de ano', () => {
    expect(weekDates(weekOf('2026-12-31'))).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
    expect(weekOf('2027-01-01')).toBe('2026-12-28');
    expect(shiftWeek('2026-12-28', 1)).toBe('2027-01-04');
    expect(weekDates(weekOf('2028-02-29'))[0]).toBe('2028-02-28'); // ano bissexto
  });

  it('dia da semana sem depender do fuso e com horário de verão', () => {
    expect(planWeekday('2026-10-26')).toBe(1);
    expect(planWeekday('2026-11-01')).toBe(0);
    for (const tz of ['America/Sao_Paulo', 'Asia/Tokyo', 'Pacific/Auckland', 'America/New_York']) {
      process.env.TZ = tz;
      expect(planWeekday('2026-03-08')).toBe(0); // início do horário de verão nos EUA
      expect(weekDates('2026-11-02')).toHaveLength(7);
      expect(new Set(weekDates(weekOf('2018-11-04')))).toContain('2018-11-04'); // horário de verão de 2018 no Brasil (meia-noite inexistente)
    }
  });

  it('fuso: o dia de uma sessão é o do calendário local do aparelho', () => {
    const ts = Date.UTC(2026, 9, 28, 1, 30); // 01:30 UTC de quarta
    process.env.TZ = 'America/Sao_Paulo';
    expect(sessionDay(ts)).toBe('2026-10-27'); // ainda terça em São Paulo
    process.env.TZ = 'Asia/Tokyo';
    expect(sessionDay(ts)).toBe('2026-10-28');
  });
});

describe('validação', () => {
  it('aceita entradas bem formadas e recusa campos incoerentes', () => {
    const c = ctx(WED);
    const [e] = weekly([], 'w1', 1, 'r1-A', c);
    expect(isValidPlanEntry(e)).toBe(true);
    expect(planEntryIssues({ ...e, weekday: 7 }).map((i) => i.field)).toContain('weekday');
    expect(planEntryIssues({ ...e, kind: 'rest' }).map((i) => i.field)).toContain('routineId');
    expect(planEntryIssues({ ...e, scope: 'date' }).length).toBeGreaterThan(0);
    expect(planEntryIssues({ ...e, validUntil: '2026-10-01' }).map((i) => i.field)).toContain('validUntil');
    expect(planEntryIssues({ ...e, revision: 0 }).map((i) => i.field)).toContain('revision');
    expect(planEntryIssues(null)).toHaveLength(1);
  });
});

describe('modelo recorrente', () => {
  it('cria atividades por dia da semana, várias no mesmo dia, e dias sem treino', () => {
    const c = ctx(MON);
    let all = weekly([], 'seg-a', 1, 'r1-A', c);
    all = weekly(all, 'seg-cardio', 1, null, c, 'r2');
    all = weekly(all, 'ter-b', 2, 'r1-B', c);
    expect(planForDate(all, MON).entries.map((e) => e.id)).toEqual(['seg-a', 'seg-cardio']);
    expect(planForDate(all, '2026-11-02').entries).toHaveLength(2); // toda segunda
    expect(planForDate(all, '2026-10-28')).toEqual({ source: 'none', entries: [] });
  });

  it('mesma atividade repetida no dia é recusada; repetir o mesmo envio (mesmo ID) não duplica', () => {
    const c = ctx(MON);
    const all = weekly([], 'seg-a', 1, 'r1-A', c);
    expect(() => addActivity(all, { id: 'outro', slot: { scope: 'weekly', weekday: 1 }, activity: { routineId: 'r1', workoutId: 'r1-A' } }, c)).toThrow(PlanConflictError);
    const again = addActivity(all, { id: 'seg-a', slot: { scope: 'weekly', weekday: 1 }, activity: { routineId: 'r1', workoutId: 'r1-A' } }, c);
    expect(again.put).toEqual([]);
    expect(() => addActivity(all, { id: 'seg-a', slot: { scope: 'weekly', weekday: 2 }, activity: { routineId: 'r1', workoutId: 'r1-B' } }, c)).toThrow(/identificador/);
  });

  it('alterar o modelo não muda o passado: a versão antiga termina ontem e a nova vale de hoje em diante', () => {
    let all = weekly([], 'seg-a', 1, 'r1-A', ctx('2026-10-12'));
    const cur = all[0];
    const ch = updateActivity(all, { id: 'seg-a', expectedRevision: cur.revision, activity: { routineId: 'r1', workoutId: 'r1-B' } }, ctx(WED));
    all = apply(all, ch);
    expect(all.find((e) => e.id === 'seg-a')).toMatchObject({ validUntil: '2026-10-27', workoutId: 'r1-A', revision: 2 });
    expect(ch.result).toMatchObject({ workoutId: 'r1-B', validFrom: WED, revision: 1 });
    expect(planForDate(all, MON).entries[0].workoutId).toBe('r1-A'); // segunda passada: o que estava planejado
    expect(planForDate(all, '2026-11-02').entries[0].workoutId).toBe('r1-B');
    expect(planForDate(all, '2026-10-05').source).toBe('none'); // antes de existir
  });

  it('entrada criada hoje é alterada no lugar (sem versões desnecessárias); remover a de hoje apaga', () => {
    const c = ctx(WED);
    let all = weekly([], 'qua', 3, 'r1-A', c);
    const ch = updateActivity(all, { id: 'qua', expectedRevision: 1, activity: { routineId: 'r1', workoutId: 'r1-C' } }, c);
    all = apply(all, ch);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 'qua', workoutId: 'r1-C', revision: 2 });
    all = apply(all, removeEntry(all, { id: 'qua', expectedRevision: 2 }, c));
    expect(all).toEqual([]);
  });

  it('remover uma entrada antiga encerra a vigência; remover de novo (outra aba) não é erro', () => {
    let all = weekly([], 'seg-a', 1, 'r1-A', ctx('2026-10-12'));
    all = apply(all, removeEntry(all, { id: 'seg-a', expectedRevision: 1 }, ctx(WED)));
    expect(all[0].validUntil).toBe('2026-10-27');
    expect(planForDate(all, MON).entries).toHaveLength(1);
    expect(planForDate(all, '2026-11-02').source).toBe('none');
    expect(removeEntry(all, { id: 'seg-a', expectedRevision: 2 }, ctx(WED))).toEqual({ put: [], delete: [], result: null });
  });

  it('mudar de dia e pausar/retomar', () => {
    const c = ctx(WED);
    let all = weekly([], 'x', 4, 'r1-A', c);
    all = apply(all, updateActivity(all, { id: 'x', expectedRevision: 1, moveTo: { scope: 'weekly', weekday: 5 } }, c));
    expect(planForDate(all, '2026-10-29').source).toBe('none');
    expect(planForDate(all, '2026-10-30').entries[0].id).toBe('x');
    all = apply(all, updateActivity(all, { id: 'x', expectedRevision: 2, enabled: false }, c));
    expect(planForDate(all, '2026-10-30').source).toBe('none'); // pausada: não vale, mas continua guardada
    expect(all).toHaveLength(1);
  });

  it('revisão desatualizada (outra aba) é recusada sem gravar', () => {
    const c = ctx(WED);
    let all = weekly([], 'x', 4, 'r1-A', c);
    all = apply(all, updateActivity(all, { id: 'x', expectedRevision: 1, activity: { routineId: 'r1', workoutId: 'r1-B' } }, c));
    expect(() => updateActivity(all, { id: 'x', expectedRevision: 1, activity: { routineId: 'r1', workoutId: 'r1-C' } }, c)).toThrow(/outra aba/);
    expect(() => removeEntry(all, { id: 'x', expectedRevision: 1 }, c)).toThrow(PlanConflictError);
  });

  it('descanso e dia livre substituem as atividades do lugar; adicionar treino tira o descanso', () => {
    const c = ctx(WED);
    let all = weekly([], 'x', 6, 'r1-A', c);
    all = apply(all, setMarker(all, { id: 'rest', slot: { scope: 'weekly', weekday: 6 }, kind: 'rest' }, c));
    expect(planForDate(all, '2026-10-31').entries.map((e) => e.kind)).toEqual(['rest']);
    expect(setMarker(all, { id: 'rest2', slot: { scope: 'weekly', weekday: 6 }, kind: 'rest' }, c).put).toEqual([]); // idempotente
    all = weekly(all, 'y', 6, 'r1-B', c);
    expect(planForDate(all, '2026-10-31').entries.map((e) => e.id)).toEqual(['y']);
  });
});

describe('exceções de data', () => {
  const base = () => {
    const c = ctx('2026-10-12');
    let all = weekly([], 'seg-a', 1, 'r1-A', c);
    all = weekly(all, 'qua-c', 3, 'r1-C', c);
    return all;
  };

  it('"nesta segunda: descanso" não muda o modelo; as outras segundas continuam', () => {
    let all = base();
    const c = ctx(WED);
    all = apply(all, setMarker(all, { id: 'desc', slot: { scope: 'date', date: '2026-11-02' }, kind: 'rest' }, c));
    expect(planForDate(all, '2026-11-02')).toMatchObject({ source: 'exception', entries: [{ kind: 'rest' }] });
    expect(planForDate(all, '2026-11-09').entries[0].id).toBe('seg-a');
    expect(all.find((e) => e.id === 'seg-a')).toMatchObject({ revision: 1, validUntil: null });
  });

  it('"próxima quarta: B no lugar de C" (só naquele dia) e exceção tem prioridade', () => {
    let all = base();
    const c = ctx(WED);
    const fp = slotFingerprint(all, { scope: 'date', date: '2026-11-04' }, WED);
    const ch = updateActivity(all, { id: 'qua-c', expectedRevision: 1, onDate: '2026-11-04', expected: fp, activity: { routineId: 'r1', workoutId: 'r1-B' } }, c);
    all = apply(all, ch);
    expect(planForDate(all, '2026-11-04').entries.map((e) => e.workoutId)).toEqual(['r1-B']);
    expect(planForDate(all, '2026-11-11').entries.map((e) => e.workoutId)).toEqual(['r1-C']);
    // A cópia guarda a origem e só existe para aquela data (nada é gerado para o futuro).
    expect(all.filter((e) => e.scope === 'date')).toHaveLength(1);
  });

  it('acrescentar uma atividade só numa data mantém as do modelo naquele dia', () => {
    let all = base();
    all = apply(all, addActivity(all, { id: 'extra', slot: { scope: 'date', date: '2026-11-02' }, activity: { routineId: 'r2', workoutId: null } }, ctx(WED)));
    const day = planForDate(all, '2026-11-02');
    expect(day.source).toBe('exception');
    expect(day.entries.map((e) => [e.routineId, e.sourceEntryId ?? null])).toEqual([
      ['r1', 'seg-a'],
      ['r2', null],
    ]);
  });

  it('remover a última atividade de uma data vira "dia livre" (não volta ao modelo sem pedir)', () => {
    let all = base();
    const fp = slotFingerprint(all, { scope: 'date', date: '2026-11-02' }, WED);
    all = apply(all, removeEntry(all, { id: 'seg-a', expectedRevision: 1, onDate: '2026-11-02', expected: fp }, ctx(WED)));
    expect(planForDate(all, '2026-11-02').entries.map((e) => e.kind)).toEqual(['free']);
    expect(planForDate(all, '2026-11-09').entries[0].id).toBe('seg-a');
    all = apply(all, clearException(all, { date: '2026-11-02' }, ctx(WED)));
    expect(planForDate(all, '2026-11-02').entries[0].id).toBe('seg-a');
  });

  it('dias passados não mudam', () => {
    const all = base();
    expect(() => setMarker(all, { id: 'x', slot: { scope: 'date', date: MON }, kind: 'rest' }, ctx(WED))).toThrow(/passados/);
    expect(() => addActivity(all, { id: 'x', slot: { scope: 'date', date: MON }, activity: { routineId: 'r1', workoutId: 'r1-B' } }, ctx(WED))).toThrow(PlanConflictError);
    expect(() => clearException(all, { date: MON }, ctx(WED))).toThrow(PlanConflictError);
  });

  it('impressão digital do dia detecta alteração concorrente (exceção criada em outra aba)', () => {
    let all = base();
    const fp = slotFingerprint(all, { scope: 'date', date: '2026-11-02' }, WED);
    all = apply(all, setMarker(all, { id: 'desc', slot: { scope: 'date', date: '2026-11-02' }, kind: 'rest' }, ctx(WED)));
    expect(() => addActivity(all, { id: 'n', slot: { scope: 'date', date: '2026-11-02' }, activity: { routineId: 'r1', workoutId: 'r1-B' }, expected: fp }, ctx(WED))).toThrow(/outra aba/);
    // Alteração no modelo também muda a impressão digital da data que depende dele.
    const all2 = base();
    const fp2 = slotFingerprint(all2, { scope: 'date', date: '2026-11-02' }, WED);
    const changed = apply(all2, updateActivity(all2, { id: 'seg-a', expectedRevision: 1, activity: { routineId: 'r1', workoutId: 'r1-B' } }, ctx(WED)));
    expect(slotFingerprint(changed, { scope: 'date', date: '2026-11-02' }, WED)).not.toBe(fp2);
  });

  it('mover uma exceção para outra data', () => {
    let all = base();
    all = apply(all, addActivity(all, { id: 'cardio', slot: { scope: 'date', date: '2026-10-30' }, activity: { routineId: 'r2', workoutId: null } }, ctx(WED)));
    all = apply(all, updateActivity(all, { id: 'cardio', expectedRevision: 1, moveTo: { scope: 'date', date: '2026-10-31' } }, ctx(WED)));
    expect(planForDate(all, '2026-10-31').entries.map((e) => e.id)).toEqual(['cardio']);
    expect(planForDate(all, '2026-10-30').entries.map((e) => e.kind)).toEqual(['free']);
  });
});

describe('planejado × realizado', () => {
  const plan = () => {
    const c = ctx('2026-10-12');
    let all = weekly([], 'seg-a', 1, 'r1-A', c);
    all = weekly(all, 'seg-cardio', 1, null, c, 'r2');
    all = weekly(all, 'ter-b', 2, 'r1-B', c);
    all = weekly(all, 'qui-c', 4, 'r1-C', c);
    all = apply(all, setMarker(all, { id: 'qua-desc', slot: { scope: 'weekly', weekday: 3 }, kind: 'rest' }, c));
    return all;
  };
  const s = (id: string, date: string, workoutId: string, over = {}) =>
    session(id, { profileId: PID, routineId: workoutId.split('-')[0], workoutId, workoutLabel: workoutId.slice(-1), startedAt: at(date), ...over });
  const build = (sessions: ReturnType<typeof s>[], today = WED, week = MON) => buildWeek({ entries: plan(), sessions, routines: [R, R2], week, today, profileId: PID });

  it('estados: concluído, parcial, planejado, sem plano e futuro (nunca "falhou")', () => {
    const w = build([s('s1', MON, 'r1-A'), s('s2', '2026-10-27', 'r1-B')]);
    const st = Object.fromEntries(w.days.map((d) => [d.date, d.state]));
    expect(st).toMatchObject({ '2026-10-26': 'parcial', '2026-10-27': 'concluido', '2026-10-28': 'sem_plano', '2026-10-29': 'futuro' });
    expect(w.days[2].marker).toBe('rest');
    const w2 = build([]);
    expect(w2.days[0].state).toBe('planejado');
    expect(w2.days[0].activities.map((a) => a.status)).toEqual(['nao_registrada', 'nao_registrada']);
    expect(JSON.stringify(w2)).not.toMatch(/falh|fracass/);
  });

  it('associa por IDs (rotina e treino), nunca por nome; cada sessão conta uma vez', () => {
    const sameName = s('nome', MON, 'r2-A', { workoutName: 'Treino A', workoutLabel: 'A' }); // mesmo nome, outra rotina
    const w = build([sameName]);
    const mon = w.days[0];
    expect(mon.activities.find((a) => a.entry.id === 'seg-a')!.sessionId).toBeNull();
    expect(mon.activities.find((a) => a.entry.id === 'seg-cardio')!.sessionId).toBe('nome'); // segue a rotação de r2
    const twice = build([s('a1', MON, 'r1-A'), s('a2', MON, 'r1-A', { startedAt: at(MON, 18) })]);
    expect(twice.days[0].activities.find((a) => a.entry.id === 'seg-a')!.sessionId).toBe('a1');
    expect(twice.days[0].sessions.find((x) => x.session.id === 'a2')!.entryId).toBeNull(); // extra, não conta duas vezes
    expect(twice.consistency).toMatchObject({ sessionsCompleted: 2, extraSessions: 1, realized: 1 });
  });

  it('específico tem prioridade sobre "próximo da rotação" da mesma rotina', () => {
    const entries: PlanEntry[] = [];
    const c = ctx('2026-10-12');
    let all = weekly(entries, 'gen', 1, null, c);
    all = weekly(all, 'spec', 1, 'r1-B', c);
    const m = matchDay(all, [s('b', MON, 'r1-B'), s('a', MON, 'r1-A', { startedAt: at(MON, 7) })]);
    expect(m.get('spec')).toBe('b');
    expect(m.get('gen')).toBe('a');
  });

  it('em andamento e descartadas não contam; outro perfil e duplicadas também não', () => {
    const w = build([
      s('ativa', '2026-10-27', 'r1-B', { status: 'active' }),
      s('desc', MON, 'r1-A', { status: 'discarded' }),
      s('outro', MON, 'r1-A', { profileId: OTHER }),
      s('dup1', '2026-10-27', 'r1-A'),
      s('dup2', '2026-10-27', 'r1-A', { startedAt: at('2026-10-27') }), // mesmo início e treino: repetida
    ]);
    expect(w.days[0].sessions).toEqual([]);
    expect(w.days[1].active?.id).toBe('ativa');
    expect(w.days[1].activities[0].status).toBe('em_andamento');
    expect(w.days[1].sessions).toHaveLength(1);
    expect(w.consistency.sessionsCompleted).toBe(1);
  });

  it('sessão fora do dia planejado aparece no dia em que ocorreu, sem mover nada', () => {
    const w = build([s('quarta', WED, 'r1-A')]); // A era de segunda
    expect(w.days[0].activities[0].sessionId).toBeNull();
    expect(w.days[2].sessions.map((x) => [x.session.id, x.entryId])).toEqual([['quarta', null]]);
    expect(w.days[2].state).toBe('sem_plano');
  });

  it('dias futuros: atividades "planejadas", sem contar como devidas', () => {
    const w = build([], MON);
    expect(w.days[1].state).toBe('futuro');
    expect(w.days[1].activities[0].status).toBe('futura');
    expect(w.days[0].activities[0].status).toBe('pendente');
    expect(w.consistency.plannedDue).toBe(2);
    expect(w.consistency.plannedActivities).toBe(4);
  });

  it('rotina excluída e treino removido continuam visíveis, com aviso', () => {
    const w = buildWeek({ entries: plan(), sessions: [], routines: [{ ...R, workouts: R.workouts.filter((x) => x.id !== 'r1-B') }], week: MON, today: WED, profileId: PID });
    expect(w.days[0].activities.find((a) => a.entry.id === 'seg-cardio')!.availability).toBe('routine_missing');
    expect(w.days[1].activities[0].availability).toBe('workout_missing');
  });
});

describe('consistência', () => {
  const s = (id: string, date: string, workoutId = 'r1-A') => session(id, { profileId: PID, workoutId, startedAt: at(date) });

  it('sem planejamento: nenhuma porcentagem inventada (null, não 0%)', () => {
    const w = buildWeek({ entries: [], sessions: [s('x', MON)], routines: [R], week: MON, today: WED, profileId: PID });
    expect(w.consistency).toMatchObject({ plannedActivities: 0, plannedDue: 0, adherence: null, sessionsCompleted: 1, extraSessions: 1, daysWithTraining: 1 });
  });

  it('distingue sessões de dias; extras não reduzem a aderência; compara com a semana anterior', () => {
    const entries = weekly([], 'seg', 1, 'r1-A', ctx('2026-10-01'));
    const sessions = [s('a', MON), s('b', MON, 'r1-B'), s('c', '2026-10-27'), s('p', '2026-10-19')];
    const cur = buildWeek({ entries, sessions, routines: [R], week: MON, today: WED, profileId: PID }).consistency;
    expect(cur).toMatchObject({ sessionsCompleted: 3, daysWithTraining: 2, plannedDue: 1, realized: 1, adherence: 1, extraSessions: 2 });
    const prev = buildWeek({ entries, sessions, routines: [R], week: '2026-10-19', today: WED, profileId: PID }).consistency;
    expect(prev).toMatchObject({ sessionsCompleted: 1, realized: 1, closed: true });
    expect(compareWeeks(cur, prev)).toEqual({ sessionsDelta: 2, daysDelta: 1 });
  });

  it('dados insuficientes: semana vazia e sem plano', () => {
    const w = buildWeek({ entries: [], sessions: [], routines: [], week: MON, today: WED, profileId: PID });
    expect(w.consistency).toMatchObject({ sessionsCompleted: 0, daysWithTraining: 0, plannedActivities: 0, adherence: null, extraSessions: 0 });
    expect(w.days.every((d) => d.state === 'sem_plano' || d.state === 'futuro')).toBe(true);
  });
});

describe('metas semanais (motor do P12)', () => {
  const goal: TrainingGoal = {
    id: 'g1',
    profileId: PID,
    type: 'weekly_frequency',
    title: '3x por semana',
    exercise: null,
    targetValue: 3,
    unit: 'sessoes_semana',
    period: 'semanal',
    params: {},
    startDate: '2026-10-01',
    targetDate: null,
    status: 'active',
    pauses: [],
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
  };
  const s = (id: string, date: string) => session(id, { profileId: PID, startedAt: at(date) });

  it('usa a avaliação do motor de metas para a semana exibida e as anteriores', () => {
    const sessions = [s('a', MON), s('b', '2026-10-27'), s('c', '2026-10-20'), s('d', '2026-10-21'), s('e', '2026-10-22')];
    const [v] = weeklyGoalsForWeek([goal], sessions, WED, WED);
    expect(v.week).toMatchObject({ week: MON, count: 2, met: false, current: true });
    expect(v.history.at(-1)).toMatchObject({ week: '2026-10-19', count: 3, met: true });
    const [past] = weeklyGoalsForWeek([goal], sessions, '2026-10-19', WED);
    expect(past.week).toMatchObject({ count: 3, met: true });
    const [future] = weeklyGoalsForWeek([goal], sessions, '2026-11-02', WED);
    expect(future.week).toBeNull();
  });

  it('metas de outros tipos e arquivadas ficam de fora', () => {
    expect(weeklyGoalsForWeek([{ ...goal, status: 'archived' }, { ...goal, id: 'g2', type: 'session_count' }], [], WED, WED)).toEqual([]);
  });
});
