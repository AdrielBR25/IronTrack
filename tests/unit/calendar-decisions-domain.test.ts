// Decisões lembradas do calendário (IronTrack 2.0 F01/P16): identidade de conflito, impressão digital (mudanças
// relevantes × irrelevantes), aplicação só na apresentação, perfis, datas, tipos, situação das decisões, regras de
// gravação (revalidação, idempotência, revisão, passado, horizonte) e validação Zod. Domínio puro, dados fictícios.
import { describe, expect, it } from 'vitest';
import {
  conflictCounts,
  evaluateDecisions,
  evaluateDecisionsFor,
  groupConflicts,
  nextActivity,
  pendingWarnings,
  planCleanup,
  planRemember,
  planRemove,
  planShowAgain,
  rememberOption,
  resolveDay,
  resolveRange,
  resolveWeek,
  type CalendarConflict,
  type CalendarInput,
  type LegacySchedule,
} from '@/modules/calendar';
import {
  DECISION_LIMITS,
  calendarDecisionIssues,
  conflictIdentity,
  decisionAllowed,
  decisionRecordId,
  isValidCalendarDecision,
  reassignDecision,
  type CalendarDecision,
  type PlanEntry,
} from '@/modules/planner';
import { assignOwner } from '@/lib/backupFormat';
import { routine, snapshot } from './fixtures';

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WED = '2026-10-28';
const THU = '2026-10-29';
const FRI = '2026-10-30';
const NEXT_WED = '2026-11-04';
const NOW = 1_800_000_000_000;

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
const exception = (date: string, kind: PlanEntry['kind'], workoutId: string | null = null, over: Partial<PlanEntry> = {}) =>
  weekly(0, workoutId, { scope: 'date', weekday: null, date, kind, routineId: kind === 'workout' ? 'r1' : null, workoutId: kind === 'workout' ? workoutId : null, validFrom: null, ...over });

const R1 = routine('r1');
const LEGACY: LegacySchedule = { routineId: 'r1', trainingDays: [1, 3, 5], overrides: [] };
const WED_B = weekly(3, 'r1-B');

function input(over: Partial<CalendarInput> = {}): CalendarInput {
  return { today: WED, profileId: PID, entries: [WED_B], sessions: [], routines: [R1], rotations: [{ routineId: 'r1', nextIndex: 0, updatedAt: 0 }], legacy: LEGACY, ...over };
}

const conflictOf = (i: CalendarInput, date = WED, kind = 'plan_vs_legacy_workout'): CalendarConflict | undefined => resolveDay(i, date).conflicts.find((c) => c.kind === kind);
const must = (c: CalendarConflict | undefined) => {
  if (!c) throw new Error('conflito esperado');
  return c;
};

/** Decisão gravada a partir do conflito atual (como a transação faria). */
function decide(i: CalendarInput, date = WED, kind = 'plan_vs_legacy_workout', decision: 'keep_plan' | 'hide_info' = 'keep_plan'): CalendarDecision {
  const c = must(conflictOf(i, date, kind));
  const d = planRemember(i, undefined, { date, conflictId: c.id, decision, expectedFingerprint: c.fingerprint, expectedRevision: null }, NOW);
  if (!d) throw new Error('decisão esperada');
  return d;
}

describe('identidade do conflito', () => {
  it('é estável e determinística: tipo, data e assunto; sem nomes, textos, relógio ou aleatoriedade', () => {
    const a = must(conflictOf(input()));
    const b = must(conflictOf(input()));
    expect(a.id).toBe(conflictIdentity('plan_vs_legacy_workout', WED, null));
    expect(a.id).toBe('plan_vs_legacy_workout|2026-10-28|');
    expect(b).toEqual(a);
    // Renomear a rotina/treino muda o texto do aviso, mas não a identidade.
    const renamed = must(conflictOf(input({ routines: [{ ...R1, name: 'Outro nome', workouts: R1.workouts.map((w) => ({ ...w, name: `${w.name} (novo)` })) }] })));
    expect(renamed.id).toBe(a.id);
    expect(renamed.message).not.toBe(a.message);
  });

  it('data diferente, tipo diferente e assunto (atividade/sessão) diferente dão identidades diferentes', () => {
    const wed = must(conflictOf(input()));
    const nextWed = must(conflictOf(input({ rotations: [{ routineId: 'r1', nextIndex: 0, updatedAt: 0 }] }), NEXT_WED));
    expect(nextWed.id).not.toBe(wed.id);
    const rot = must(conflictOf(input(), WED, 'rotation_differs'));
    expect(rot.id).not.toBe(wed.id);
    expect(rot.subject).toBe(WED_B.id);
    expect(rot.id).toBe(conflictIdentity('rotation_differs', WED, WED_B.id));
  });

  it('o ID da decisão inclui o perfil; reatribuir o dono (restauração com transferência) acompanha o ID', () => {
    const d = decide(input());
    expect(d.id).toBe(decisionRecordId(PID, d.conflictId));
    const moved = reassignDecision(d, OTHER);
    expect(moved).toMatchObject({ profileId: OTHER, id: `${OTHER}~${d.conflictId}` });
    expect(isValidCalendarDecision(moved)).toBe(true);
    // A mesma regra no formato do backup (sem importar o domínio na camada compartilhada).
    expect(assignOwner({ ...snapshot(), calendarDecisions: [d] }, OTHER).calendarDecisions[0]).toEqual(moved);
  });
});

describe('impressão digital: mudanças irrelevantes preservam a decisão', () => {
  const base = must(conflictOf(input())).fingerprint;
  const cases: [string, Partial<CalendarInput>][] = [
    ['renomear rotina e treinos', { routines: [{ ...R1, name: 'ABC renomeada', workouts: R1.workouts.map((w) => ({ ...w, name: 'Novo nome' })) }] }],
    ['editar exercícios da ficha', { routines: [{ ...R1, workouts: R1.workouts.map((w) => ({ ...w, exercises: w.exercises.slice(0, 1) })) }] }],
    ['planejar outro dia da semana', { entries: [WED_B, weekly(4, 'r1-C')] }],
    ['exceção em outra data', { entries: [WED_B, exception(FRI, 'rest')] }],
    ['reagendamento em outra data', { legacy: { ...LEGACY, overrides: [{ routineId: 'r1', date: FRI, kind: 'rest' }] } }],
    ['dia de treino novo depois do dia do conflito', { legacy: { ...LEGACY, trainingDays: [1, 3, 5, 6] } }],
    ['outra rotina sem relação', { routines: [R1, routine('r2')] }],
    ['carimbo updatedAt da entrada (sem nova revisão)', { entries: [{ ...WED_B, updatedAt: 999 }] }],
  ];
  it.each(cases)('%s', (_name, over) => {
    expect(must(conflictOf(input(over))).fingerprint).toBe(base);
  });
});

describe('impressão digital: mudanças relevantes invalidam a decisão', () => {
  const base = must(conflictOf(input())).fingerprint;
  const changed = (over: Partial<CalendarInput>, date = WED, kind = 'plan_vs_legacy_workout') => {
    const c = conflictOf(input(over), date, kind);
    return c ? c.fingerprint !== base || c.kind !== 'plan_vs_legacy_workout' : true;
  };
  it('alteração do planejamento do dia (nova revisão ou outro treino)', () => {
    expect(changed({ entries: [{ ...WED_B, revision: 2 }] })).toBe(true);
    expect(changed({ entries: [{ ...WED_B, workoutId: 'r1-C', revision: 2 }] })).toBe(true);
  });
  it('exceção na data e alteração da exceção', () => {
    const ex = exception(WED, 'workout', 'r1-C');
    const withEx = must(conflictOf(input({ entries: [WED_B, ex] }))).fingerprint;
    expect(withEx).not.toBe(base);
    expect(must(conflictOf(input({ entries: [WED_B, { ...ex, revision: 2 }] }))).fingerprint).not.toBe(withEx);
  });
  it('agenda anterior: reagendamento na data, mudança de trainingDays no dia e na rotação', () => {
    expect(changed({ legacy: { ...LEGACY, overrides: [{ routineId: 'r1', date: WED, kind: 'workout', workoutId: 'r1-C' }] } })).toBe(true);
    expect(changed({ legacy: { ...LEGACY, trainingDays: [1, 5] } })).toBe(true); // vira "treino × descanso"
    expect(changed({ rotations: [{ routineId: 'r1', nextIndex: 2, updatedAt: 1 }] })).toBe(true); // a rotação indica C
  });
  it('treino ou rotina relacionados: rótulo mudou, treino removido, rotina excluída', () => {
    expect(changed({ routines: [{ ...R1, workouts: R1.workouts.map((w) => (w.id === 'r1-B' ? { ...w, label: 'X' } : w)) }] })).toBe(true);
    expect(changed({ routines: [{ ...R1, workouts: R1.workouts.filter((w) => w.id !== 'r1-B') }] })).toBe(true);
    expect(changed({ routines: [], legacy: null })).toBe(true); // rotina excluída: conflito some
  });
  it('mudança da classificação: o dia do conflito vira "hoje" (previsão → aviso)', () => {
    const tue = { ...input(), today: '2026-10-27' };
    const before = must(conflictOf(tue, NEXT_WED));
    expect(before.severity).toBe('info');
    const now = must(conflictOf({ ...input(), today: NEXT_WED }, NEXT_WED));
    expect(now.severity).toBe('warning');
    expect(now.fingerprint).not.toBe(before.fingerprint);
  });
  it('previsão da rotação só entra quando o conflito depende dela', () => {
    // Descanso planejado × dia de treino pela rotação: o treino previsto não importa.
    const rest = input({ entries: [exception(FRI, 'rest')] });
    const a = must(conflictOf(rest, FRI, 'plan_rest_vs_legacy_workout')).fingerprint;
    const b = must(conflictOf({ ...rest, rotations: [{ routineId: 'r1', nextIndex: 2, updatedAt: 1 }] }, FRI, 'plan_rest_vs_legacy_workout')).fingerprint;
    expect(b).toBe(a);
  });
});

describe('aplicação das decisões (só apresentação)', () => {
  it('reconhece o aviso idêntico: sem aviso novo, conflito consultável, mesma precedência e entradas', () => {
    const i = input();
    const d = decide(i);
    const plain = resolveDay(i, WED);
    const withD = resolveDay({ ...i, decisions: [d] }, WED);
    expect(plain.hasWarning).toBe(true);
    expect(withD.hasWarning).toBe(false);
    expect(withD.rememberedCount).toBe(1);
    expect(withD.conflicts).toHaveLength(plain.conflicts.length);
    expect(withD.conflicts.find((c) => c.kind === 'plan_vs_legacy_workout')!.remembered).toMatchObject({ decision: 'keep_plan', decisionId: d.id, revision: 1 });
    expect(pendingWarnings(withD)).toEqual([]);
    expect(withD.entries).toEqual(plain.entries);
    expect([withD.origin, withD.status, withD.legacy, withD.plan]).toEqual([plain.origin, plain.status, plain.legacy, plain.plan]);
    expect(nextActivity({ ...i, decisions: [d] })).toEqual(nextActivity(i));
    const w0 = resolveWeek(i, WED);
    const w1 = resolveWeek({ ...i, decisions: [d] }, WED);
    expect(w1.summary.conflictDays).toBe(w0.summary.conflictDays - 1);
    expect(w1.consistency).toEqual(w0.consistency);
  });

  it('mudança relevante: o aviso volta (decisão sem efeito); irrelevante: continua reconhecido', () => {
    const d = decide(input());
    expect(resolveDay(input({ decisions: [d], entries: [{ ...WED_B, revision: 2 }] }), WED).hasWarning).toBe(true);
    expect(resolveDay(input({ decisions: [d], routines: [{ ...R1, name: 'Renomeada' }] }), WED).hasWarning).toBe(false);
  });

  it('perfil diferente, data diferente e tipo diferente não são afetados', () => {
    const d = decide(input());
    expect(resolveDay(input({ decisions: [d], profileId: OTHER }), WED).hasWarning).toBe(true);
    expect(resolveDay(input({ decisions: [{ ...d, profileId: OTHER, id: decisionRecordId(OTHER, d.conflictId) }] }), WED).hasWarning).toBe(true);
    const next = resolveDay(input({ decisions: [d], today: '2026-11-03' }), NEXT_WED);
    expect(next.conflicts.some((c) => c.kind === 'plan_vs_legacy_workout' && !c.remembered)).toBe(true);
    // A observação "planejado × próximo da rotação" do mesmo dia continua sem decisão.
    expect(resolveDay(input({ decisions: [d] }), WED).conflicts.find((c) => c.kind === 'rotation_differs')!.remembered).toBeNull();
  });

  it('"voltar a mostrar" não tem efeito; decisão incompatível com a gravidade atual também não', () => {
    const d = decide(input());
    expect(resolveDay(input({ decisions: [{ ...d, decision: 'show', scope: 'conflict_day' }] }), WED).hasWarning).toBe(true);
    const info = decide(input(), WED, 'rotation_differs', 'hide_info');
    const day = resolveDay(input({ decisions: [info] }), WED);
    expect(day.conflicts.find((c) => c.kind === 'rotation_differs')!.remembered?.decision).toBe('hide_info');
    expect(day.hasWarning).toBe(true); // o aviso relevante continua
  });

  it('central e contagens: reconhecidos saem da lista e são contados à parte', () => {
    const i = input();
    const d = decide(i);
    const days = resolveRange({ ...i, decisions: [d] }, '2026-10-26', '2026-11-01');
    expect(groupConflicts(days, { includeInfo: false }).some((g) => g.kind === 'plan_vs_legacy_workout')).toBe(false);
    expect(groupConflicts(days, { includeInfo: true, remembered: true }).map((g) => g.kind)).toEqual(['plan_vs_legacy_workout']);
    expect(conflictCounts(days)).toMatchObject({ warningDays: 0, rememberedDays: 1 });
  });

  it('opções: manter planejamento só para planejamento × agenda; ocultar só observações; nada no passado', () => {
    const day = resolveDay(input(), WED);
    expect(rememberOption(day, day.conflicts.find((c) => c.kind === 'plan_vs_legacy_workout')!)).toBe('keep_plan');
    expect(rememberOption(day, day.conflicts.find((c) => c.kind === 'rotation_differs')!)).toBe('hide_info');
    expect(rememberOption({ isPast: true }, day.conflicts[0])).toBeNull();
    expect(decisionAllowed('rotation_differs', 'info', 'keep_plan')).toBe(false);
    expect(decisionAllowed('plan_vs_legacy_workout', 'warning', 'hide_info')).toBe(false);
    expect(decisionAllowed('session_off_plan', 'warning', 'hide_info')).toBe(false);
  });

  it('não existe decisão global: cada registro vale para um conflito, numa data', () => {
    const d = decide(input());
    const days = resolveRange(input({ decisions: [d], entries: [WED_B, weekly(1, 'r1-B'), weekly(5, 'r1-C')] }), WED, '2026-11-08');
    expect(days.filter((x) => x.rememberedCount > 0).map((x) => x.date)).toEqual([WED]);
    // As mesmas divergências nos outros dias continuam exibidas (previsões), sem decisão.
    const others = days.filter((x) => x.date !== WED && x.conflicts.some((c) => c.kind === 'plan_vs_legacy_workout' && !c.remembered));
    expect(others.length).toBeGreaterThan(2);
  });
});

describe('gravação planejada (revalidação)', () => {
  it('recusa conflito sumido, mudado, passado, além do horizonte, decisão não permitida e sem perfil', () => {
    const i = input();
    const c = must(conflictOf(i));
    const req = { date: WED, conflictId: c.id, decision: 'keep_plan' as const, expectedFingerprint: c.fingerprint, expectedRevision: null };
    expect(() => planRemember(input({ entries: [] }), undefined, req, NOW)).toThrow(expect.objectContaining({ kind: 'gone' }));
    expect(() => planRemember(input({ entries: [{ ...WED_B, revision: 2 }] }), undefined, req, NOW)).toThrow(expect.objectContaining({ kind: 'changed' }));
    expect(() => planRemember({ ...i, today: THU }, undefined, req, NOW)).toThrow(expect.objectContaining({ kind: 'past' }));
    expect(() => planRemember(i, undefined, { ...req, date: '2028-12-31' }, NOW)).toThrow(expect.objectContaining({ kind: 'horizon' }));
    expect(() => planRemember(i, undefined, { ...req, decision: 'hide_info' }, NOW)).toThrow(expect.objectContaining({ kind: 'not_allowed' }));
    expect(() => planRemember({ ...i, profileId: undefined }, undefined, req, NOW)).toThrow(expect.objectContaining({ kind: 'no_profile' }));
  });

  it('repetir a mesma decisão não grava de novo; outra versão exige a revisão conhecida', () => {
    const i = input();
    const d = decide(i);
    expect(d).toMatchObject({ revision: 1, decision: 'keep_plan', scope: 'conflict_day', profileId: PID, date: WED, subject: null, severity: 'warning', createdAt: NOW });
    const c = must(conflictOf(i));
    expect(planRemember(i, d, { date: WED, conflictId: c.id, decision: 'keep_plan', expectedFingerprint: c.fingerprint, expectedRevision: null }, NOW + 5)).toBeNull();
    // Decisão invalidada (plano mudou): lembrar de novo atualiza o mesmo registro (revisão 2), só com a revisão certa.
    const i2 = input({ entries: [{ ...WED_B, revision: 2 }] });
    const c2 = must(conflictOf(i2));
    const req = { date: WED, conflictId: c2.id, decision: 'keep_plan' as const, expectedFingerprint: c2.fingerprint };
    expect(() => planRemember(i2, d, { ...req, expectedRevision: null }, NOW + 5)).toThrow(expect.objectContaining({ kind: 'changed' }));
    expect(planRemember(i2, d, { ...req, expectedRevision: 1 }, NOW + 5)).toMatchObject({ id: d.id, revision: 2, createdAt: NOW, sourceFingerprint: c2.fingerprint });
  });

  it('voltar a mostrar e remover conferem a revisão', () => {
    const d = decide(input());
    expect(planShowAgain(d, 1, NOW + 1)).toMatchObject({ decision: 'show', revision: 2 });
    expect(() => planShowAgain(d, 7, NOW)).toThrow(expect.objectContaining({ kind: 'changed' }));
    expect(() => planShowAgain(undefined, 1, NOW)).toThrow(expect.objectContaining({ kind: 'missing' }));
    expect(planRemove(d, 1)).toBe(d.id);
    expect(() => planRemove(d, 2)).toThrow(expect.objectContaining({ kind: 'changed' }));
  });
});

describe('situação das decisões e limpeza', () => {
  it('valendo, invalidada, resolvida, vencida e "mostrar de novo"', () => {
    const i = input();
    const active = decide(i);
    const invalid = decide(input({ entries: [WED_B, weekly(5, 'r1-C')] }), FRI); // outra entrada (nova ID) na sexta → invalidada
    const resolved = { ...active, id: decisionRecordId(PID, conflictIdentity('plan_rest_vs_legacy_workout', THU, null)), conflictId: conflictIdentity('plan_rest_vs_legacy_workout', THU, null), conflictType: 'plan_rest_vs_legacy_workout' as const, date: THU };
    const expired = { ...active, id: decisionRecordId(PID, conflictIdentity('plan_vs_legacy_workout', '2026-10-21', null)), conflictId: conflictIdentity('plan_vs_legacy_workout', '2026-10-21', null), date: '2026-10-21' };
    const views = evaluateDecisionsFor({ ...i, entries: [WED_B, { ...weekly(5, 'r1-C') }] }, [active, invalid, resolved, expired]);
    expect(Object.fromEntries(views.map((v) => [v.decision.date, v.status]))).toEqual({ [WED]: 'active', [FRI]: 'invalidated', [THU]: 'resolved', '2026-10-21': 'expired' });
    expect(views.map((v) => v.decision.date)).toEqual([WED, THU, FRI, '2026-10-21']);
    expect(evaluateDecisions([{ ...active, decision: 'show' }], resolveRange(i, WED, WED), WED, PID)[0].status).toBe('showing');
    expect(evaluateDecisions([active], resolveRange(i, WED, WED), WED, OTHER)).toEqual([]);
  });

  it('limpar remove só as que continuam sem efeito', () => {
    const i = input();
    const active = decide(i);
    const old = { ...active, id: decisionRecordId(PID, 'x'), conflictId: conflictIdentity('plan_vs_legacy_workout', '2026-10-21', null), date: '2026-10-21' };
    expect(planCleanup(i, [active, old], [active.id, old.id])).toEqual([old.id]);
  });
});

describe('validação Zod e limites', () => {
  it('aceita a decisão gerada e recusa registros corrompidos', () => {
    const d = decide(input());
    expect(calendarDecisionIssues(d)).toEqual([]);
    const bad: unknown[] = [
      null,
      'texto',
      { ...d, date: '2026-02-30' },
      { ...d, conflictType: 'ignorar_tudo' },
      { ...d, decision: 'ignore_all' },
      { ...d, scope: 'global' },
      { ...d, id: 'outro-id' },
      { ...d, conflictId: 'plan_vs_legacy_workout|2026-10-29|' },
      { ...d, revision: 0 },
      { ...d, summary: 'x'.repeat(DECISION_LIMITS.maxSummary + 1) },
      { ...d, sourceFingerprint: '' },
      { ...d, decision: 'hide_info' }, // ocultar não vale para aviso relevante
      { ...d, updatedAt: d.createdAt - 1 },
    ];
    for (const b of bad) expect(calendarDecisionIssues(b).length).toBeGreaterThan(0);
    expect(DECISION_LIMITS.maxPerProfile).toBe(200);
  });

  it('o cálculo não altera a entrada (sem efeitos colaterais)', () => {
    const d = decide(input());
    const i = input({ decisions: [d] });
    const before = JSON.stringify(i);
    resolveRange(i, '2026-10-26', '2026-11-08');
    evaluateDecisionsFor(i, [d]);
    expect(JSON.stringify(i)).toBe(before);
  });
});
