// Consolidação de agendas (IronTrack 2.0 F01/P15): conversão segura da agenda anterior em planejamento, prévia,
// modos, idempotência, conflitos, desfazer, central de divergências e preferências de exibição. Domínio puro, sem
// banco. Dados fictícios.
import { describe, expect, it } from 'vitest';
import { conflictCounts, groupConflicts, resolveDay, resolveRange, type CalendarInput } from '@/modules/calendar';
import {
  importFingerprint,
  planForDate,
  planUndoImport,
  previewLegacyImport,
  replaceDate,
  type ImportPreview,
  type LegacyImportInput,
  type PlanEntry,
  type PlanImportRecord,
} from '@/modules/planner';
import { DEFAULT_CALENDAR_PREFS, sanitizePrefs } from '@/features/calendar/calendarPrefs';
import { displayStatus } from '@/features/calendar/MonthGrid';
import type { DayOverride } from '@/modules/training';
import { routine } from './fixtures';

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WED = '2026-10-28'; // hoje (quarta-feira)
const THU = '2026-10-29';
const FRI = '2026-10-30';
const MON = '2026-11-02';
const R1 = { ...routine('r1'), profileId: PID };
const R2 = { ...routine('r2'), profileId: PID };

let seq = 0;
function weekly(weekday: number, over: Partial<PlanEntry> = {}): PlanEntry {
  seq += 1;
  return {
    id: `p${seq}`,
    profileId: PID,
    scope: 'weekly',
    weekday,
    date: null,
    kind: 'workout',
    routineId: 'r1',
    workoutId: null,
    enabled: true,
    validFrom: '2026-10-01',
    validUntil: null,
    createdAt: seq,
    updatedAt: seq,
    revision: 1,
    ...over,
  };
}
const exception = (date: string, kind: PlanEntry['kind'], workoutId: string | null = null, over: Partial<PlanEntry> = {}) =>
  weekly(0, { scope: 'date', weekday: null, date, kind, routineId: kind === 'workout' ? 'r1' : null, workoutId: kind === 'workout' ? workoutId : null, validFrom: null, ...over });

function input(over: Partial<LegacyImportInput> & { trainingDays?: number[]; overrides?: DayOverride[]; routineOff?: boolean } = {}): LegacyImportInput {
  const { trainingDays = [1, 3, 5], overrides = [], routineOff, ...rest } = over;
  return { today: WED, entries: [], routines: [R1, R2], source: { routine: routineOff ? null : R1, trainingDays, overrides }, ...rest };
}

const ctx = (today = WED, now = 1_800_000_000_000) => {
  let i = 0;
  return { today, now, newId: () => `new-${today}-${++i}` };
};

const item = (p: ImportPreview, key: string) => p.items.find((i) => i.key === key)!;
/** Aplica as mudanças da prévia a uma lista (o que a persistência faz). */
const apply = (entries: readonly PlanEntry[], ch: { put: PlanEntry[]; delete: string[] }) => {
  const m = new Map(entries.map((e) => [e.id, e]));
  ch.delete.forEach((id) => m.delete(id));
  ch.put.forEach((e) => m.set(e.id, e));
  return [...m.values()];
};
const record = (p: ImportPreview, day = WED): PlanImportRecord => ({
  id: 'op1',
  profileId: PID,
  createdAt: 1,
  day,
  mode: p.mode === 'view' ? 'empty_only' : p.mode,
  routineId: 'r1',
  routineName: 'Rotina r1',
  counts: p.counts,
  changes: p.log,
  slotsAfter: p.slotsAfter,
  status: 'applied',
  undoneAt: null,
});

describe('conversão segura da agenda anterior', () => {
  it('agenda vazia e planejamento vazio: dias de treino viram "próximo da rotação" toda semana; os outros dias não viram descanso', () => {
    const p = previewLegacyImport(input(), { mode: 'empty_only' }, ctx());
    expect(item(p, 'weekday:1')).toMatchObject({ action: 'create', outcome: 'create', proposed: { kind: 'workout', routineId: 'r1', workoutId: null } });
    expect(item(p, 'weekday:3').action).toBe('create');
    expect(item(p, 'weekday:5').action).toBe('create');
    for (const w of [0, 2, 4, 6]) expect(item(p, `weekday:${w}`)).toMatchObject({ action: 'ignore', proposed: null });
    expect(item(p, 'weekday:2').reason).toMatch(/não vira descanso automaticamente/);
    expect(p.put).toHaveLength(3);
    // Nenhum treino fixo: todas seguem a rotação (previsão), recorrentes a partir de hoje, sem descanso inventado.
    expect(p.put.every((e) => e.scope === 'weekly' && e.kind === 'workout' && e.workoutId === null && e.validFrom === WED && e.validUntil === null)).toBe(true);
    expect(p.put.some((e) => e.kind === 'rest')).toBe(false);
    expect(p.counts).toMatchObject({ create: 3, ignore: 4, conflicts: 0 });
    expect(p.overview).toMatchObject({ routineId: 'r1', trainingDays: [1, 3, 5], plannedWeekdays: 0 });
  });

  it('sem rotina ativa (ou rotina sem treinos): nada a importar', () => {
    expect(previewLegacyImport(input({ routineOff: true }), { mode: 'empty_only' }, ctx()).items.filter((i) => i.kind !== 'summary')).toEqual([]);
    const empty = { ...R1, workouts: [] };
    const p = previewLegacyImport({ ...input(), source: { routine: empty, trainingDays: [1], overrides: [] } }, { mode: 'empty_only' }, ctx());
    expect(p.put).toEqual([]);
    expect(p.overview.routineId).toBeNull();
  });

  it('agenda sem dias de treino: nenhum item vira treino nem descanso', () => {
    const p = previewLegacyImport(input({ trainingDays: [] }), { mode: 'empty_only' }, ctx());
    expect(p.put).toEqual([]);
    expect(p.items.filter((i) => i.kind === 'weekday').every((i) => i.action === 'ignore')).toBe(true);
  });

  it('reagendamentos viram exceções da data (nunca recorrência); descanso explícito vira exceção de descanso', () => {
    const overrides: DayOverride[] = [
      { routineId: 'r1', date: FRI, kind: 'workout', workoutId: 'r1-C' },
      { routineId: 'r1', date: MON, kind: 'rest' },
    ];
    const p = previewLegacyImport(input({ overrides }), { mode: 'empty_only' }, ctx());
    expect(item(p, `date:${FRI}`)).toMatchObject({ action: 'create', proposed: { kind: 'workout', routineId: 'r1', workoutId: 'r1-C' } });
    expect(item(p, `date:${MON}`)).toMatchObject({ action: 'create', proposed: { kind: 'rest' } });
    const dates = p.put.filter((e) => e.scope === 'date');
    expect(dates.map((e) => [e.date, e.kind, e.workoutId])).toEqual([
      [FRI, 'workout', 'r1-C'],
      [MON, 'rest', null],
    ]);
    // Na sexta, a exceção substitui o dia inteiro: vale o Treino C (como na agenda anterior), não o semanal criado.
    const after = apply([], p);
    expect(planForDate(after, FRI).entries.map((e) => e.workoutId)).toEqual(['r1-C']);
    expect(planForDate(after, '2026-11-06').entries.map((e) => e.workoutId)).toEqual([null]); // sexta seguinte: rotação
  });

  it('não converte reagendamentos passados, de outra rotina ou de treino removido (este exige escolha manual)', () => {
    const overrides: DayOverride[] = [
      { routineId: 'r1', date: '2026-10-20', kind: 'workout', workoutId: 'r1-B' },
      { routineId: 'r2', date: FRI, kind: 'rest' },
      { routineId: 'r1', date: THU, kind: 'workout', workoutId: 'r1-Z' },
    ];
    const p = previewLegacyImport(input({ overrides }), { mode: 'empty_only' }, ctx());
    expect(item(p, 'past')).toMatchObject({ action: 'ignore', count: 1 });
    expect(item(p, 'other-routines')).toMatchObject({ action: 'ignore', count: 1 });
    expect(item(p, `date:${THU}`)).toMatchObject({ action: 'manual', proposed: null });
    expect(p.put.some((e) => e.date === THU || e.date === '2026-10-20' || e.routineId === 'r2')).toBe(false);
    expect(p.counts.manual).toBe(1);
  });

  it('identidade por ID: nunca infere treino por nome nem associa outra rotina', () => {
    const renamed = { ...R1, workouts: R1.workouts.map((w) => ({ ...w, name: 'Peito' })) };
    const p = previewLegacyImport({ ...input({ overrides: [{ routineId: 'r1', date: FRI, kind: 'workout', workoutId: 'r1-B' }] }), source: { routine: renamed, trainingDays: [1], overrides: [{ routineId: 'r1', date: FRI, kind: 'workout', workoutId: 'r1-B' }] } }, { mode: 'empty_only' }, ctx());
    expect(p.put.every((e) => e.routineId === 'r1')).toBe(true);
    expect(p.put.find((e) => e.date === FRI)!.workoutId).toBe('r1-B');
  });

  it('modo "só visualizar": mesma prévia, nada para gravar', () => {
    const a = previewLegacyImport(input(), { mode: 'empty_only' }, ctx());
    const v = previewLegacyImport(input(), { mode: 'view' }, ctx());
    expect(v.items.map((i) => [i.key, i.action])).toEqual(a.items.map((i) => [i.key, i.action]));
    expect(v.put).toEqual([]);
    expect(v.delete).toEqual([]);
    expect(v.fingerprint).toBe(a.fingerprint);
  });

  it('determinística e sem efeitos: as mesmas entradas dão a mesma prévia e nada é mutado', () => {
    const inp = input({ entries: [weekly(2, { workoutId: 'r1-A' })], overrides: [{ routineId: 'r1', date: FRI, kind: 'rest' }] });
    const frozen = JSON.stringify(inp);
    const a = previewLegacyImport(inp, { mode: 'empty_only' }, ctx());
    const b = previewLegacyImport(inp, { mode: 'empty_only' }, ctx());
    expect(b).toEqual(a);
    expect(JSON.stringify(inp)).toBe(frozen);
  });
});

describe('planejamento existente e conflitos', () => {
  it('planejamento igual é preservado; diferente é conflito que mantém o atual no modo padrão', () => {
    const entries = [weekly(1), weekly(3, { workoutId: 'r1-C' }), weekly(5, { kind: 'rest', routineId: null })];
    const p = previewLegacyImport(input({ entries }), { mode: 'empty_only' }, ctx());
    expect(item(p, 'weekday:1')).toMatchObject({ action: 'preserve', outcome: 'preserve' });
    expect(item(p, 'weekday:3')).toMatchObject({ action: 'conflict', outcome: 'keep', decision: 'keep' });
    expect(item(p, 'weekday:3').proposal).toMatch(/^Manter Treino C \(Treino C\) e solicitar decisão/);
    expect(item(p, 'weekday:5')).toMatchObject({ action: 'conflict', outcome: 'keep' });
    expect(p.put).toEqual([]); // nada substituído sem decisão
    expect(p.counts.conflicts).toBe(2);
  });

  it('exemplo do enunciado: segunda vazia → adicionar; terça com outro treino → manter e pedir decisão; quarta descanso × descanso → nada', () => {
    const entries = [weekly(2, { workoutId: 'r1-C' }), exception(WED, 'rest')];
    const p = previewLegacyImport(input({ trainingDays: [1, 2], entries, overrides: [{ routineId: 'r1', date: WED, kind: 'rest' }] }), { mode: 'empty_only' }, ctx());
    expect(item(p, 'weekday:1').outcome).toBe('create');
    expect(item(p, 'weekday:2').outcome).toBe('keep');
    expect(item(p, `date:${WED}`)).toMatchObject({ action: 'preserve', proposal: 'Nenhuma alteração' });
  });

  it('planejamento com outra atividade além da rotação desta rotina: já coberto (sem duplicar)', () => {
    const entries = [weekly(1), weekly(1, { routineId: 'r2', workoutId: 'r2-A' })];
    const p = previewLegacyImport(input({ entries }), { mode: 'empty_only' }, ctx());
    expect(item(p, 'weekday:1').action).toBe('preserve');
  });

  it('entrada pausada ou de rotina excluída é planejamento existente: conflito, nunca sobrescrita', () => {
    const entries = [weekly(1, { enabled: false }), weekly(3, { routineId: 'gone', workoutId: null })];
    const p = previewLegacyImport(input({ entries }), { mode: 'empty_only' }, ctx());
    expect(item(p, 'weekday:1').action).toBe('conflict');
    expect(item(p, 'weekday:1').currentText).toMatch(/pausada/);
    expect(item(p, 'weekday:3').action).toBe('conflict');
    expect(item(p, 'weekday:3').currentText).toMatch(/rotina excluída/);
  });

  it('modo de revisão: decisão por conflito (manter, usar agenda antiga, não importar), sem substituição em lote', () => {
    const entries = [weekly(1, { workoutId: 'r1-B', validFrom: '2026-10-01' }), weekly(3, { workoutId: 'r1-C' }), weekly(5, { workoutId: 'r1-A' })];
    const p = previewLegacyImport(input({ entries }), { mode: 'review', decisions: { 'weekday:1': 'legacy', 'weekday:3': 'skip' } }, ctx());
    expect(item(p, 'weekday:1')).toMatchObject({ outcome: 'replace', decision: 'legacy' });
    expect(item(p, 'weekday:3')).toMatchObject({ outcome: 'skip', decision: 'skip' });
    expect(item(p, 'weekday:5')).toMatchObject({ outcome: 'keep', decision: 'keep' }); // padrão: manter
    // Segunda: a versão antiga é encerrada ontem (passado preservado) e entra a da agenda anterior, de hoje em diante.
    const retired = p.put.find((e) => e.id === entries[0].id)!;
    expect(retired.validUntil).toBe('2026-10-27');
    expect(p.put.filter((e) => e.weekday === 1 && e.validUntil === null).map((e) => e.workoutId)).toEqual([null]);
    expect(p.put.some((e) => e.weekday === 3 || e.weekday === 5)).toBe(false);
    expect(p.log.updated.map((u) => u.before.id)).toEqual([entries[0].id]);
    expect(p.counts).toMatchObject({ replace: 1, skip: 1, keep: 1 });
  });

  it('decisões são ignoradas fora do modo de revisão', () => {
    const entries = [weekly(1, { workoutId: 'r1-B' })];
    const p = previewLegacyImport(input({ entries }), { mode: 'empty_only', decisions: { 'weekday:1': 'legacy' } }, ctx());
    expect(item(p, 'weekday:1').outcome).toBe('keep');
    expect(p.put.some((e) => e.weekday === 1)).toBe(false);
  });

  it('data reagendada contra exceção existente: conflito; "usar agenda antiga" substitui só aquela data', () => {
    const ex = exception(FRI, 'workout', 'r1-A');
    const overrides: DayOverride[] = [{ routineId: 'r1', date: FRI, kind: 'workout', workoutId: 'r1-C' }];
    const a = previewLegacyImport(input({ entries: [ex], overrides }), { mode: 'empty_only' }, ctx());
    expect(item(a, `date:${FRI}`)).toMatchObject({ action: 'conflict', outcome: 'keep' });
    const b = previewLegacyImport(input({ entries: [ex], overrides }), { mode: 'review', decisions: { [`date:${FRI}`]: 'legacy' } }, ctx());
    expect(b.delete).toEqual([ex.id]);
    expect(planForDate(apply([ex], b), FRI).entries.map((e) => e.workoutId)).toEqual(['r1-C']);
    expect(b.log.deleted.map((e) => e.id)).toEqual([ex.id]);
  });

  it('data reagendada contra o planejamento semanal existente: conflito (a exceção esconderia o semanal)', () => {
    const entries = [weekly(5, { workoutId: 'r1-A' })];
    const p = previewLegacyImport(input({ entries, overrides: [{ routineId: 'r1', date: FRI, kind: 'rest' }] }), { mode: 'empty_only' }, ctx());
    expect(item(p, `date:${FRI}`).action).toBe('conflict');
    const r = previewLegacyImport(input({ entries, overrides: [{ routineId: 'r1', date: FRI, kind: 'rest' }] }), { mode: 'review', decisions: { [`date:${FRI}`]: 'legacy' } }, ctx());
    expect(r.delete).toEqual([]); // o semanal não muda
    expect(r.put.filter((e) => e.date === FRI).map((e) => e.kind)).toEqual(['rest']);
  });

  it('a impressão digital muda com qualquer alteração relevante (planejamento, agenda, rotina)', () => {
    const base = input();
    const fp = importFingerprint(base);
    expect(importFingerprint(input({ entries: [weekly(2)] }))).not.toBe(fp);
    expect(importFingerprint(input({ trainingDays: [1, 3] }))).not.toBe(fp);
    expect(importFingerprint(input({ overrides: [{ routineId: 'r1', date: FRI, kind: 'rest' }] }))).not.toBe(fp);
    expect(importFingerprint({ ...base, today: THU })).not.toBe(fp);
    expect(importFingerprint({ ...base, source: { ...base.source, routine: { ...R1, workouts: R1.workouts.slice(0, 2) } } })).not.toBe(fp);
    expect(importFingerprint(input())).toBe(fp);
  });
});

describe('idempotência', () => {
  it('reimportar a mesma agenda não cria duplicatas (tudo fica "sem alteração")', () => {
    const overrides: DayOverride[] = [
      { routineId: 'r1', date: FRI, kind: 'workout', workoutId: 'r1-C' },
      { routineId: 'r1', date: MON, kind: 'rest' },
    ];
    const first = previewLegacyImport(input({ overrides }), { mode: 'empty_only' }, ctx());
    const after = apply([], first);
    const second = previewLegacyImport(input({ overrides, entries: after }), { mode: 'empty_only' }, ctx());
    expect(second.put).toEqual([]);
    expect(second.delete).toEqual([]);
    expect(second.items.filter((i) => i.kind !== 'summary').every((i) => i.action === 'preserve' || i.action === 'ignore')).toBe(true);
    // Também num outro dia (as entradas criadas continuam vigentes).
    const later = previewLegacyImport(input({ overrides, entries: after, today: THU }), { mode: 'empty_only' }, ctx(THU));
    expect(later.put).toEqual([]);
  });
});

describe('desfazer', () => {
  const overrides: DayOverride[] = [{ routineId: 'r1', date: FRI, kind: 'workout', workoutId: 'r1-C' }];

  it('no mesmo dia: remove só o que a importação criou e devolve o que ela substituiu', () => {
    const own = weekly(1, { workoutId: 'r1-B', validFrom: '2026-10-01' });
    const keep = weekly(2, { workoutId: 'r1-A' });
    const p = previewLegacyImport(input({ entries: [own, keep], overrides }), { mode: 'review', decisions: { 'weekday:1': 'legacy' } }, ctx());
    const after = apply([own, keep], p);
    const undo = planUndoImport(record(p), after, ctx());
    expect(undo.ok).toBe(true);
    const restored = apply(after, undo);
    expect(restored.map((e) => e.id).sort()).toEqual([own.id, keep.id].sort());
    expect(restored.find((e) => e.id === own.id)).toMatchObject({ validUntil: null, workoutId: 'r1-B' });
    expect(restored.find((e) => e.id === keep.id)).toEqual(keep); // nunca tocada
  });

  it('bloqueia (nada revertido) se o dia foi alterado depois da importação', () => {
    const p = previewLegacyImport(input({ overrides }), { mode: 'empty_only' }, ctx());
    const after = apply([], p);
    const mondayEntry = after.find((e) => e.weekday === 1)!;
    const edited = after.map((e) => (e.id === mondayEntry.id ? { ...e, workoutId: 'r1-A', revision: 2 } : e));
    const undo = planUndoImport(record(p), edited, ctx());
    expect(undo.ok).toBe(false);
    expect(undo.problems.join(' ')).toMatch(/toda segunda-feira foi alterado depois/);
    expect(undo.put).toEqual([]);
    expect(undo.delete).toEqual([]);
    // Acrescentar algo num dia afetado também bloqueia (não apaga mudanças suas).
    const added = [...after, weekly(1, { routineId: 'r2', workoutId: 'r2-A', validFrom: WED })];
    expect(planUndoImport(record(p), added, ctx()).ok).toBe(false);
  });

  it('alterações em dias NÃO afetados não bloqueiam e são preservadas', () => {
    const p = previewLegacyImport(input({ overrides }), { mode: 'empty_only' }, ctx());
    const other = weekly(2, { workoutId: 'r1-A', validFrom: WED });
    const after = [...apply([], p), other];
    const undo = planUndoImport(record(p), after, ctx());
    expect(undo.ok).toBe(true);
    expect(apply(after, undo)).toEqual([other]);
  });

  it('em outro dia: semanais criadas são encerradas ontem (passado preservado); exceções passadas ficam', () => {
    const ov: DayOverride[] = [{ routineId: 'r1', date: THU, kind: 'rest' }, ...overrides];
    const p = previewLegacyImport(input({ overrides: ov }), { mode: 'empty_only' }, ctx());
    const after = apply([], p);
    const undo = planUndoImport(record(p), after, ctx(FRI));
    expect(undo.ok).toBe(true);
    const restored = apply(after, undo);
    expect(restored.filter((e) => e.scope === 'weekly').every((e) => e.validUntil === THU)).toBe(true);
    expect(restored.filter((e) => e.scope === 'date').map((e) => e.date)).toEqual([THU]); // passado fica; sexta (hoje) sai
    expect(undo.keptPast).toBe(1);
    expect(planForDate(restored, MON).source).toBe('none'); // de hoje em diante, sem a importação
  });

  it('não desfaz duas vezes', () => {
    const p = previewLegacyImport(input(), { mode: 'empty_only' }, ctx());
    expect(planUndoImport({ ...record(p), status: 'undone' }, apply([], p), ctx()).ok).toBe(false);
  });
});

describe('decisão explícita "usar a agenda anterior só neste dia"', () => {
  it('a data passa a ter só a escolha; o semanal não muda; repetir não duplica', () => {
    const w = weekly(5, { workoutId: 'r1-A' });
    const ch = replaceDate([w], { id: 'x1', date: FRI, kind: 'workout', activity: { routineId: 'r1', workoutId: 'r1-C' } }, ctx());
    const after = apply([w], ch);
    expect(planForDate(after, FRI).entries.map((e) => [e.scope, e.workoutId])).toEqual([['date', 'r1-C']]);
    expect(after.find((e) => e.id === w.id)).toEqual(w);
    expect(replaceDate(after, { id: 'x1', date: FRI, kind: 'workout', activity: { routineId: 'r1', workoutId: 'r1-C' } }, ctx()).put).toEqual([]);
    expect(() => replaceDate([w], { id: 'x2', date: '2026-10-20', kind: 'rest' }, ctx())).toThrow(/passados/);
  });
});

describe('central de divergências e calendário', () => {
  const base: CalendarInput = {
    today: WED,
    profileId: PID,
    entries: [],
    sessions: [],
    routines: [R1],
    rotations: [{ routineId: 'r1', nextIndex: 0, updatedAt: 0 }],
    legacy: { routineId: 'r1', trainingDays: [1, 3, 5], overrides: [] },
  };

  it('agrupa por tipo, sem repetir mensagens, com origem, impacto e ações; avisos antes de informações', () => {
    const entries = [weekly(3, { workoutId: 'r1-B' }), weekly(5, { kind: 'rest', routineId: null }), weekly(1, { kind: 'rest', routineId: null })];
    const days = resolveRange({ ...base, entries }, WED, '2026-11-08');
    const groups = groupConflicts(days, { includeInfo: true });
    expect(groups[0].severity).toBe('warning');
    const rest = groups.find((g) => g.kind === 'plan_rest_vs_legacy_workout' && g.severity === 'warning')!;
    expect(rest.days.map((d) => d.date)).toEqual([FRI, MON, '2026-11-06']);
    expect(rest.origin).toMatch(/Configurações/);
    expect(rest.impact).toMatch(/Vale o planejamento/);
    expect(rest.days[0].actions).toEqual(expect.arrayContaining(['open_day', 'edit_plan', 'see_legacy', 'legacy_for_day']));
    expect(rest.days[0].legacyChoice).toMatchObject({ kind: 'workout', workoutId: null, label: 'próximo da rotação' });
    for (const g of groups) for (const d of g.days) expect(new Set(d.messages).size).toBe(d.messages.length);
    // Sem informações: só avisos; nenhum aviso some.
    const onlyWarnings = groupConflicts(days, { includeInfo: false });
    expect(onlyWarnings.every((g) => g.severity === 'warning')).toBe(true);
    expect(onlyWarnings.reduce((a, g) => a + g.days.length, 0)).toBe(groups.filter((g) => g.severity === 'warning').reduce((a, g) => a + g.days.length, 0));
    expect(conflictCounts(days).warningDays).toBe(days.filter((d) => d.hasWarning).length);
  });

  it('reagendamento da agenda anterior: a escolha oferecida é o treino reagendado (nunca previsão como fixo)', () => {
    const entries = [weekly(5, { workoutId: 'r1-A' })];
    const days = resolveRange({ ...base, entries, legacy: { routineId: 'r1', trainingDays: [1, 3, 5], overrides: [{ routineId: 'r1', date: FRI, kind: 'workout', workoutId: 'r1-C' }] } }, FRI, FRI);
    const g = groupConflicts(days, { includeInfo: true }).find((x) => x.kind === 'plan_vs_legacy_workout')!;
    expect(g.days[0].legacyChoice).toMatchObject({ kind: 'workout', workoutId: 'r1-C', label: 'Treino C' });
  });

  it('depois de importar, a agenda anterior concorda com o planejamento: nada aparece duas vezes nem como divergência', () => {
    const p = previewLegacyImport(input({ entries: [] }), { mode: 'empty_only' }, ctx());
    const entries = apply([], p);
    const day = resolveDay({ ...base, entries }, WED);
    expect(day.legacyAgrees).toBe(true);
    expect(day.conflicts.filter((c) => c.kind.startsWith('plan_'))).toEqual([]);
    expect(day.entries.filter((e) => !e.shadowed && e.origin !== 'session').length).toBe(1);
    // Dia sem treino na agenda anterior continua sem nada (não virou descanso).
    expect(resolveDay({ ...base, entries }, THU).plan.source).toBe('none');
  });

  it('preferências só de apresentação: sanitização e estado exibido', () => {
    expect(sanitizePrefs(null)).toEqual(DEFAULT_CALENDAR_PREFS);
    expect(sanitizePrefs({ showLegacy: 'sim', defaultView: 'ano', showGoals: false })).toEqual({ ...DEFAULT_CALENDAR_PREFS, showGoals: false });
    const day = resolveDay(base, WED);
    expect(day.status).toBe('suggested');
    expect(displayStatus(day, { ...DEFAULT_CALENDAR_PREFS, showLegacy: false })).toBe('empty');
    expect(displayStatus(day, DEFAULT_CALENDAR_PREFS)).toBe('suggested');
    expect(day.status).toBe('suggested'); // o dia resolvido não muda
  });
});
