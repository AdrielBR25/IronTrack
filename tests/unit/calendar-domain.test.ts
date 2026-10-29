// Calendário unificado (IronTrack 2.0 F01/P14): precedência, conflitos, agenda anterior, previsão da rotação,
// sessões reais, semana, mês, viradas, fusos e horário de verão. Domínio puro, sem banco. Dados fictícios.
import { afterEach, describe, expect, it } from 'vitest';
import {
  FORECAST_HORIZON_DAYS,
  monthBounds,
  nextActivity,
  primaryEntries,
  resolveDay,
  resolveMonth,
  resolveRange,
  resolveWeek,
  rotationStatus,
  shiftMonth,
  type CalendarInput,
  type LegacySchedule,
} from '@/modules/calendar';
import { buildWeek, type PlanEntry } from '@/modules/planner';
import { projectSchedule, type RotationState, type WorkoutSession } from '@/modules/training';
import { routine, session } from './fixtures';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WED = '2026-10-28'; // hoje nos testes (quarta-feira)
const THU = '2026-10-29';
const FRI = '2026-10-30';
const SAT = '2026-10-31';
const MON = '2026-11-02';
const NEXT_WED = '2026-11-04';

/** Instante local (fuso do processo) de uma data, numa hora do dia. */
const at = (date: string, hour = 10, minute = 0) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute).getTime();
};

let seq = 0;
function weekly(weekday: number, workoutId: string | null, over: Partial<PlanEntry> = {}): PlanEntry {
  seq += 1;
  return {
    id: `w${seq}`,
    profileId: PID,
    scope: 'weekly',
    weekday,
    date: null,
    kind: 'workout',
    routineId: 'r1',
    workoutId,
    enabled: true,
    validFrom: '2026-01-05',
    validUntil: null,
    createdAt: seq,
    updatedAt: seq,
    revision: 1,
    ...over,
  };
}
function exception(date: string, kind: PlanEntry['kind'], workoutId: string | null = null, over: Partial<PlanEntry> = {}): PlanEntry {
  return weekly(0, workoutId, { scope: 'date', weekday: null, date, kind, routineId: kind === 'workout' ? 'r1' : null, workoutId: kind === 'workout' ? workoutId : null, validFrom: null, ...over });
}
const done = (id: string, date: string, workout: 'A' | 'B' | 'C', over: Partial<WorkoutSession> = {}) =>
  session(id, { profileId: PID, workoutId: `r1-${workout}`, workoutLabel: workout, workoutName: `Treino ${workout}`, startedAt: at(date), finishedAt: at(date, 11), ...over });

const R1 = routine('r1');
const LEGACY: LegacySchedule = { routineId: 'r1', trainingDays: [1, 3, 5], overrides: [] };

function input(over: Partial<CalendarInput> = {}): CalendarInput {
  return { today: WED, profileId: PID, entries: [], sessions: [], routines: [R1], rotations: [{ routineId: 'r1', nextIndex: 0, updatedAt: 0 }], legacy: LEGACY, ...over };
}

const deepFreeze = <T,>(o: T): T => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
};

describe('agenda anterior (dias de treino + reagendamentos)', () => {
  it('sem planejamento, a agenda anterior aparece como sugestão, igual à projeção que a Início sempre usou', () => {
    const days = resolveRange(input(), WED, MON);
    const legacy = projectSchedule({ order: ['r1-A', 'r1-B', 'r1-C'], nextIndex: 0, trainingDays: [1, 3, 5], overrides: new Map(), doneByDate: new Map(), start: WED, days: 6 });
    expect(days.map((d) => d.legacy?.workoutId ?? null)).toEqual(legacy.map((p) => (p.kind === 'workout' ? p.workoutId : null)));
    const [wed, thu, fri] = days;
    expect(wed.origin).toBe('legacy');
    expect(wed.status).toBe('suggested');
    expect(wed.legacy).toMatchObject({ workoutId: 'r1-A', certainty: 'current', source: 'rotation' });
    expect(fri.legacy).toMatchObject({ workoutId: 'r1-B', certainty: 'forecast' });
    expect(thu.status).toBe('rest');
    expect(thu.entries[0]).toMatchObject({ origin: 'legacy_off', kind: 'rest', shadowed: false });
    expect(primaryEntries(wed)[0]).toMatchObject({ origin: 'legacy_rotation', state: 'Sugestão da agenda anterior', certainty: 'current' });
  });

  it('reagendamento da agenda anterior é explícito e muda a sequência projetada', () => {
    const legacy = { ...LEGACY, overrides: [{ routineId: 'r1', date: FRI, kind: 'workout' as const, workoutId: 'r1-C' }] };
    const [, , fri, , , mon] = resolveRange(input({ legacy }), WED, MON);
    expect(fri.legacy).toMatchObject({ source: 'override', workoutId: 'r1-C', certainty: 'explicit' });
    expect(fri.entries[0].state).toBe('Reagendado na agenda anterior');
    expect(mon.legacy?.workoutId).toBe('r1-A'); // continua a partir do C reagendado
  });

  it('além do horizonte da previsão o treino exato fica a definir; dias passados não inventam treino', () => {
    const far = resolveDay(input(), '2026-11-13'); // sexta, 16 dias depois
    expect(far.legacy).toMatchObject({ kind: 'workout', workoutId: null, certainty: 'undetermined' });
    const past = resolveDay(input(), '2026-10-26');
    expect(past.legacy).toMatchObject({ kind: 'workout', workoutId: null, certainty: 'suggestion' });
    expect(past.status).toBe('empty');
    expect(past.entries[0].shadowed).toBe(true);
  });

  it('sem rotina ativa com treinos não há agenda anterior', () => {
    expect(resolveDay(input({ legacy: null }), WED)).toMatchObject({ legacy: null, origin: 'none', status: 'empty', entries: [] });
    expect(resolveDay(input({ routines: [routine('r1', { workouts: [] })] }), WED).legacy).toBeNull();
  });
});

describe('planejamento explícito e precedência', () => {
  it('planejamento recorrente define o dia; a agenda anterior continua visível (sombreada) e a divergência vira aviso', () => {
    const d = resolveDay(input({ entries: [weekly(3, 'r1-B')] }), WED);
    expect(d.origin).toBe('plan_recurring');
    expect(d.status).toBe('planned');
    const primary = primaryEntries(d);
    expect(primary).toHaveLength(1);
    expect(primary[0]).toMatchObject({ origin: 'plan_recurring', workoutId: 'r1-B', certainty: 'explicit', conflict: true });
    expect(d.entries.find((e) => e.origin === 'legacy_rotation')).toMatchObject({ shadowed: true, workoutId: 'r1-A', state: 'Agenda anterior (não define o dia)' });
    const c = d.conflicts.find((x) => x.kind === 'plan_vs_legacy_workout')!;
    expect(c.severity).toBe('warning');
    expect(c.message).toBe('Seu planejamento indica Treino B (Treino B), mas a agenda anterior sugere Treino A (Treino A).');
    expect(d.conflicts.find((x) => x.kind === 'rotation_differs')?.severity).toBe('info');
    expect(d.hasWarning).toBe(true);
  });

  it('recorrência vale toda semana; exceção substitui só aquela data e é explicada', () => {
    const entries = [weekly(3, 'r1-B'), exception(NEXT_WED, 'rest')];
    const [wed, nextWed, wedAfter] = [WED, NEXT_WED, '2026-11-11'].map((d) => resolveDay(input({ entries }), d));
    expect(wed.plan.activities[0].entry.workoutId).toBe('r1-B');
    expect(wedAfter.plan.activities[0].entry.workoutId).toBe('r1-B');
    expect(nextWed.origin).toBe('plan_exception');
    expect(nextWed.status).toBe('rest');
    expect(nextWed.conflicts.map((c) => c.kind).sort()).toEqual(['exception_replaces_recurring', 'plan_rest_vs_legacy_workout']);
    expect(nextWed.conflicts.find((c) => c.kind === 'exception_replaces_recurring')).toMatchObject({ severity: 'info', message: 'Só neste dia: descanso. O planejamento semanal indicaria Treino B (Treino B).' });
    expect(nextWed.conflicts.find((c) => c.kind === 'plan_rest_vs_legacy_workout')?.severity).toBe('warning');
  });

  it('planejamento igual à agenda anterior não gera aviso', () => {
    const d = resolveDay(input({ entries: [weekly(3, 'r1-A')] }), WED);
    expect(d.conflicts).toEqual([]);
    expect(d.hasWarning).toBe(false);
  });

  it('treino planejado num dia de descanso: reagendamento de descanso é aviso; dia fora das Configurações é informação', () => {
    const legacy = { ...LEGACY, overrides: [{ routineId: 'r1', date: FRI, kind: 'rest' as const }] };
    const entries = [weekly(5, 'r1-C'), weekly(6, 'r1-A')];
    const fri = resolveDay(input({ entries, legacy }), FRI);
    expect(fri.conflicts[0]).toMatchObject({ kind: 'plan_workout_vs_legacy_rest', severity: 'warning' });
    const sat = resolveDay(input({ entries, legacy }), SAT);
    expect(sat.conflicts[0]).toMatchObject({ kind: 'plan_workout_vs_legacy_rest', severity: 'info' });
    expect(sat.hasWarning).toBe(false);
  });

  it('comparar com uma previsão da agenda anterior é só informação; "seguir a rotação" dos dois lados não é conflito', () => {
    const fri = resolveDay(input({ entries: [weekly(5, 'r1-C')] }), FRI);
    expect(fri.conflicts[0]).toMatchObject({ kind: 'plan_vs_legacy_workout', severity: 'info' });
    expect(fri.conflicts[0].message).toContain('pela previsão da rotação');
    const rot = resolveDay(input({ entries: [weekly(5, null)] }), FRI);
    expect(rot.conflicts).toEqual([]);
  });

  it('descanso e dia livre planejados; dia sem nada', () => {
    const entries = [weekly(4, null, { kind: 'rest', routineId: null }), weekly(6, null, { kind: 'free', routineId: null })];
    const days = resolveRange(input({ entries, legacy: null }), THU, SAT);
    expect(days.map((d) => d.status)).toEqual(['rest', 'empty', 'free']);
    expect(days[0].entries[0]).toMatchObject({ kind: 'rest', state: 'Descanso planejado', certainty: 'explicit' });
    expect(days[2].entries[0]).toMatchObject({ kind: 'free', state: 'Dia livre' });
  });

  it('dia passado planejado sem registro: "Sem registro", sem comparar com a agenda anterior', () => {
    const d = resolveDay(input({ entries: [weekly(1, 'r1-C')] }), '2026-10-26');
    expect(d.status).toBe('not_recorded');
    expect(d.conflicts).toEqual([]);
  });
});

describe('previsão da rotação', () => {
  const rotating = () => [weekly(1, null), weekly(3, null), weekly(5, null)];

  it('a primeira ocorrência usa o ponteiro atual; as seguintes são simulação identificada como previsão', () => {
    const days = resolveRange(input({ entries: rotating() }), WED, '2026-11-06');
    const f = (date: string) => Object.values(days.find((d) => d.date === date)!.forecasts)[0];
    expect(f(WED)).toMatchObject({ workoutLabel: 'A', certainty: 'current' });
    expect(f(FRI)).toMatchObject({ workoutLabel: 'B', certainty: 'forecast' });
    expect(f(MON)).toMatchObject({ workoutLabel: 'C', certainty: 'forecast' });
    expect(f(NEXT_WED)).toMatchObject({ workoutLabel: 'A', certainty: 'forecast' });
    // O texto da linha mostra o treino previsto (não repete o ponteiro em todos os dias, como no P13).
    expect(primaryEntries(days[2])[0]).toMatchObject({ workoutLabel: 'B', certainty: 'forecast', followsRotation: true });
  });

  it('treino específico planejado antes faz a previsão continuar a partir dele', () => {
    const entries = [...rotating(), weekly(4, 'r1-B')];
    const fri = resolveDay(input({ entries }), FRI);
    // qua A (atual) → qui B (específico) → sex continua depois do B: C
    expect(Object.values(fri.forecasts)[0]).toMatchObject({ workoutLabel: 'C', certainty: 'forecast' });
  });

  it('treino em andamento conta como se fosse concluído e a previsão deixa de ser "atual"', () => {
    const active = done('ativo', WED, 'A', { status: 'active', finishedAt: undefined });
    const days = resolveRange(input({ entries: rotating(), sessions: [active] }), WED, FRI);
    expect(days[0].plan.activities[0].status).toBe('em_andamento');
    expect(days[0].status).toBe('in_progress');
    expect(days[0].entries.find((e) => e.origin === 'active_session')?.state).toContain('Em andamento');
    expect(Object.values(days[2].forecasts)[0]).toMatchObject({ workoutLabel: 'B', certainty: 'forecast' });
  });

  it('concluído hoje: o ponteiro já avançou e a atividade mostra o que foi feito (fato)', () => {
    const s = done('s1', WED, 'A');
    const rotations: RotationState[] = [{ routineId: 'r1', nextIndex: 1, updatedAt: 1 }];
    const days = resolveRange(input({ entries: rotating(), sessions: [s], rotations }), WED, FRI);
    expect(Object.values(days[0].forecasts)[0]).toMatchObject({ workoutLabel: 'A', certainty: 'fact' });
    expect(Object.values(days[2].forecasts)[0]).toMatchObject({ workoutLabel: 'B', certainty: 'current' });
  });

  it('sem dados suficientes: "Treino a definir pela rotação" (rotina sem treinos, além do horizonte, passado sem registro)', () => {
    const far = resolveDay(input({ entries: rotating() }), '2026-11-13');
    expect(Object.values(far.forecasts)[0].certainty).toBe('undetermined');
    expect(FORECAST_HORIZON_DAYS).toBe(14);
    const empty = resolveDay(input({ entries: rotating(), routines: [routine('r1', { workouts: [] })] }), WED);
    expect(Object.values(empty.forecasts)[0].certainty).toBe('undetermined');
    const past = resolveDay(input({ entries: rotating() }), '2026-10-26');
    expect(Object.values(past.forecasts)[0].certainty).toBe('undetermined');
  });

  it('estado da rotação: só leitura do ponteiro', () => {
    const st = rotationStatus(input({ rotations: [{ routineId: 'r1', nextIndex: 4, updatedAt: 0 }] }), 'r1');
    expect(st).toMatchObject({ index: 1, order: ['A', 'B', 'C'] });
    expect(st?.next.label).toBe('B');
    expect(rotationStatus(input(), 'nao-existe')).toBeNull();
  });
});

describe('sessões reais', () => {
  it('sessão concluída é fato; associada ao planejado por ID; a agenda anterior vira "feito" sem conflito', () => {
    const d = resolveDay(input({ entries: [weekly(3, 'r1-B')], sessions: [done('s1', WED, 'B')] }), WED);
    expect(d.status).toBe('done');
    expect(d.entries[0]).toMatchObject({ origin: 'session', certainty: 'fact', sessionId: 's1', state: 'Realizada' });
    expect(d.legacy?.kind).toBe('done');
    expect(d.conflicts.filter((c) => c.kind.startsWith('plan_'))).toEqual([]);
  });

  it('sessões extras aparecem (não são erro) e o dia sem planejamento mostra "Treino realizado"', () => {
    const day = resolveDay(input({ entries: [weekly(3, 'r1-B')], sessions: [done('x', WED, 'C')] }), WED);
    expect(day.status).toBe('planned');
    expect(day.entries[0]).toMatchObject({ origin: 'session', planEntryId: null, state: 'Realizada fora do planejado', conflict: true });
    expect(day.conflicts.find((c) => c.kind === 'session_off_plan')?.severity).toBe('info');
    const free = resolveDay(input({ sessions: [done('y', '2026-10-27', 'C')] }), '2026-10-27');
    expect(free.status).toBe('trained');
    expect(free.conflicts).toEqual([]);
  });

  it('não duplica, não move e respeita o perfil; em andamento e descartadas não contam como concluídas', () => {
    const sessions = [
      done('s1', WED, 'B'),
      done('s1', WED, 'B'), // repetida
      done('outro', WED, 'A', { profileId: OTHER }),
      done('desc', WED, 'A', { status: 'discarded' }),
      done('ontem', '2026-10-27', 'A'),
    ];
    const [tue, wed] = resolveRange(input({ entries: [weekly(3, 'r1-B')], sessions }), '2026-10-27', WED);
    expect(wed.entries.filter((e) => e.origin === 'session').map((e) => e.sessionId)).toEqual(['s1']);
    expect(tue.entries.filter((e) => e.origin === 'session').map((e) => e.sessionId)).toEqual(['ontem']);
  });

  it('não modifica nenhuma entrada (dados congelados) e é determinístico', () => {
    const inp = deepFreeze(input({ entries: [weekly(3, 'r1-B'), exception(NEXT_WED, 'rest')], sessions: [done('s1', WED, 'B')] }));
    const a = resolveRange(inp, '2026-10-26', '2026-11-08');
    const b = resolveRange(inp, '2026-10-26', '2026-11-08');
    expect(a).toEqual(b);
  });
});

describe('semana, mês e próxima atividade', () => {
  it('a semana usa os mesmos números do planejamento (P13) e conta sugestões à parte', () => {
    const entries = [weekly(1, 'r1-A'), weekly(3, 'r1-B'), weekly(6, null, { kind: 'rest', routineId: null })];
    const sessions = [done('s1', '2026-10-26', 'A'), done('s2', '2026-10-27', 'C')];
    const inp = input({ entries, sessions });
    const w = resolveWeek(inp, WED);
    const p13 = buildWeek({ entries, sessions, routines: [R1], week: WED, today: WED, profileId: PID }).consistency;
    expect(w.consistency).toEqual(p13);
    expect(w.summary).toMatchObject({
      sessionsCompleted: p13.sessionsCompleted,
      activeDays: p13.daysWithTraining,
      plannedActivities: p13.plannedActivities,
      plannedDue: p13.plannedDue,
      realized: p13.realized,
      extraSessions: p13.extraSessions,
      restDaysPlanned: p13.restDays,
    });
    // Sexta (dia de treino nas Configurações, sem planejamento) é sugestão, não planejada.
    expect(w.summary.legacySuggestions).toBe(1);
    expect(w.summary.plannedActivities).toBe(2);
    expect(w.days.map((d) => d.date)).toEqual(['2026-10-26', '2026-10-27', WED, THU, FRI, SAT, '2026-11-01']);
  });

  it('mês: grade de segunda a domingo, sem registros criados, navegação e limites', () => {
    const oct = resolveMonth(input(), '2026-10');
    expect(oct.weeks.map((w) => w.monday)).toEqual(['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
    expect(oct.weeks.flatMap((w) => w.days).filter((d) => d.inMonth)).toHaveLength(31);
    expect(oct.summary.from).toBe('2026-10-01');
    expect(oct.summary.to).toBe('2026-10-31');
    const feb = resolveMonth(input(), '2027-02'); // começa na segunda e termina no domingo
    expect(feb.weeks).toHaveLength(4);
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2027-01', -1)).toBe('2026-12');
    expect(shiftMonth('2026-10', -10)).toBe('2025-12');
    expect(monthBounds('2028-02')).toEqual({ first: '2028-02-01', last: '2028-02-29' });
  });

  it('próxima atividade depois de hoje (planejada ou sugerida)', () => {
    expect(nextActivity(input())).toMatchObject({ day: { date: FRI, status: 'suggested' }, entry: { origin: 'legacy_rotation', workoutLabel: 'B' } });
    const n = nextActivity(input({ entries: [weekly(4, 'r1-C')] }));
    expect(n).toMatchObject({ day: { date: THU, status: 'planned' }, entry: { origin: 'plan_recurring', workoutLabel: 'C' } });
    expect(nextActivity(input({ legacy: null }))).toBeNull();
  });
});

describe('datas e fusos', () => {
  it('virada de ano: recorrência, previsão e agenda anterior continuam', () => {
    const inp = input({ today: '2026-12-30', entries: [weekly(4, null)] });
    const days = resolveRange(inp, '2026-12-28', '2027-01-10');
    expect(days.map((d) => d.date)).toContain('2027-01-01');
    const thu1 = days.find((d) => d.date === '2026-12-31')!;
    const thu2 = days.find((d) => d.date === '2027-01-07')!;
    expect(Object.values(thu1.forecasts)[0]).toMatchObject({ workoutLabel: 'A', certainty: 'current' });
    expect(Object.values(thu2.forecasts)[0]).toMatchObject({ workoutLabel: 'B', certainty: 'forecast' });
    expect(days.find((d) => d.date === '2027-01-01')!.legacy?.kind).toBe('workout'); // sexta é dia de treino
    expect(resolveMonth(inp, '2027-01').weeks[0].monday).toBe('2026-12-28');
  });

  it('virada de mês na semana', () => {
    const w = resolveWeek(input(), '2026-11-01');
    expect(w.days[0].date).toBe('2026-10-26');
    expect(w.days[6].date).toBe('2026-11-01');
  });

  it('fuso: sessão perto da meia-noite fica no dia local do aparelho; mudar de fuso muda o dia, não o dado', () => {
    const ts = Date.UTC(2026, 9, 29, 2, 30); // 23:30 de quarta em São Paulo; 11:30 de quinta em Tóquio
    const s = done('noite', WED, 'B', { startedAt: ts, finishedAt: ts + 3_600_000 });
    const inp = input({ entries: [weekly(3, 'r1-B')], sessions: [s] });
    process.env.TZ = 'America/Sao_Paulo';
    expect(resolveDay(inp, WED).status).toBe('done');
    process.env.TZ = 'Asia/Tokyo';
    expect(resolveDay(inp, WED).status).toBe('planned');
    expect(resolveDay(inp, THU).entries.find((e) => e.origin === 'session')?.sessionId).toBe('noite');
    expect(s.startedAt).toBe(ts);
  });

  it('sessão às 00:10 conta no dia que começou (local)', () => {
    process.env.TZ = 'America/Sao_Paulo';
    const s = done('cedo', THU, 'A', { startedAt: at(THU, 0, 10) });
    const [wed, thu] = resolveRange(input({ sessions: [s] }), WED, THU);
    expect(wed.entries.some((e) => e.origin === 'session')).toBe(false);
    expect(thu.status).toBe('trained');
  });

  it('horário de verão: dias e dias da semana corretos (Brasil 2018, EUA 2026)', () => {
    for (const tz of ['America/Sao_Paulo', 'America/New_York', 'Pacific/Auckland', 'Asia/Tokyo']) {
      process.env.TZ = tz;
      const br = resolveRange(input({ today: '2018-11-01' }), '2018-11-01', '2018-11-07');
      expect(br.map((d) => d.date)).toEqual(['2018-11-01', '2018-11-02', '2018-11-03', '2018-11-04', '2018-11-05', '2018-11-06', '2018-11-07']);
      expect(br.find((d) => d.date === '2018-11-04')!.weekday).toBe(0);
      expect(br.find((d) => d.date === '2018-11-05')!.legacy?.kind).toBe('workout'); // segunda
      const us = resolveRange(input({ today: '2026-03-06' }), '2026-03-06', '2026-03-09');
      expect(us.map((d) => d.weekday)).toEqual([5, 6, 0, 1]);
    }
  });
});
