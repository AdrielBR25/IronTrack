// Reconhecimento assistido, catálogo expandido e construtor avançado (IronTrack 2.0 F01/P18): domínio puro.
// Catálogo v2 (IDs do P17 preservados, metadados, versionamento), normalização de nomes, motor de sugestões
// (classificação, motivos, avisos), associação/desassociação puras e como operação da ficha, adição e substituição
// múltiplas, "Mais utilizados", histórico de uso, e a garantia de que metas, sessões e analytics não mudam. Dados fictícios.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BULK_GOAL_NOTE,
  LINK_UNCHANGED,
  MATCH_THRESHOLDS,
  WorkoutOpError,
  addManyOp,
  applyWorkoutOp,
  bulkReplacePreview,
  catalogItem,
  customItem,
  customFieldErrors,
  foldText,
  instanceFingerprint,
  instanceFromItem,
  instancesForAddMany,
  isValidRef,
  legacyInventory,
  libraryItems,
  libraryKeyOf,
  linkComparison,
  linkInstance,
  mostUsed,
  nameSimilarity,
  nameTokens,
  newCustomExercise,
  plannedSets,
  recognitionSummary,
  recognize,
  refOfItem,
  replaceManyOp,
  sheetKeys,
  suggest,
  unlinkInstance,
  type CustomFields,
  type LibraryItem,
  type Recognition,
} from '@/modules/exercises';
import { CATALOG_VERSION, RETIRED_CATALOG_IDS, catalogById, getCatalog } from '@/modules/exercises/catalog';
import { normalizeSessions } from '@/modules/analytics';
import { computeGoalProgress, goalExerciseAvailability } from '@/modules/goals';
import { buildSession, type ExerciseTemplate, type Routine, type Workout, type WorkoutSession } from '@/modules/training';
import { DEFAULT_SETTINGS } from '@/lib/defaults';
import { PROFILE, ex, goal, goalRoutine, refOf, ses, set, supino } from './goalFixtures';

const catalog = getCatalog();
const items = libraryItems([], catalog);
const item = (id: string) => catalogItem(catalogById(id)!);
const REST = { restCompoundSec: 150, restIsolationSec: 90 };
const O = { muscleGroups: DEFAULT_SETTINGS.muscleGroups, rest: REST };

/** As 53 entradas publicadas no catálogo 1 (P17). Nunca podem sumir nem mudar de ID. */
const V1_IDS = [
  'supino-reto-barra', 'supino-inclinado-halteres', 'crucifixo-halteres', 'crossover-polia', 'flexao-de-bracos', 'puxada-frontal', 'remada-baixa',
  'remada-curvada', 'remada-unilateral', 'barra-fixa', 'desenvolvimento-halteres', 'elevacao-lateral', 'elevacao-frontal', 'crucifixo-inverso',
  'rosca-direta', 'rosca-alternada', 'rosca-martelo', 'rosca-concentrada', 'triceps-polia', 'triceps-frances', 'triceps-testa', 'mergulho-banco',
  'agachamento-livre', 'leg-press', 'cadeira-extensora', 'cadeira-extensora-unilateral', 'afundo', 'cadeira-abdutora', 'elevacao-pelvica',
  'mesa-flexora', 'cadeira-flexora', 'stiff', 'levantamento-terra-romeno', 'panturrilha-em-pe', 'panturrilha-sentado', 'abdominal-tradicional',
  'prancha', 'elevacao-de-pernas', 'abdominal-polia', 'caminhada', 'corrida', 'bicicleta-ergometrica', 'eliptico', 'remo-ergometrico', 'escada',
  'pular-corda', 'wall-sit', 'dead-hang', 'alongamento-estatico', 'paralelas', 'agachamento-peso-corporal', 'burpee', 'elevacao-lateral-unilateral',
];

const tpl = (id: string, name: string, over: Partial<ExerciseTemplate> = {}): ExerciseTemplate => ({
  id,
  name,
  muscleGroup: 'Peito',
  category: 'compound',
  equipment: 'barbell',
  sets: 3,
  repMin: 8,
  repMax: 12,
  restSec: 90,
  warmupSets: 0,
  ...over,
});
const workout = (exercises: ExerciseTemplate[], id = 'w1'): Workout => ({ id, label: 'A', name: 'Peito e tríceps', exercises });
const routineOf = (workouts: Workout[], over: Partial<Routine> = {}): Routine => ({ id: 'r1', profileId: PROFILE, name: 'Rotina', workouts, createdAt: 1, updatedAt: 1, ...over });

describe('catálogo expandido (versão 2)', () => {
  it('tem pelo menos 100 exercícios distintos e preserva todos os IDs do catálogo 1', () => {
    expect(catalog.length).toBeGreaterThanOrEqual(100);
    expect(CATALOG_VERSION).toBe(2);
    const ids = catalog.map((c) => c.catalogId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of V1_IDS) expect(catalogById(id), id).toBeDefined();
    expect(catalog.filter((c) => c.since === 1).map((c) => c.catalogId).sort()).toEqual([...V1_IDS].sort());
    // A ordem das entradas antigas não muda (as novas vêm depois).
    expect(ids.slice(0, V1_IDS.length)).toEqual(V1_IDS);
    expect(catalog.filter((c) => c.since === 2).length).toBeGreaterThanOrEqual(47);
    expect(catalog.every((c) => c.since >= 1 && c.since <= CATALOG_VERSION)).toBe(true);
    // Nenhum ID retirado (e, se houver no futuro, nunca reutilizado).
    expect(RETIRED_CATALOG_IDS).toEqual([]);
    for (const id of RETIRED_CATALOG_IDS) expect(ids).not.toContain(id);
  });

  it('nomes distintos e sem duplicatas semânticas: nenhum nome novo é apelido de outra entrada', () => {
    const names = catalog.map((c) => foldText(c.name));
    expect(new Set(names).size).toBe(names.length);
    const owner = new Map<string, string>();
    for (const c of catalog) for (const a of c.aliases) owner.set(foldText(a), c.catalogId);
    for (const c of catalog.filter((x) => x.since === 2)) {
      const o = owner.get(foldText(c.name));
      if (o) expect(o, c.catalogId).toBe(c.catalogId);
    }
    // Apelidos novos não repetem apelidos/nomes de outra entrada (a única coincidência herdada do P17 continua única).
    const seen = new Map<string, string[]>();
    for (const c of catalog) for (const t of [c.name, ...c.aliases]) seen.set(foldText(t), [...new Set([...(seen.get(foldText(t)) ?? []), c.catalogId])]);
    const shared = [...seen.entries()].filter(([, v]) => v.length > 1).map(([k]) => k);
    expect(shared).toEqual(['agachamento livre']);
  });

  it('cobre as categorias pedidas e inclui os exemplos do Prompt 18', () => {
    const has = (n: string) => catalog.some((c) => c.name === n);
    for (const n of [
      'Supino declinado', 'Supino máquina', 'Voador (peck deck)', 'Pullover com halter', 'Remada cavalinho', 'Remada articulada', 'Puxada com pegada neutra',
      'Face pull', 'Desenvolvimento militar', 'Elevação lateral na polia', 'Rosca Scott', 'Rosca na polia', 'Rosca inversa', 'Tríceps corda',
      'Tríceps unilateral na polia', 'Agachamento frontal', 'Agachamento sumô', 'Hack squat', 'Agachamento búlgaro', 'Passada', 'Cadeira adutora',
      'Flexora unilateral', 'Ponte de glúteo', 'Coice na polia', 'Panturrilha no leg press', 'Abdominal bicicleta', 'Abdominal infra (reverso)',
      'Russian twist', 'Mountain climber', 'Prancha lateral', "Farmer's walk", 'Remo ergométrico', 'Corrida intervalada', 'Subida no banco (step-up)',
    ])
      expect(has(n), n).toBe(true);
    const groups = ['peitoral', 'costas', 'ombros', 'biceps', 'triceps', 'quadriceps', 'posteriores', 'gluteos', 'panturrilhas', 'abdomen'] as const;
    for (const g of groups) expect(catalog.filter((c) => c.since === 2 && c.primaryMuscles.includes(g)).length, g).toBeGreaterThan(0);
    expect(catalog.filter((c) => c.since === 2 && c.modality === 'cardio').length).toBeGreaterThan(0);
    expect(catalog.filter((c) => c.since === 2 && c.modality === 'timed').length).toBeGreaterThan(0);
    expect(catalog.filter((c) => c.since === 2 && c.tags.includes('calistenia')).length).toBeGreaterThan(0);
  });

  it('metadados completos e coerentes nas entradas novas (mesmas regras dos personalizados e do modelo v3)', () => {
    for (const c of catalog.filter((x) => x.since === 2)) {
      const where = c.catalogId;
      expect(c.aliases.length, where).toBeGreaterThan(0);
      expect(c.instructions.length, where).toBeGreaterThanOrEqual(2);
      expect(c.commonMistakes.length, where).toBeGreaterThan(0);
      expect(c.safetyNotes.length, where).toBeGreaterThan(0);
      expect(c.version, where).toBe(1);
      expect(c.source).toBe('irontrack-base');
      expect(c.secondaryMuscles.some((m) => c.primaryMuscles.includes(m)), where).toBe(false);
      expect(new Set(c.equipment).size, where).toBe(c.equipment.length);
      expect(customFieldErrors({ name: c.name, modality: c.modality, primaryMuscle: c.primaryMuscles[0], secondaryMuscles: c.secondaryMuscles.slice(0, 4), equipment: c.equipment.slice(0, 4), laterality: c.laterality, loadMode: c.loadMode, mechanics: c.mechanics }), where).toEqual([]);
      if (c.modality === 'cardio' || c.modality === 'timed') expect(c.mechanics, where).toBeNull();
      const all = [...c.instructions, ...c.commonMistakes, ...c.safetyNotes].join(' ');
      expect(all, where).not.toMatch(/\d+\s*(kg|%|rm\b|min|s\b|reps?)|1rm|ativação|garante|cura|trata|emagrec|queima/i);
      // Cada entrada gera uma instância válida na ficha (modelo v3).
      const t = instanceFromItem(catalogItem(c), { ...O, id: `t-${c.catalogId}` });
      expect(t.catalogId).toBe(c.catalogId);
      expect(t.targetWeight).toBeUndefined();
    }
    for (const id of ['supino-maquina', 'agachamento-frontal', 'levantamento-terra', 'hack-squat']) expect(catalogById(id)!.mechanics).toBe('compound');
    for (const id of ['rosca-scott', 'triceps-corda', 'peck-deck', 'cadeira-adutora', 'flexora-unilateral']) expect(catalogById(id)!.mechanics).toBe('isolation');
    for (const id of ['agachamento-bulgaro', 'passada', 'step-up', 'triceps-unilateral-polia', 'flexora-unilateral', 'coice-polia', 'prancha-lateral']) expect(catalogById(id)!.laterality).toBe('unilateral');
  });

  it('versionamento: apelidos que viraram entradas próprias subiram a versão da entrada antiga, sem trocar ID nem redirecionar', () => {
    expect(catalogById('triceps-polia')).toMatchObject({ version: 2, since: 1 });
    expect(catalogById('triceps-polia')!.aliases).not.toContain('tríceps corda');
    expect(catalogById('triceps-corda')!.aliases).toContain('tríceps na corda');
    expect(catalogById('afundo')).toMatchObject({ version: 2 });
    expect(catalogById('afundo')!.aliases).not.toContain('passada');
    expect(catalogById('elevacao-de-pernas')).toMatchObject({ version: 2 });
    expect(catalogById('elevacao-lateral-unilateral')).toMatchObject({ version: 2, equipment: ['halteres'] });
    // Uma instância criada com a versão 1 continua apontando para o mesmo ID e guarda a versão copiada.
    const old = tpl('old', 'Tríceps na polia', { catalogId: 'triceps-polia', catalogVersion: 1 });
    expect(libraryKeyOf(old)).toBe('catalog:triceps-polia');
    expect(old.catalogVersion).toBe(1);
    // Novas instâncias copiam a versão atual da entrada.
    expect(instanceFromItem(item('triceps-polia'), { ...O, id: 'n' }).catalogVersion).toBe(2);
  });

  it('o catálogo continua estático e fora do índice do módulo (bundle principal)', () => {
    const idx = readFileSync(resolve('src/modules/exercises/index.ts'), 'utf8');
    expect(idx).not.toMatch(/from '\.\/catalog/);
    for (const f of ['catalog/index.ts', 'catalog/expansion.ts', 'catalog/entry.ts']) {
      const src = readFileSync(resolve('src/modules/exercises', f), 'utf8');
      expect(src, f).not.toMatch(/https?:\/\/|fetch\(|import\(|\.png|\.jpg|\.webp|localStorage/);
    }
  });
});

describe('normalização de nomes', () => {
  it('ignora acentos, maiúsculas, palavras de ligação e plural simples', () => {
    expect(nameTokens('Supino Inclinado com Halteres')).toEqual(['supino', 'inclinado', 'halter']);
    expect(nameTokens('  TRÍCEPS   na   polia ')).toEqual(['tricep', 'polia']);
    expect(nameSimilarity('Rosca Direta', 'rosca direta')).toBe(1);
    expect(nameSimilarity('Supino inclinado', 'Supino inclinado com halteres')).toBeCloseTo(0.8);
    expect(nameSimilarity('Rosca', 'Rosca direta')).toBeCloseTo(2 / 3);
    expect(nameSimilarity('Supino', 'Agachamento')).toBe(0);
    expect(nameSimilarity('', 'Supino')).toBe(0);
  });
});

describe('motor de sugestões', () => {
  it('correspondência forte: nome igual a um apelido, mesmo grupo, modalidade e equipamento — com explicação', () => {
    const t = tpl('e1', 'Supino inclinado', { equipment: 'dumbbell' });
    const r = recognize(t, items);
    expect(r.tier).toBe('forte');
    expect(r.candidates[0].item.refId).toBe('supino-inclinado-halteres');
    expect(r.candidates[0].via).toBe('apelido');
    expect(r.candidates[0].explanation).toBe('Nome igual a um apelido do exercício da biblioteca, mesmo grupo muscular, modalidade compatível e mesmo equipamento.');
    expect(r.candidates[0].warnings).toEqual([]);
    expect(r.candidates.length).toBeLessThanOrEqual(MATCH_THRESHOLDS.maxCandidates);
  });

  it('divergência de equipamento rebaixa para "possível" e explica', () => {
    const r = recognize(tpl('e1', 'Supino inclinado', { equipment: 'barbell' }), items);
    const top = r.candidates[0];
    expect(top.item.refId).toBe('supino-inclinado-barra');
    expect(top.tier).toBe('forte');
    const halteres = r.candidates.find((c) => c.item.refId === 'supino-inclinado-halteres')!;
    expect(halteres.tier).toBe('possivel');
    expect(halteres.warnings.join(' ')).toMatch(/Equipamento diferente: ficha Barra/);
  });

  it('divergência de modalidade e de tipo de carga geram aviso claro (e nunca correspondência forte)', () => {
    const plank = recognize(tpl('p', 'Prancha', { modality: 'bodyweight', loadMode: 'corporal', equipment: 'bodyweight', muscleGroup: 'Abdômen' }), items);
    const c = plank.candidates.find((x) => x.item.refId === 'prancha')!;
    expect(c.tier).toBe('possivel');
    expect(c.warnings.join(' ')).toMatch(/Modalidade diferente.*Associar não muda a modalidade da ficha/);
    const barra = recognize(tpl('b', 'Barra fixa', { modality: 'bodyweight', loadMode: 'assistida', equipment: 'bodyweight', muscleGroup: 'Costas' }), items);
    const bc = barra.candidates.find((x) => x.item.refId === 'barra-fixa')!;
    expect(bc.tier).toBe('possivel');
    expect(bc.warnings.join(' ')).toMatch(/Tipo de carga diferente/);
  });

  it('não sugere só porque trabalha o mesmo músculo; nome sem semelhança = sem sugestão confiável', () => {
    const r = recognize(tpl('x', 'Exercício do professor Zé', { muscleGroup: 'Peito' }), items);
    expect(r).toEqual({ tier: 'nenhuma', candidates: [] });
    const r2 = recognize(tpl('y', 'Supino', { muscleGroup: 'Costas' }), items);
    // "Supino" é parecido com vários supinos, mas o grupo diverge: só "possível", com aviso de grupo.
    expect(r2.tier).toBe('possivel');
    expect(r2.candidates.every((c) => c.warnings.some((w) => /Grupo muscular diferente/.test(w)))).toBe(true);
  });

  it('nome genérico ("Rosca") vira no máximo "possível", ordenado e determinístico', () => {
    const t = tpl('r', 'Rosca', { muscleGroup: 'Bíceps', equipment: 'dumbbell', category: 'isolation' });
    const a = recognize(t, items);
    const b = recognize(t, [...items].reverse());
    expect(a).toEqual(b);
    expect(a.candidates.every((c) => c.tier === 'possivel')).toBe(true);
    expect(a.candidates[0].reasons).toContain('mesmo equipamento');
  });

  it('arquivados nunca são sugeridos; personalizados ativos sim', () => {
    const f: CustomFields = { name: 'Remada máquina hammer', modality: 'resistance', primaryMuscle: 'costas', secondaryMuscles: [], equipment: ['maquina'], laterality: 'bilateral', loadMode: 'externa', mechanics: 'compound' };
    const active = customItem(newCustomExercise('cx_aaaaaaaa-1111', f, 1));
    const archived = { ...customItem(newCustomExercise('cx_bbbbbbbb-2222', { ...f, name: 'Remada hammer velha' }, 1)), archived: true };
    const r = recognize(tpl('h', 'Remada máquina hammer', { muscleGroup: 'Costas', equipment: 'machine' }), [...items, active, archived]);
    expect(r.candidates[0].item.key).toBe(active.key);
    expect(r.candidates.some((c) => c.item.key === archived.key)).toBe(false);
  });

  it('a sugestão é só descrição: reconhecer não altera a instância', () => {
    const t = tpl('e1', 'Supino inclinado', { equipment: 'dumbbell' });
    const before = JSON.stringify(t);
    recognize(t, items);
    expect(JSON.stringify(t)).toBe(before);
    expect(libraryKeyOf(t)).toBeNull();
  });
});

describe('inventário e resumo', () => {
  it('agrupa por rotina/treino, separa sem origem e já associados, conta treinos afetados e sugestões', () => {
    const r = routineOf([
      workout([tpl('a', 'Supino inclinado', { equipment: 'dumbbell' }), tpl('b', 'Coisa estranha'), tpl('c', 'Leg press', { catalogId: 'leg-press', catalogVersion: 1 })], 'w1'),
      workout([tpl('d', 'Crucifixo', { equipment: 'dumbbell' })], 'w2'),
      workout([tpl('e', 'Corrida', { modality: 'cardio', customExerciseId: 'cx_aaaaaaaa-1111' })], 'w3'),
    ]);
    const other = { ...routineOf([workout([tpl('z', 'Supino')])]), id: 'r2', profileId: 'outro-perfil' };
    const inv = legacyInventory([r, other], PROFILE);
    expect(inv.unlinked.map((e) => e.exercise.id)).toEqual(['a', 'b', 'd']);
    expect(inv.linked.map((e) => e.exercise.id)).toEqual(['c', 'e']);
    expect(inv.workoutsAffected).toBe(2);
    expect(inv.unlinked[2]).toMatchObject({ workoutId: 'w2', position: 0, routineName: 'Rotina' });
    const recs = new Map<string, Recognition>(inv.unlinked.map((e) => [e.exercise.id, recognize(e.exercise, items)]));
    expect(recognitionSummary(inv, recs)).toEqual({ unlinked: 3, workoutsAffected: 2, withSuggestions: 2, manual: 1, linked: 2 });
  });
});

describe('associar e desassociar (puro)', () => {
  const base = tpl('inst-1', 'Supino inclinado', { equipment: 'dumbbell', targetWeight: 24, notes: 'pegada neutra', warmupSets: 1, sets: 4 });

  it('associar acrescenta SÓ a referência de origem; nome, ID e parâmetros continuam iguais', () => {
    const ref = refOfItem(item('supino-inclinado-halteres'));
    expect(ref).toEqual({ catalogId: 'supino-inclinado-halteres', catalogVersion: 1 });
    const linked = linkInstance(base, ref);
    expect(linked).toEqual({ ...base, catalogId: 'supino-inclinado-halteres', catalogVersion: 1 });
    expect(linked.id).toBe('inst-1');
    expect(linked.name).toBe('Supino inclinado');
    expect(linked.modality).toBeUndefined();
    // Desassociar devolve exatamente o registro original.
    expect(unlinkInstance(linked)).toEqual(base);
    const custom = linkInstance(base, { customExerciseId: 'cx_aaaaaaaa-1111' });
    expect(custom.catalogId).toBeUndefined();
    expect(custom.customExerciseId).toBe('cx_aaaaaaaa-1111');
  });

  it('referência válida: catálogo com versão inteira ou personalizado cx_; nunca as duas', () => {
    expect(isValidRef({ catalogId: 'leg-press', catalogVersion: 1 })).toBe(true);
    expect(isValidRef({ catalogId: 'Leg Press', catalogVersion: 1 })).toBe(false);
    expect(isValidRef({ catalogId: 'leg-press', catalogVersion: 0 })).toBe(false);
    expect(isValidRef({ catalogId: 'leg-press', catalogVersion: 1, customExerciseId: 'cx_aaaaaaaa-1111' })).toBe(false);
    expect(isValidRef({ customExerciseId: 'cx_aaaaaaaa-1111' })).toBe(true);
    expect(isValidRef({ customExerciseId: 'leg-press' })).toBe(false);
    expect(isValidRef(null)).toBe(false);
  });

  it('comparação lista o que muda (só a origem) e o que permanece', () => {
    const c = linkComparison(base, item('supino-inclinado-halteres'), '4 × 8–12');
    expect(c.changes).toHaveLength(1);
    expect(c.changes[0]).toMatch(/Referência de origem/);
    expect(c.unchanged).toEqual([...LINK_UNCHANGED]);
    expect(c.unchanged).toEqual(expect.arrayContaining(['Nome atual na ficha', 'ID da instância', 'Metas', 'Sessões antigas', 'Analytics']));
    expect(c.current).toMatchObject({ name: 'Supino inclinado', modality: 'Não informada (carga × repetições)', equipment: 'Halteres', notes: 'pegada neutra' });
    expect(c.library).toMatchObject({ name: 'Supino inclinado com halteres', laterality: 'bilateral', loadMode: 'carga externa' });
  });

  it('impressão digital estável (ordem das chaves) e sensível a qualquer mudança', () => {
    const a = instanceFingerprint(base);
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as ExerciseTemplate;
    expect(instanceFingerprint(reordered)).toBe(a);
    expect(instanceFingerprint({ ...base, sets: 5 })).not.toBe(a);
    expect(instanceFingerprint({ ...base, notes: undefined })).not.toBe(a);
  });
});

describe('associação como operação da ficha', () => {
  const t = tpl('i1', 'Supino inclinado', { equipment: 'dumbbell' });
  const w = workout([t, tpl('i2', 'Crucifixo')]);
  const ref = refOfItem(item('supino-inclinado-halteres'));

  it('associa com a impressão digital da prévia; repetir é idempotente; nunca sobrescreve outra origem', () => {
    const r = applyWorkoutOp(w, { type: 'link', id: 'i1', expected: instanceFingerprint(t), ref });
    expect(r.changed).toBe(true);
    expect(r.workout.exercises[0]).toEqual({ ...t, ...ref });
    expect(r.workout.exercises[1]).toBe(w.exercises[1]);
    // Toque duplo / outra aba com a mesma escolha: nada muda.
    expect(applyWorkoutOp(r.workout, { type: 'link', id: 'i1', expected: instanceFingerprint(t), ref }).changed).toBe(false);
    // Outra origem já gravada: recusa.
    expect(() => applyWorkoutOp(r.workout, { type: 'link', id: 'i1', expected: instanceFingerprint(r.workout.exercises[0]), ref: { catalogId: 'supino-inclinado-barra', catalogVersion: 1 } })).toThrow(
      expect.objectContaining({ code: 'already_linked' }),
    );
  });

  it('instância alterada entre a prévia e a confirmação: recusa (changed); removida: missing_exercise', () => {
    const edited = workout([{ ...t, sets: 5 }, w.exercises[1]]);
    expect(() => applyWorkoutOp(edited, { type: 'link', id: 'i1', expected: instanceFingerprint(t), ref })).toThrow(expect.objectContaining({ code: 'changed' }));
    expect(() => applyWorkoutOp(workout([w.exercises[1]]), { type: 'link', id: 'i1', expected: instanceFingerprint(t), ref })).toThrow(expect.objectContaining({ code: 'missing_exercise' }));
    expect(() => applyWorkoutOp(w, { type: 'link', id: 'i1', expected: instanceFingerprint(t), ref: { catalogId: 'X', catalogVersion: 1 } as never })).toThrow(expect.objectContaining({ code: 'invalid_ref' }));
  });

  it('desassociar: só tira a origem; idempotente; recusa se mudou desde a prévia', () => {
    const linked = applyWorkoutOp(w, { type: 'link', id: 'i1', expected: instanceFingerprint(t), ref }).workout;
    const cur = linked.exercises[0];
    const un = applyWorkoutOp(linked, { type: 'unlink', id: 'i1', expected: instanceFingerprint(cur) });
    expect(un.workout.exercises[0]).toEqual(t);
    expect(applyWorkoutOp(un.workout, { type: 'unlink', id: 'i1', expected: instanceFingerprint(cur) }).changed).toBe(false);
    expect(() => applyWorkoutOp(workout([{ ...cur, restSec: 30 }]), { type: 'unlink', id: 'i1', expected: instanceFingerprint(cur) })).toThrow(expect.objectContaining({ code: 'changed' }));
    // Associar de novo desfaz a desassociação.
    expect(applyWorkoutOp(un.workout, { type: 'link', id: 'i1', expected: instanceFingerprint(t), ref }).workout.exercises[0]).toEqual(cur);
  });
});

describe('adição múltipla', () => {
  const lines = [
    { item: item('supino-maquina'), id: 'n1' },
    { item: item('peck-deck'), id: 'n2' },
    { item: item('peck-deck'), id: 'n3' },
  ];

  it('ordem previsível, IDs próprios, configuração padrão sem carga, mesmo item só com linha explícita', () => {
    const exs = instancesForAddMany(lines, O);
    expect(exs.map((e) => e.id)).toEqual(['n1', 'n2', 'n3']);
    expect(exs.map((e) => e.catalogId)).toEqual(['supino-maquina', 'peck-deck', 'peck-deck']);
    expect(exs.every((e) => e.targetWeight === undefined && e.warmupSets === 0)).toBe(true);
    expect(exs[0]).toMatchObject({ sets: 3, repMin: 8, repMax: 12, restSec: 150 });
    expect(exs[1].restSec).toBe(90);
    const archived = { ...customItem(newCustomExercise('cx_aaaaaaaa-1111', { name: 'X', modality: 'resistance', primaryMuscle: 'costas', secondaryMuscles: [], equipment: ['maquina'], laterality: 'bilateral', loadMode: 'externa', mechanics: null }, 1)), archived: true };
    expect(instancesForAddMany([{ item: archived, id: 'z' }], O)).toEqual([]);
  });

  it('aplica no fim, tudo ou nada; reenvio (toque duplo) não duplica; respeita o limite', () => {
    const w = workout([tpl('a', 'A')]);
    const exs = instancesForAddMany(lines, O);
    const r = applyWorkoutOp(w, addManyOp(exs));
    expect(r.workout.exercises.map((e) => e.id)).toEqual(['a', 'n1', 'n2', 'n3']);
    expect(applyWorkoutOp(r.workout, addManyOp(exs)).changed).toBe(false);
    // Parte já gravada e parte não: estado inesperado, recusa sem gravar.
    expect(() => applyWorkoutOp(applyWorkoutOp(w, addManyOp(exs.slice(0, 1))).workout, addManyOp(exs))).toThrow(WorkoutOpError);
    expect(() => applyWorkoutOp(w, addManyOp([exs[0], exs[0]]))).toThrow(expect.objectContaining({ code: 'duplicate_id' }));
    const full = workout(Array.from({ length: 299 }, (_, i) => tpl(`f${i}`, `F${i}`)));
    expect(() => applyWorkoutOp(full, addManyOp(exs))).toThrow(expect.objectContaining({ code: 'limit' }));
  });

  it('séries planejadas são uma estimativa da ficha', () => {
    expect(plannedSets([{ sets: 3 }, { sets: 4 }, { sets: NaN }, { sets: -1 }])).toBe(7);
  });
});

describe('substituição múltipla', () => {
  const w = workout([tpl('s1', 'Supino reto', { targetWeight: 80, notes: 'x' }), tpl('s2', 'Crucifixo', { equipment: 'dumbbell', category: 'isolation' }), tpl('s3', 'Tríceps testa', { muscleGroup: 'Tríceps' }), tpl('s4', 'Prancha', { modality: 'timed', targetDurationSec: 45, equipment: 'bodyweight' })]);
  const picks = [
    { id: 's1', item: item('supino-maquina'), newId: 'n1' },
    { id: 's3', item: item('triceps-corda'), newId: 'n3' },
    { id: 's2', item: item('peck-deck'), newId: 'n2' },
  ];
  const goals = new Map([
    ['s1', 2],
    ['s2', 0],
    ['s3', 1],
  ]);

  it('prévia: original × substituto, preservados/descartados, metas afetadas, novas identidades e ordem final', () => {
    const pv = bulkReplacePreview(w, picks, O, goals);
    expect(pv.rows.map((r) => [r.current.id, r.next.id])).toEqual([
      ['s1', 'n1'],
      ['s2', 'n2'],
      ['s3', 'n3'],
    ]);
    expect(pv.rows[0].kept).toEqual(['séries', 'descanso', 'repetições']);
    expect(pv.rows[0].dropped.join(' ')).toMatch(/carga planejada/);
    expect(pv.rows[0].next.targetWeight).toBeUndefined();
    expect(pv.linkedGoals).toBe(3);
    expect(pv.goalNote).toBe(BULK_GOAL_NOTE);
    expect(BULK_GOAL_NOTE).toBe('As metas vinculadas ao exercício anterior continuarão vinculadas a ele.');
    expect(pv.finalOrder.map((o) => o.name)).toEqual(['Supino máquina', 'Voador (peck deck)', 'Tríceps corda', 'Prancha']);
    expect(pv.finalOrder.map((o) => o.replaced)).toEqual([true, true, true, false]);
    // Modalidade diferente entra nos avisos.
    const swap = bulkReplacePreview(w, [{ id: 's4', item: item('abdominal-bicicleta'), newId: 'n4' }], O, new Map());
    expect(swap.rows[0].modalityNotes.join(' ')).toMatch(/duração para repetições/);
    expect(swap.rows[0].dropped.join(' ')).toMatch(/duração planejada/);
  });

  it('aplica na posição dos originais (tudo ou nada); recusa se algo mudou; reenvio é idempotente', () => {
    const pv = bulkReplacePreview(w, picks, O, goals);
    const op = replaceManyOp(pv);
    const r = applyWorkoutOp(w, op);
    expect(r.workout.exercises.map((e) => e.id)).toEqual(['n1', 'n2', 'n3', 's4']);
    expect(applyWorkoutOp(r.workout, op).changed).toBe(false);
    // Outra aba editou um dos marcados: nada é aplicado.
    const edited = { ...w, exercises: w.exercises.map((e) => (e.id === 's3' ? { ...e, sets: 9 } : e)) };
    expect(() => applyWorkoutOp(edited, op)).toThrow(expect.objectContaining({ code: 'changed' }));
    // Outra aba reordenou: as trocas vão para as posições atuais; nada se perde.
    const reordered = { ...w, exercises: [w.exercises[3], w.exercises[2], w.exercises[1], w.exercises[0]] };
    expect(applyWorkoutOp(reordered, op).workout.exercises.map((e) => e.id)).toEqual(['s4', 'n3', 'n2', 'n1']);
    // Outra aba removeu um dos marcados: recusa.
    expect(() => applyWorkoutOp({ ...w, exercises: w.exercises.filter((e) => e.id !== 's2') }, op)).toThrow(expect.objectContaining({ code: 'missing_exercise' }));
    // Exercício removido antes da prévia fica de fora e é informado.
    expect(bulkReplacePreview({ ...w, exercises: w.exercises.slice(1) }, picks, O, goals).missing).toEqual(['s1']);
  });

  it('metas e histórico continuam com os IDs antigos (nada é redirecionado)', () => {
    const r = applyWorkoutOp(w, replaceManyOp(bulkReplacePreview(w, picks, O, goals))).workout;
    const g = goal({ type: 'max_load', exercise: refOf(['s1']), targetValue: 100 });
    const routine = routineOf([r]);
    expect(g.exercise!.templateIds).toEqual(['s1']);
    // O ID antigo saiu da ficha: a meta continua ligada a ele (estado "removido"), nunca ao substituto.
    expect(goalExerciseAvailability(g.exercise!, [routine]).state).toBe('removido');
  });
});

describe('histórico de uso e "Mais utilizados"', () => {
  const linked = (k: string, sets = [set(50, 8)]) => ex('t1', 'Supino', sets, { catalogId: k });
  const sessions: WorkoutSession[] = [
    ses('s1', '2026-03-02', [linked('supino-maquina'), linked('supino-maquina'), ex('t2', 'Coisa antiga', [set(10, 10)])]),
    ses('s2', '2026-03-04', [linked('supino-maquina'), linked('peck-deck')]),
    ses('s3', '2026-03-06', [linked('peck-deck', [set(30, 10, { status: 'pending' })])]),
    ses('s4', '2026-03-07', [linked('peck-deck', [set(30, 10, { type: 'warmup' })])]),
    ses('s5', '2026-03-08', [linked('leg-press')], { status: 'in_progress' as WorkoutSession['status'] }),
    ses('s6', '2026-03-09', [linked('leg-press')], { profileId: 'outro-perfil' }),
  ];

  it('conta sessões concluídas distintas pela origem gravada; ignora planejado, aquecimento, outros perfis e repetidas', () => {
    const m = mostUsed([...sessions, sessions[0]], PROFILE);
    expect(m.ranked.map((r) => [r.key, r.sessions])).toEqual([
      ['catalog:supino-maquina', 2],
      ['catalog:peck-deck', 1],
    ]);
    expect(m.sessionsConsidered).toBe(4);
    expect(m.unlinkedExecutions).toBe(1);
    expect(m.unlinkedSessions).toBe(1);
  });

  it('sem contagem por nome: nomes iguais sem origem não viram item da biblioteca', () => {
    const m = mostUsed([ses('x', '2026-03-02', [ex('t', 'Supino máquina', [set(40, 8)]), ex('u', 'Supino máquina', [set(40, 8)])])], PROFILE);
    expect(m.ranked).toEqual([]);
    expect(m.unlinkedExecutions).toBe(2);
  });

  it('associar hoje não transforma sessões antigas em uso do item (sem origem retroativa)', () => {
    const t = tpl('old', 'Supino máquina', { equipment: 'machine' });
    const old = buildSession(routineOf([workout([t])]), workout([t]), [], 1000);
    old.status = 'completed';
    old.exercises[0].sets = old.exercises[0].sets.map((s) => ({ ...s, status: 'done' as const }));
    const linkedT = linkInstance(t, refOfItem(item('supino-maquina')));
    const fresh = buildSession(routineOf([workout([linkedT])]), workout([linkedT]), [], 2000);
    expect(old.exercises[0].catalogId).toBeUndefined();
    expect(fresh.exercises[0].catalogId).toBe('supino-maquina');
    // A sessão antiga continua sem origem e não conta.
    expect(mostUsed([old], null).ranked).toEqual([]);
  });

  it('presença em ficha é outra evidência (instâncias), separada do uso em sessão; sugestões a usam como motivo', () => {
    const r = routineOf([workout([tpl('a', 'X', { catalogId: 'leg-press', catalogVersion: 1 }), tpl('b', 'Y', { catalogId: 'leg-press', catalogVersion: 1 }), tpl('c', 'Z')])]);
    const keys = sheetKeys([r, { ...r, id: 'r2', profileId: 'outro' }], PROFILE);
    expect([...keys]).toEqual([['catalog:leg-press', 2]]);
    const s = suggest({ items, favorites: new Set(), recent: [], inSheets: new Set(keys.keys()) });
    expect(s).toEqual([{ item: item('leg-press'), reason: 'na_ficha' }]);
  });
});

describe('metas e analytics antes × depois da associação', () => {
  it('associar não muda metas (templateIds), progresso, analytics (exerciseKey) nem as sessões existentes', () => {
    const routine = goalRoutine();
    const sessions = [ses('a', '2026-03-02', [supino('sup-A', [set(60, 8)])]), ses('b', '2026-03-05', [supino('sup-A', [set(65, 8)])])];
    const g = goal({ type: 'max_load', exercise: refOf(['sup-A']), targetValue: 70 });
    const before = { progress: computeGoalProgress(g, sessions, '2026-03-06'), analytics: normalizeSessions(sessions), sessions: JSON.stringify(sessions) };
    const w = routine.workouts[0];
    const t = w.exercises[0];
    const linked = applyWorkoutOp(w, { type: 'link', id: t.id, expected: instanceFingerprint(t), ref: refOfItem(item('supino-reto-barra')) }).workout;
    const after = { ...routine, workouts: [linked, ...routine.workouts.slice(1)] };
    expect(after.workouts[0].exercises[0].id).toBe('sup-A');
    expect(after.workouts[0].exercises[0].name).toBe('Supino reto');
    expect(goalExerciseAvailability(g.exercise!, [after])).toEqual(goalExerciseAvailability(g.exercise!, [routine]));
    expect(goalExerciseAvailability(g.exercise!, [after]).state).toBe('disponivel');
    expect(computeGoalProgress(g, sessions, '2026-03-06')).toEqual(before.progress);
    expect(normalizeSessions(sessions)).toEqual(before.analytics);
    expect(JSON.stringify(sessions)).toBe(before.sessions);
    // Próximas sessões da instância associada mantêm templateId e exerciseKey (só ganham a origem).
    const next = buildSession(after, after.workouts[0], sessions, 3000).exercises[0];
    const prev = buildSession(routine, routine.workouts[0], sessions, 3000).exercises[0];
    expect({ ...next, id: '', sets: [] }).toEqual({ ...prev, id: '', sets: [], catalogId: 'supino-reto-barra' });
  });

  it('a lista de itens do catálogo não altera o modelo das fichas (nada de modalidade reescrita ao associar)', () => {
    const legacy = tpl('L', 'Prancha', { muscleGroup: 'Abdômen', equipment: 'bodyweight' });
    const linked = linkInstance(legacy, refOfItem(item('prancha')));
    expect(linked.modality).toBeUndefined();
    expect(linked.targetDurationSec).toBeUndefined();
    expect(linked.repMin).toBe(8);
  });
});

describe('privacidade', () => {
  it('os módulos novos são locais: sem rede, sem IA, sem armazenamento extra', () => {
    for (const f of ['recognition.ts', 'usage.ts', 'bulk.ts']) {
      const src = readFileSync(resolve('src/modules/exercises', f), 'utf8');
      expect(src, f).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|modules\/ai|localStorage\.|sessionStorage\.|indexedDB\.|from 'dexie'/);
    }
    for (const f of ['src/pages/ExerciseRecognitionPage.tsx', 'src/pages/BulkReplacePage.tsx', 'src/features/library/AddManyDialog.tsx', 'src/features/library/LinkConfirmDialog.tsx', 'src/features/library/LibraryPickerDialog.tsx']) {
      const src = readFileSync(resolve(f), 'utf8');
      expect(src, f).not.toMatch(/fetch\(|localStorage|sessionStorage|modules\/ai|integrations\/ai|ContextBuilder/);
    }
  });
});

// Mantém o tipo usado em asserções de itens.
export type { LibraryItem };
