import { describe, expect, it } from 'vitest';
import { checkIntegrity, stableStringify, type IssueCode } from '@/lib/integrity';
import { entry, photo, rotation, routine, session, snapshot } from './fixtures';

const codes = (r: ReturnType<typeof checkIntegrity>) => r.issues.map((i) => i.code);
const find = (r: ReturnType<typeof checkIntegrity>, code: IssueCode) => r.issues.find((i) => i.code === code);

describe('verificação de integridade', () => {
  it('dados completamente válidos não geram problemas', () => {
    const r = checkIntegrity(snapshot());
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.counts).toEqual({ error: 0, warning: 0, info: 0 });
  });

  it('banco vazio é válido', () => {
    const r = checkIntegrity({ settings: null, routines: [], sessions: [], rotations: [], overrides: [], bodyEntries: [], photos: [], goals: [], planEntries: [], calendarDecisions: [] });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('foto órfã é aviso (preservada), não erro', () => {
    const r = checkIntegrity(snapshot({ photos: [photo('p9', 'nao-existe')] }));
    const i = find(r, 'PHOTO_ORPHAN')!;
    expect(i).toMatchObject({ severity: 'warning', collection: 'photos', id: 'p9' });
    expect(i.action).toMatch(/preservada/);
    expect(r.ok).toBe(true);
  });

  it('foto sem data URL de imagem é erro', () => {
    const r = checkIntegrity(snapshot({ photos: [photo('p1', 'b1', { dataUrl: 'https://exemplo.invalid/x.jpg' })] }));
    expect(find(r, 'PHOTO_INVALID_DATA')?.severity).toBe('error');
    expect(r.ok).toBe(false);
  });

  it('rotação de rotina inexistente e índice fora dos limites', () => {
    const r = checkIntegrity(snapshot({ rotations: [rotation('fantasma', 0), rotation('r1', 7)] }));
    expect(find(r, 'ROTATION_ORPHAN')).toMatchObject({ severity: 'warning', id: 'fantasma' });
    expect(find(r, 'ROTATION_INDEX_OUT_OF_RANGE')).toMatchObject({ severity: 'warning', id: 'r1' });
    const neg = checkIntegrity(snapshot({ rotations: [rotation('r1', -1)] }));
    expect(codes(neg)).toContain('ROTATION_INDEX_OUT_OF_RANGE');
    const frac = checkIntegrity(snapshot({ rotations: [rotation('r1', 1.5)] }));
    expect(find(frac, 'INVALID_NUMBER')?.severity).toBe('error');
  });

  it('substituição de calendário inválida', () => {
    const r = checkIntegrity(
      snapshot({
        overrides: [
          { routineId: 'r1', date: '2026-01-12', kind: 'workout', workoutId: 'r1-Z' },
          { routineId: 'r1', date: '2026-01-14', kind: 'workout' },
          { routineId: 'outra', date: '2026-01-15', kind: 'rest' },
          { routineId: 'r1', date: '2026-02-30', kind: 'rest' },
        ],
      }),
    );
    expect(r.issues.filter((i) => i.code === 'OVERRIDE_WORKOUT_MISSING')).toHaveLength(2);
    expect(find(r, 'OVERRIDE_ORPHAN')?.id).toBe('outra|2026-01-15');
    expect(find(r, 'INVALID_DATE')?.id).toBe('r1|2026-02-30');
    expect(r.ok).toBe(true);
  });

  it('IDs duplicados: conteúdo diferente é erro; idêntico é aviso', () => {
    const diff = checkIntegrity(snapshot({ sessions: [session('s1'), session('s1', { notes: 'outra' })] }));
    expect(find(diff, 'DUPLICATE_ID')).toMatchObject({ severity: 'error', collection: 'sessions', id: 's1' });
    expect(diff.ok).toBe(false);
    const same = checkIntegrity(snapshot({ bodyEntries: [entry('b1'), entry('b1')], photos: [] }));
    expect(find(same, 'DUPLICATE_ID_IDENTICAL')?.severity).toBe('warning');
    expect(same.ok).toBe(true);
  });

  it('identificadores vazios são erro', () => {
    const r = checkIntegrity(snapshot({ bodyEntries: [entry('  ')], photos: [] }));
    expect(find(r, 'INVALID_ID')?.severity).toBe('error');
    const w = checkIntegrity(snapshot({ routines: [routine('r1', { workouts: [{ id: '', label: 'A', name: 'A', exercises: [] }] })], sessions: [], overrides: [], rotations: [] }));
    expect(codes(w)).toContain('INVALID_ID');
  });

  it('referências inconsistentes dentro de uma rotina', () => {
    const r0 = routine();
    r0.workouts[1].id = r0.workouts[0].id;
    r0.workouts[2].exercises[1].id = r0.workouts[2].exercises[0].id;
    r0.workouts[2].exercises[0].repMin = 12;
    const r = checkIntegrity(snapshot({ routines: [r0], overrides: [] }));
    expect(codes(r)).toEqual(expect.arrayContaining(['ROUTINE_DUPLICATE_WORKOUT_ID', 'ROUTINE_DUPLICATE_EXERCISE_ID', 'ROUTINE_INVALID_REP_RANGE']));
  });

  it('referência histórica permitida: treino concluído de rotina excluída é apenas informativo', () => {
    const r = checkIntegrity(snapshot({ routines: [], rotations: [], overrides: [], settings: null }));
    const hist = r.issues.filter((i) => i.code === 'SESSION_HISTORICAL_REFERENCE');
    expect(hist).toHaveLength(2);
    expect(hist.every((i) => i.severity === 'info')).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.counts.warning).toBe(0);
  });

  it('treino em andamento sem rotina é aviso', () => {
    const r = checkIntegrity(snapshot({ sessions: [session('s1', { status: 'active', routineId: 'x' })] }));
    expect(find(r, 'SESSION_ACTIVE_ORPHAN')?.severity).toBe('warning');
  });

  it('múltiplas sessões ativas', () => {
    const r = checkIntegrity(snapshot({ sessions: [session('s1', { status: 'active' }), session('s2', { status: 'active' })] }));
    expect(find(r, 'SESSION_MULTIPLE_ACTIVE')).toMatchObject({ severity: 'warning', id: 's1, s2' });
  });

  it('valores numéricos e timestamps inválidos', () => {
    const s = session('s1', { finishedAt: 1 });
    s.exercises[0].sets[0].weight = -5;
    const r = checkIntegrity(
      snapshot({
        sessions: [s, session('s3', { startedAt: 0 })],
        bodyEntries: [entry('b1', { weightKg: -80, waistCm: Number.NaN }), entry('b2', { date: '10/01/2026' })],
        photos: [],
      }),
    );
    expect(r.issues.filter((i) => i.code === 'INVALID_TIMESTAMP').map((i) => [i.id, i.severity])).toEqual([
      ['s1', 'warning'],
      ['s3', 'error'],
    ]);
    expect(r.issues.filter((i) => i.code === 'INVALID_NUMBER').map((i) => i.collection)).toEqual(['sessions', 'bodyEntries']);
    expect(find(r, 'INVALID_DATE')?.id).toBe('b2');
  });

  it('dados obrigatórios ausentes não derrubam a verificação', () => {
    const broken = { ...session('s1') } as Record<string, unknown>;
    delete broken.exercises;
    const r = checkIntegrity(snapshot({ sessions: [broken as never] }));
    expect(find(r, 'MISSING_REQUIRED_FIELD')?.severity).toBe('error');
  });

  it('rotina ativa inexistente nas configurações', () => {
    const r = checkIntegrity(snapshot({ settings: { ...snapshot().settings!, activeRoutineId: 'zzz' } }));
    expect(find(r, 'SETTINGS_ACTIVE_ROUTINE_MISSING')?.severity).toBe('warning');
  });

  it('mensagens não expõem dados pessoais', () => {
    const e = entry('b1', { weightKg: -80, notes: 'anotação privada' });
    const r = checkIntegrity(snapshot({ settings: { ...snapshot().settings!, userName: 'Fulano', activeRoutineId: 'zzz' }, bodyEntries: [e], photos: [photo('p', 'x')] }));
    const text = JSON.stringify(r.issues);
    expect(text).not.toMatch(/Fulano|anotação privada|-80|base64,\//);
  });

  it('stableStringify ignora ordem de chaves e undefined', () => {
    expect(stableStringify({ b: 1, a: { d: undefined, c: [1, 2] } })).toBe(stableStringify({ a: { c: [1, 2] }, b: 1 }));
  });
});
