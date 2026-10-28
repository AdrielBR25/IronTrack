// Biblioteca de exercícios (IronTrack 2.0 F01/P17): domínio puro. Catálogo, metadados, busca, filtros, favoritos,
// personalizados, instâncias, configuração anterior, operações da ficha, substituição, sugestões, referências e a
// integração com sessões, metas e analytics. Dados fictícios.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CUSTOM_LIMITS,
  EMPTY_FILTERS,
  FILTER_MUSCLES,
  LIBRARY_MUSCLES,
  WorkoutOpError,
  anchorFromItem,
  anchorFromTemplate,
  applyWorkoutOp,
  buildIndex,
  catalogItem,
  customExerciseIssues,
  customFieldErrors,
  customItem,
  customKey,
  defaultConfig,
  duplicateFields,
  duplicateInstance,
  editCustomExercise,
  favoriteId,
  favoriteIssues,
  foldText,
  instanceFromItem,
  isLibraryKey,
  libraryItems,
  libraryKeyOf,
  libraryReferences,
  muscleFromText,
  muscleText,
  newCustomExercise,
  previousConfig,
  recentKeys,
  resolveFavorites,
  searchLibrary,
  setArchived,
  substitutionPreview,
  suggest,
  templateEquipment,
  type CustomFields,
  type LibraryFilters,
  type LibraryItem,
} from '@/modules/exercises';
import { CATALOG_VERSION, catalogById, getCatalog } from '@/modules/exercises/catalog';
import { MUSCLE_LABEL, normalizeSessions } from '@/modules/analytics';
import { goalExerciseAvailability, goalExerciseMatch } from '@/modules/goals';
import { buildSession, exerciseModelIssues, substituteExercise, type ExerciseTemplate, type Routine, type Workout } from '@/modules/training';
import { DEFAULT_SETTINGS } from '@/lib/defaults';

const catalog = getCatalog();
const items = libraryItems([], catalog);
const byId = (id: string) => catalogItem(catalogById(id)!);
const REST = { restCompoundSec: 150, restIsolationSec: 90 };
const GROUPS = DEFAULT_SETTINGS.muscleGroups;
const opts = (id: string) => ({ id, muscleGroups: GROUPS, rest: REST });

const FIELDS: CustomFields = {
  name: 'Remada máquina articulada',
  modality: 'resistance',
  primaryMuscle: 'costas',
  secondaryMuscles: ['biceps'],
  equipment: ['maquina'],
  laterality: 'bilateral',
  loadMode: 'externa',
  mechanics: 'compound',
};
const CX = 'cx_aaaaaaaa-1111';

const workout = (exercises: ExerciseTemplate[]): Workout => ({ id: 'w1', label: 'A', name: 'Treino A', exercises });
const routineOf = (exercises: ExerciseTemplate[], over: Partial<Routine> = {}): Routine => ({ id: 'r1', name: 'Rotina', workouts: [workout(exercises)], createdAt: 1, updatedAt: 1, ...over });

describe('catálogo padrão', () => {
  it('tem os exercícios pedidos, sem IDs repetidos e com IDs estáveis (slug, nunca cx_)', () => {
    expect(catalog.length).toBeGreaterThanOrEqual(50);
    const ids = catalog.map((c) => c.catalogId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(id.startsWith('cx_')).toBe(false);
      expect(isLibraryKey(`catalog:${id}`)).toBe(true);
    }
    expect(CATALOG_VERSION).toBe(1);
    const names = catalog.map((c) => foldText(c.name));
    expect(new Set(names).size).toBe(names.length);
    const wanted = [
      'Supino reto com barra', 'Supino inclinado com halteres', 'Crucifixo com halteres', 'Crossover na polia', 'Flexão de braços',
      'Puxada frontal', 'Remada baixa', 'Remada curvada com barra', 'Remada unilateral com halter', 'Barra fixa',
      'Desenvolvimento com halteres', 'Elevação lateral', 'Elevação frontal', 'Crucifixo inverso',
      'Rosca direta', 'Rosca alternada', 'Rosca martelo', 'Rosca concentrada',
      'Tríceps na polia', 'Tríceps francês', 'Tríceps testa', 'Mergulho em banco',
      'Agachamento livre com barra', 'Leg press', 'Cadeira extensora', 'Afundo', 'Cadeira abdutora', 'Elevação pélvica',
      'Mesa flexora', 'Cadeira flexora', 'Stiff', 'Levantamento terra romeno', 'Panturrilha em pé', 'Panturrilha sentado',
      'Abdominal tradicional', 'Prancha', 'Elevação de pernas', 'Abdominal na polia',
      'Caminhada', 'Corrida', 'Bicicleta ergométrica', 'Elíptico', 'Remo ergométrico', 'Escada', 'Pular corda',
      'Wall sit', 'Dead hang', 'Alongamento estático', 'Paralelas', 'Agachamento livre sem carga', 'Burpee',
      'Elevação lateral unilateral', 'Cadeira extensora unilateral',
    ];
    for (const w of wanted) expect(catalog.some((c) => c.name === w), w).toBe(true);
  });

  it('metadados completos e coerentes em cada entrada', () => {
    for (const c of catalog) {
      const where = c.catalogId;
      expect(c.name.trim(), where).toBe(c.name);
      expect(c.primaryMuscles.length, where).toBeGreaterThan(0);
      expect(c.equipment.length, where).toBeGreaterThan(0);
      expect(c.instructions.length, where).toBeGreaterThan(0);
      expect(c.safetyNotes.length, where).toBeGreaterThan(0);
      expect(c.source).toBe('irontrack-base');
      expect(c.version).toBeGreaterThanOrEqual(1);
      for (const m of [...c.primaryMuscles, ...c.secondaryMuscles]) expect(LIBRARY_MUSCLES, where).toContain(m);
      expect(c.secondaryMuscles.some((m) => c.primaryMuscles.includes(m)), where).toBe(false);
      // Tipo de carga compatível com a modalidade (as mesmas regras dos personalizados e do modelo v3).
      expect(customFieldErrors({ name: c.name, modality: c.modality, primaryMuscle: c.primaryMuscles[0], secondaryMuscles: c.secondaryMuscles.slice(0, 4), equipment: c.equipment.slice(0, 4), laterality: c.laterality, loadMode: c.loadMode, mechanics: c.mechanics }), where).toEqual([]);
      // Texto conservador: nenhuma carga, percentual ou prescrição numérica individual.
      const all = [...c.instructions, ...c.commonMistakes, ...c.safetyNotes].join(' ');
      expect(all, where).not.toMatch(/\d+\s*(kg|%|rm\b)|1rm|ativação|garante|cura|trata/i);
      expect(all, where).not.toMatch(/<|https?:/);
    }
  });

  it('exercícios compostos não são classificados como isoladores (e vice-versa nos clássicos)', () => {
    for (const id of ['supino-reto-barra', 'agachamento-livre', 'remada-curvada', 'leg-press', 'stiff', 'barra-fixa', 'flexao-de-bracos']) expect(catalogById(id)!.mechanics).toBe('compound');
    for (const id of ['rosca-direta', 'cadeira-extensora', 'elevacao-lateral', 'triceps-polia', 'mesa-flexora']) expect(catalogById(id)!.mechanics).toBe('isolation');
    for (const c of catalog.filter((x) => x.modality === 'cardio' || x.modality === 'timed')) expect(c.mechanics).toBeNull();
  });

  it('cobre todas as modalidades, unilaterais e duplicatas semânticas aparecem uma vez só', () => {
    for (const m of ['resistance', 'bodyweight', 'timed', 'cardio'] as const) expect(catalog.filter((c) => c.modality === m).length).toBeGreaterThanOrEqual(4);
    expect(catalog.filter((c) => c.laterality === 'unilateral').map((c) => c.catalogId).sort()).toEqual(
      ['afundo', 'cadeira-extensora-unilateral', 'elevacao-lateral-unilateral', 'remada-unilateral', 'rosca-alternada', 'rosca-concentrada'].sort(),
    );
    expect(catalog.filter((c) => /^flex[aã]o/i.test(c.name))).toHaveLength(1);
    expect(catalog.filter((c) => /^barra fixa$/i.test(c.name))).toHaveLength(1);
    expect(catalog.filter((c) => /^prancha/i.test(c.name))).toHaveLength(1);
    expect(catalogById('prancha')!.aliases).toContain('prancha isométrica');
    for (const c of catalog.filter((x) => x.modality === 'cardio')) expect(c.loadMode).toBeNull();
  });

  it('os grupos da biblioteca são os do analytics (P09) mais "corpo inteiro"; o filtro usa os grupos pedidos', () => {
    expect([...LIBRARY_MUSCLES].sort()).toEqual([...Object.keys(MUSCLE_LABEL), 'corpo_inteiro'].sort());
    expect(FILTER_MUSCLES).toEqual(['peitoral', 'costas', 'ombros', 'biceps', 'triceps', 'quadriceps', 'posteriores', 'gluteos', 'panturrilhas', 'abdomen', 'corpo_inteiro']);
  });

  it('o catálogo é estático e local: sem rede, sem imagens remotas, sem IA', () => {
    const src = readFileSync(resolve('src/modules/exercises/catalog/index.ts'), 'utf8');
    expect(src).not.toMatch(/https?:\/\/|fetch\(|import\(|\.png|\.jpg|\.webp/);
    const dir = resolve('src/modules/exercises');
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/fetch\(|XMLHttpRequest|navigator\.sendBeacon|modules\/ai|localStorage/);
  });
});

describe('busca', () => {
  const index = buildIndex(items);
  const names = (q: string, f: LibraryFilters = EMPTY_FILTERS) => searchLibrary(index, q, f).map((i) => i.name);

  it('insensível a maiúsculas e tolerante a acentos', () => {
    expect(names('TRICEPS')).toEqual(names('tríceps'));
    expect(names('triceps')).toContain('Tríceps testa');
    expect(names('eliptico')).toEqual(['Elíptico']);
    expect(names('  ROSCA   martelo ')).toEqual(['Rosca martelo']);
  });

  it('considera apelidos, grupos, equipamentos e tags', () => {
    expect(names('pulldown')).toEqual(['Puxada frontal']);
    expect(names('serrote')).toEqual(['Remada unilateral com halter']);
    expect(names('panturrilhas')).toEqual(expect.arrayContaining(['Panturrilha em pé', 'Panturrilha sentado']));
    expect(names('polia')).toEqual(expect.arrayContaining(['Crossover na polia', 'Tríceps na polia', 'Remada baixa']));
    expect(names('calistenia')).toEqual(expect.arrayContaining(['Flexão de braços', 'Barra fixa', 'Burpee']));
  });

  it('todos os termos precisam aparecer; ordem por relevância e nome; sem duplicatas; determinística', () => {
    expect(names('supino halteres')).toEqual(['Supino inclinado com halteres']);
    const r = names('rosca');
    expect(r.slice(0, 4)).toEqual(['Rosca alternada', 'Rosca concentrada', 'Rosca direta', 'Rosca martelo']);
    expect(new Set(r).size).toBe(r.length);
    expect(names('rosca')).toEqual(r);
    // Nome que começa com a busca vem antes de nome que só contém o termo.
    const lateral = names('elevação lateral');
    expect(lateral[0]).toBe('Elevação lateral');
    // Item repetido na entrada não duplica o resultado.
    expect(searchLibrary(buildIndex([...items, ...items]), 'leg press', EMPTY_FILTERS)).toHaveLength(1);
  });

  it('sem texto, todos os itens ativos em ordem alfabética pt-BR', () => {
    const all = names('');
    expect(all).toHaveLength(catalog.length);
    expect(all).toEqual([...all].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' })));
  });

  it('é rápida com centenas de exercícios (índice montado uma vez)', () => {
    const many: LibraryItem[] = [];
    for (let i = 0; i < 12; i++) for (const it of items) many.push({ ...it, key: `custom:cx_perf${String(i).padStart(4, '0')}-${it.refId}`.slice(0, 70) as LibraryItem['key'], kind: 'custom', name: `${it.name} ${i}` });
    const big = buildIndex(many);
    const t0 = performance.now();
    for (const q of ['s', 'su', 'sup', 'supi', 'supino', 'supino r', 'costas', 'halteres']) searchLibrary(big, q, EMPTY_FILTERS);
    expect(many.length).toBeGreaterThan(600);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('filtros', () => {
  const index = buildIndex(items);
  const f = (p: Partial<LibraryFilters>) => ({ ...EMPTY_FILTERS, ...p });

  it('grupo muscular confere os principais; equipamento e modalidade combinam; dimensões se somam', () => {
    const tri = searchLibrary(index, '', f({ muscles: ['triceps'] })).map((i) => i.refId);
    expect(tri).toContain('triceps-testa');
    expect(tri).toContain('paralelas');
    expect(tri).not.toContain('supino-reto-barra');
    const both = searchLibrary(index, '', f({ muscles: ['peitoral', 'costas'] }));
    expect(both.every((i) => i.primaryMuscles.some((m) => m === 'peitoral' || m === 'costas'))).toBe(true);
    const polia = searchLibrary(index, '', f({ equipment: ['polia'], muscles: ['triceps'] })).map((i) => i.refId);
    expect(polia).toEqual(['triceps-polia']);
    expect(searchLibrary(index, '', f({ modalities: ['cardio'] }))).toHaveLength(7);
    expect(searchLibrary(index, '', f({ modalities: ['timed'] })).map((i) => i.refId).sort()).toEqual(['alongamento-estatico', 'dead-hang', 'prancha', 'wall-sit']);
    expect(searchLibrary(index, '', f({ laterality: 'unilateral' })).every((i) => i.laterality === 'unilateral')).toBe(true);
    expect(searchLibrary(index, 'rosca', f({ laterality: 'unilateral' })).map((i) => i.refId).sort()).toEqual(['rosca-alternada', 'rosca-concentrada']);
    expect(searchLibrary(index, '', f({ muscles: ['corpo_inteiro'] })).map((i) => i.refId)).toEqual(expect.arrayContaining(['burpee', 'corrida']));
  });

  it('favoritos, personalizados e arquivados', () => {
    const custom = customItem({ ...newCustomExercise(CX, FIELDS, 10), profileId: 'p' });
    const archived = { ...customItem({ ...newCustomExercise('cx_bbbbbbbb-2222', { ...FIELDS, name: 'Velho' }, 10), archivedAt: 20 }) };
    const idx = buildIndex([...items, custom, archived]);
    const favs = new Set([custom.key, byId('leg-press').key]);
    expect(searchLibrary(idx, '', f({ favoritesOnly: true }), favs).map((i) => i.name)).toEqual(['Leg press', 'Remada máquina articulada']);
    expect(searchLibrary(idx, '', f({ customOnly: true })).map((i) => i.name)).toEqual(['Remada máquina articulada']);
    expect(searchLibrary(idx, '', f({ customOnly: true, archived: 'only' })).map((i) => i.name)).toEqual(['Velho']);
    expect(searchLibrary(idx, 'velho', f({}))).toEqual([]);
  });
});

describe('exercícios personalizados', () => {
  it('validação: nome, limites, modalidade × carga, cardio, repetições e sem HTML', () => {
    expect(customFieldErrors(FIELDS)).toEqual([]);
    expect(customFieldErrors({ ...FIELDS, name: '   ' }).join()).toMatch(/nome/);
    expect(customFieldErrors({ ...FIELDS, name: 'x'.repeat(CUSTOM_LIMITS.maxName + 1) }).join()).toMatch(/80/);
    expect(customFieldErrors({ ...FIELDS, name: '<img src=x onerror=alert(1)>' }).join()).toMatch(/HTML/);
    expect(customFieldErrors({ ...FIELDS, notes: 'ok <script>alert(1)</script>' }).join()).toMatch(/HTML/);
    expect(customFieldErrors({ ...FIELDS, instructions: 'javascript:alert(1)' }).join()).toMatch(/HTML/);
    expect(customFieldErrors({ ...FIELDS, loadMode: 'corporal' }).join()).toMatch(/carga/);
    expect(customFieldErrors({ ...FIELDS, modality: 'cardio', loadMode: 'externa' }).join()).toMatch(/cardio/);
    expect(customFieldErrors({ ...FIELDS, modality: 'cardio', loadMode: null, laterality: 'unilateral' }).join()).toMatch(/unilateral/);
    expect(customFieldErrors({ ...FIELDS, secondaryMuscles: ['costas'] }).join()).toMatch(/principal/);
    expect(customFieldErrors({ ...FIELDS, equipment: [] }).join()).toMatch(/equipamento/);
    expect(customFieldErrors({ ...FIELDS, secondaryMuscles: ['biceps', 'biceps'] }).join()).toMatch(/repetido/);
    expect(customFieldErrors({ ...FIELDS, extra: 1 } as never).length).toBeGreaterThan(0);
  });

  it('criação, edição com revisão, arquivamento e duplicação; ID sempre cx_ (nunca sobrescreve o catálogo)', () => {
    const c = newCustomExercise(CX, { ...FIELDS, name: '  Remada   máquina  ' }, 100);
    expect(c).toMatchObject({ id: CX, name: 'Remada máquina', archivedAt: null, revision: 1, createdAt: 100 });
    expect(() => newCustomExercise('supino-reto-barra', FIELDS, 1)).toThrow(/inválidos/);
    expect(() => newCustomExercise('cx_x', FIELDS, 1)).toThrow();
    const e = editCustomExercise(c, { ...FIELDS, name: 'Outro', notes: '  ' }, 200);
    expect(e).toMatchObject({ id: CX, name: 'Outro', revision: 2, updatedAt: 200, createdAt: 100 });
    expect(e).not.toHaveProperty('notes');
    const a = setArchived(e, true, 300);
    expect(a).toMatchObject({ changed: true, exercise: { archivedAt: 300, revision: 3 } });
    expect(setArchived(a.exercise, true, 400).changed).toBe(false);
    expect(setArchived(a.exercise, false, 400).exercise.archivedAt).toBeNull();
    expect(customExerciseIssues(a.exercise)).toEqual([]);
    expect(customExerciseIssues({ ...a.exercise, revision: 0 }).length).toBeGreaterThan(0);
    const dup = duplicateFields(byId('remada-curvada'));
    expect(dup).toMatchObject({ name: 'Remada curvada com barra (cópia)', primaryMuscle: 'costas', modality: 'resistance', equipment: ['barra'] });
    expect(customFieldErrors(dup)).toEqual([]);
    // Duplicar cardio/tempo também gera campos válidos.
    for (const id of ['corrida', 'prancha', 'paralelas', 'burpee']) expect(customFieldErrors(duplicateFields(byId(id))), id).toEqual([]);
  });
});

describe('favoritos', () => {
  const P = '11111111-1111-4111-8111-111111111111';
  it('ID determinístico por perfil e alvo; validação; favoritos de itens inexistentes ficam como indisponíveis', () => {
    expect(favoriteId(P, 'catalog:leg-press')).toBe(`${P}~catalog:leg-press`);
    const ok = { id: favoriteId(P, 'catalog:leg-press'), profileId: P, target: 'catalog:leg-press' as const, createdAt: 1 };
    expect(favoriteIssues(ok)).toEqual([]);
    expect(favoriteIssues({ ...ok, id: 'x' }).join()).toMatch(/identificador/);
    expect(favoriteIssues({ ...ok, target: 'catalog:<b>' }).join()).toMatch(/alvo/);
    expect(isLibraryKey('custom:cx_aaaaaaaa-1111')).toBe(true);
    expect(isLibraryKey('custom:supino')).toBe(false);
    const gone = { id: favoriteId(P, 'catalog:retirado-do-catalogo'), profileId: P, target: 'catalog:retirado-do-catalogo' as const, createdAt: 1 };
    const r = resolveFavorites([ok, gone, ok], items);
    expect([...r.keys]).toEqual(['catalog:leg-press']);
    expect(r.orphans).toEqual([gone]);
  });
});

describe('instância na ficha', () => {
  it('ID próprio, origem opcional, versão copiada e metadados no modelo existente', () => {
    const t = instanceFromItem(byId('supino-reto-barra'), opts('i1'));
    expect(t).toMatchObject({ id: 'i1', name: 'Supino reto com barra', muscleGroup: 'Peito', category: 'compound', equipment: 'barbell', modality: 'resistance', laterality: 'bilateral', catalogId: 'supino-reto-barra', catalogVersion: 1, sets: 3, repMin: 8, repMax: 12, restSec: 150, warmupSets: 0 });
    expect(t.secondaryMuscles).toEqual(['Tríceps', 'Ombros']);
    expect(t).not.toHaveProperty('targetWeight');
    expect(t).not.toHaveProperty('customExerciseId');
    expect(exerciseModelIssues(t)).toEqual([]);
  });

  it('todas as entradas do catálogo geram instâncias válidas no modelo v3', () => {
    for (const c of catalog) {
      const t = instanceFromItem(catalogItem(c), opts(`i-${c.catalogId}`));
      expect(exerciseModelIssues(t), c.catalogId).toEqual([]);
      expect(t.secondaryMuscles?.length ?? 0).toBeLessThanOrEqual(4);
    }
  });

  it('usa o texto de grupo que a pessoa já tem (normalização do P09) ou o rótulo canônico', () => {
    expect(muscleText('posteriores', GROUPS)).toBe('Posterior de coxa');
    expect(muscleText('panturrilhas', GROUPS)).toBe('Panturrilha');
    expect(muscleText('peitoral', ['Peitoral maior'])).toBe('Peitoral maior');
    expect(muscleText('adutores', GROUPS)).toBe('Adutores');
    expect(muscleText('corpo_inteiro', GROUPS)).toBe('Corpo inteiro');
    expect(muscleFromText('Peito')).toBe('peitoral');
    expect(muscleFromText('Corpo inteiro')).toBe('corpo_inteiro');
    expect(muscleFromText('Peito e tríceps')).toBeNull();
    expect(templateEquipment(['banco', 'halteres'])).toBe('dumbbell');
    expect(templateEquipment(['bicicleta'])).toBe('machine');
  });

  it('cardio, por tempo, peso corporal e unilateral usam os campos certos', () => {
    const run = instanceFromItem(byId('corrida'), opts('c'));
    expect(run).toMatchObject({ modality: 'cardio', distanceUnit: 'km', sets: 1, restSec: 0 });
    expect(run).not.toHaveProperty('laterality');
    expect(run).not.toHaveProperty('loadMode');
    const plank = instanceFromItem(byId('prancha'), opts('p'));
    expect(plank).toMatchObject({ modality: 'timed', loadMode: 'corporal', targetDurationSec: 30, sets: 3 });
    const pull = instanceFromItem(byId('barra-fixa'), opts('b'));
    expect(pull).toMatchObject({ modality: 'bodyweight', loadMode: 'corporal', equipment: 'bodyweight' });
    const uni = instanceFromItem(byId('rosca-alternada'), opts('u'));
    expect(uni).toMatchObject({ laterality: 'unilateral', modality: 'resistance' });
    expect(defaultConfig(byId('rosca-alternada'), REST).restSec).toBe(90);
  });

  it('o mesmo item pode entrar duas vezes, cada uma com identidade e configuração próprias', () => {
    const a = instanceFromItem(byId('leg-press'), opts('x1'));
    const b = { ...instanceFromItem(byId('leg-press'), opts('x2')), sets: 5 };
    expect(a.id).not.toBe(b.id);
    expect(a.catalogId).toBe(b.catalogId);
    expect(a.sets).toBe(3);
    const w = applyWorkoutOp(applyWorkoutOp(workout([]), { type: 'add', exercise: a }).workout, { type: 'add', exercise: b }).workout;
    expect(w.exercises.map((e) => e.id)).toEqual(['x1', 'x2']);
  });

  it('personalizado vira instância com customExerciseId; editar o modelo não muda a instância (cópia)', () => {
    const c = newCustomExercise(CX, FIELDS, 1);
    const t = instanceFromItem(customItem(c), opts('cx-i'));
    expect(t).toMatchObject({ customExerciseId: CX, name: FIELDS.name, muscleGroup: 'Costas' });
    expect(t).not.toHaveProperty('catalogId');
    const edited = editCustomExercise(c, { ...FIELDS, name: 'Renomeado' }, 2);
    expect(t.name).toBe(FIELDS.name);
    expect(edited.name).toBe('Renomeado');
    expect(libraryKeyOf(t)).toBe(customKey(CX));
  });
});

describe('configuração anterior (ponto de partida)', () => {
  it('pela origem (nunca pelo nome), mesma modalidade, ficha mais recente, sem carga', () => {
    const old = { ...instanceFromItem(byId('leg-press'), opts('o1')), sets: 4, repMin: 10, repMax: 15, restSec: 100, targetWeight: 200 };
    const sameName = { ...instanceFromItem(byId('cadeira-extensora'), opts('o2')), name: 'Leg press', sets: 9 };
    const r1 = routineOf([old], { id: 'ra', name: 'Antiga', updatedAt: 10 });
    const newer = { ...old, id: 'o3', sets: 5 };
    const r2 = routineOf([sameName, newer], { id: 'rb', name: 'Nova', updatedAt: 20 });
    const s = previousConfig('catalog:leg-press', [r1, r2], 'resistance');
    expect(s).toMatchObject({ config: { sets: 5, repMin: 10, repMax: 15, restSec: 100 }, source: { routineName: 'Nova', workoutLabel: 'A' } });
    expect(s!.config).not.toHaveProperty('targetWeight');
    expect(previousConfig('catalog:leg-press', [r1, r2], 'cardio')).toBeNull();
    expect(previousConfig('catalog:agachamento-livre', [r1, r2], 'resistance')).toBeNull();
    // Instância sem modalidade gravada vale como musculação (padrão do modelo v3).
    const { modality: _m, ...noModality } = newer;
    expect(previousConfig('catalog:leg-press', [routineOf([noModality], { updatedAt: 30 })], 'resistance')?.config.sets).toBe(5);
    // Rotina de outro perfil não entra.
    expect(previousConfig('catalog:leg-press', [{ ...r2, profileId: 'outro' }], 'resistance', 'meu')).toBeNull();
  });
});

describe('operações da ficha', () => {
  const a = instanceFromItem(byId('supino-reto-barra'), opts('a'));
  const b = instanceFromItem(byId('remada-baixa'), opts('b'));
  const c = instanceFromItem(byId('corrida'), opts('c'));
  const w = workout([a, b, c]);
  const ids = (x: Workout) => x.exercises.map((e) => e.id);

  it('mover, reordenar (preservando o que a tela não conhecia), duplicar, remover e substituir', () => {
    expect(ids(applyWorkoutOp(w, { type: 'move', id: 'b', delta: -1 }).workout)).toEqual(['b', 'a', 'c']);
    expect(applyWorkoutOp(w, { type: 'move', id: 'a', delta: -1 }).changed).toBe(false);
    expect(ids(applyWorkoutOp(w, { type: 'reorder', order: ['c', 'a'] }).workout)).toEqual(['c', 'a', 'b']);
    const dup = applyWorkoutOp(w, { type: 'duplicate', id: 'a', newId: 'a2' }).workout;
    expect(ids(dup)).toEqual(['a', 'a2', 'b', 'c']);
    expect(dup.exercises[1]).toEqual({ ...a, id: 'a2', secondaryMuscles: a.secondaryMuscles });
    expect(dup.exercises[1].secondaryMuscles).not.toBe(a.secondaryMuscles);
    expect(applyWorkoutOp(w, { type: 'remove', id: 'zz' }).changed).toBe(false);
    expect(() => applyWorkoutOp(w, { type: 'update', exercise: { ...a, id: 'zz' } })).toThrow(WorkoutOpError);
    expect(() => applyWorkoutOp(w, { type: 'replace', id: 'zz', exercise: { ...b, id: 'n' } })).toThrow(/não está mais na ficha/);
    expect(() => applyWorkoutOp(w, { type: 'replace', id: 'a', exercise: { ...b, id: 'a' } })).toThrow(/identificador/);
    const rep = applyWorkoutOp(w, { type: 'replace', id: 'a', exercise: { ...b, id: 'n' } }).workout;
    expect(ids(rep)).toEqual(['n', 'b', 'c']);
    // Reenvio da mesma substituição não falha nem duplica.
    expect(applyWorkoutOp(rep, { type: 'replace', id: 'a', exercise: { ...b, id: 'n' } }).changed).toBe(false);
    // Adição repetida (mesmo ID) não duplica.
    expect(applyWorkoutOp(w, { type: 'add', exercise: a }).changed).toBe(false);
  });

  it('nome e rótulo do treino: rótulo único na rotina; nada muda sem diferença', () => {
    expect(() => applyWorkoutOp(w, { type: 'meta', label: 'b', name: 'X' }, ['B'])).toThrow(/rótulo/);
    expect(applyWorkoutOp(w, { type: 'meta', label: 'a', name: 'Treino A' }).changed).toBe(false);
    expect(applyWorkoutOp(w, { type: 'meta', label: 'a', name: '  Peito  ', notes: ' ' }).workout).toMatchObject({ label: 'A', name: 'Peito', notes: undefined });
  });

  it('duplicar não compartilha estado nem cria chaves vazias', () => {
    const plain = { ...a };
    delete plain.secondaryMuscles;
    const d = duplicateInstance(plain, 'd');
    expect(Object.keys(d)).toEqual(Object.keys(plain));
  });
});

describe('substituição', () => {
  const sup = { ...instanceFromItem(byId('supino-reto-barra'), opts('sup')), sets: 4, repMin: 6, repMax: 8, restSec: 180, targetWeight: 80, warmupSets: 2, notes: 'pegada média' };

  it('cria identidade nova, mantém séries/descanso/repetições e explica o que não passa', () => {
    const p = substitutionPreview(sup, byId('supino-inclinado-halteres'), { ...opts('novo'), linkedGoals: 0 });
    expect(p.next.id).toBe('novo');
    expect(p.next).toMatchObject({ sets: 4, repMin: 6, repMax: 8, restSec: 180, catalogId: 'supino-inclinado-halteres' });
    expect(p.next).not.toHaveProperty('targetWeight');
    expect(p.next).not.toHaveProperty('notes');
    expect(p.kept).toEqual(['séries', 'descanso', 'repetições']);
    expect(p.dropped.join()).toMatch(/carga planejada/);
    expect(p.dropped.join()).toMatch(/aquecimento/);
    expect(p.modalityChanged).toBe(false);
    expect(p.goalNote).toBeNull();
    expect(p.historyNote).toMatch(/continua como está/);
  });

  it('mudança de modalidade e metas ligadas são informadas (nunca redirecionadas)', () => {
    const p = substitutionPreview(sup, byId('prancha'), { ...opts('novo'), linkedGoals: 2 });
    expect(p.modalityChanged).toBe(true);
    expect(p.modalityNotes.join()).toMatch(/carga e repetições para duração/);
    expect(p.dropped.join()).toMatch(/repetições \(6–8\)/);
    expect(p.goalNote).toMatch(/2 metas continuam ligadas a "Supino reto com barra"/);
    const uni = substitutionPreview(sup, byId('rosca-alternada'), { ...opts('u'), linkedGoals: 1 });
    expect(uni.modalityNotes.join()).toMatch(/unilateral/);
    expect(uni.goalNote).toMatch(/^1 meta continua ligada/);
  });

  it('metas e histórico continuam com o ID antigo: a sessão do substituto não conta para a meta antiga', () => {
    const p = substitutionPreview(sup, byId('supino-inclinado-halteres'), { ...opts('novo'), linkedGoals: 1 });
    const routine = routineOf([p.next]);
    const ref = { templateIds: ['sup'], routineId: 'r1', name: 'Supino reto com barra', modality: 'resistance' as const, loadMode: null, laterality: null, equipment: 'barbell', distanceUnit: null };
    expect(goalExerciseAvailability(ref, [routine]).state).toBe('removido');
    const s = buildSession(routine, routine.workouts[0], [], 1000);
    expect(s.exercises[0].templateId).toBe('novo');
    expect(goalExerciseMatch(ref, s.exercises[0])).toBeNull();
  });
});

describe('sessões, histórico e analytics', () => {
  it('a sessão copia a origem da ficha (snapshot) e não muda se o catálogo/ficha mudar depois', () => {
    const t = instanceFromItem(byId('leg-press'), opts('lp'));
    const r = routineOf([t]);
    const s = buildSession(r, r.workouts[0], [], 1000);
    expect(s.exercises[0]).toMatchObject({ templateId: 'lp', catalogId: 'leg-press', name: 'Leg press' });
    expect(s.exercises[0]).not.toHaveProperty('catalogVersion');
    r.workouts[0].exercises[0].name = 'Outro nome';
    expect(s.exercises[0].name).toBe('Leg press');
  });

  it('fichas antigas (sem origem) continuam gerando sessões idênticas às de antes', () => {
    const old: ExerciseTemplate = { id: 'velho', name: 'Supino', muscleGroup: 'Peito', category: 'compound', equipment: 'barbell', sets: 3, repMin: 8, repMax: 12, restSec: 120, warmupSets: 0 };
    const s = buildSession(routineOf([old]), workout([old]), [], 1000);
    expect(s.exercises[0]).not.toHaveProperty('catalogId');
    expect(s.exercises[0]).not.toHaveProperty('customExerciseId');
    expect(Object.keys(s.exercises[0]).sort()).toEqual(['category', 'equipment', 'exerciseKey', 'id', 'muscleGroup', 'name', 'notes', 'plannedSets', 'repMax', 'repMin', 'restSec', 'sets', 'templateId'].sort());
  });

  it('trocar o exercício durante o treino remove a origem da cópia (não conta como uso do item original)', () => {
    const t = instanceFromItem(byId('leg-press'), opts('lp'));
    const s = buildSession(routineOf([t]), workout([t]), [], 1000);
    const swapped = substituteExercise(s, s.exercises[0].id, 'Hack machine', []);
    expect(swapped.exercises[0]).toMatchObject({ name: 'Hack machine', templateId: 'lp', substitutedFrom: 'Leg press' });
    expect(swapped.exercises[0]).not.toHaveProperty('catalogId');
    expect(recentKeys([{ ...swapped, status: 'completed' }])).toEqual([]);
  });

  it('analytics continua agrupando pelo exerciseKey de sempre (a origem não muda nada)', () => {
    const t = instanceFromItem(byId('leg-press'), opts('lp'));
    const s = { ...buildSession(routineOf([t]), workout([t]), [], 1000), status: 'completed' as const, finishedAt: 2000 };
    const plain = { ...s, exercises: s.exercises.map(({ catalogId: _c, ...e }) => e) };
    expect(JSON.stringify(normalizeSessions([s]))).toBe(JSON.stringify(normalizeSessions([plain])));
  });
});

describe('sugestões e referências', () => {
  const index = items;
  it('sem referência: favoritos e recentes, com motivo; determinístico; sem arquivados', () => {
    const fav = new Set([byId('stiff').key, byId('corrida').key]);
    const archived = { ...customItem({ ...newCustomExercise(CX, FIELDS, 1), archivedAt: 5 }) };
    const s = suggest({ items: [...index, archived], favorites: new Set([...fav, archived.key]), recent: ['catalog:leg-press', 'catalog:stiff'] });
    expect(s.map((x) => [x.item.refId, x.reason])).toEqual([
      ['corrida', 'favorito'],
      ['stiff', 'favorito'],
      ['leg-press', 'recente'],
    ]);
    expect(suggest({ items: index, favorites: fav, recent: [] })).toEqual(suggest({ items: index, favorites: fav, recent: [] }));
  });

  it('com referência (substituir): mesmo grupo, depois equipamento semelhante, depois mesma modalidade', () => {
    const anchor = anchorFromItem(byId('rosca-direta'));
    const s = suggest({ items: index, favorites: new Set([byId('rosca-martelo').key]), recent: [], anchor, limit: 50 });
    expect(s[0]).toMatchObject({ reason: 'mesmo_grupo' });
    expect(s[0].item.refId).toBe('rosca-martelo');
    expect(s.some((x) => x.item.refId === 'rosca-direta')).toBe(false);
    const reasons = s.map((x) => x.reason);
    expect(reasons.indexOf('mesmo_equipamento')).toBeGreaterThan(reasons.lastIndexOf('mesmo_grupo'));
    // Exercício antigo da ficha (sem origem): atributos vêm do grupo normalizado e do equipamento.
    const legacy = anchorFromTemplate({ id: 'x', name: 'Rosca no cabo', muscleGroup: 'Bíceps', category: 'isolation', equipment: 'cable', sets: 3, repMin: 8, repMax: 12, restSec: 60, warmupSets: 0 });
    expect(legacy).toMatchObject({ key: null, muscles: ['biceps'], equipment: ['polia'] });
    expect(suggest({ items: index, favorites: new Set(), recent: [], anchor: legacy })[0].reason).toBe('mesmo_grupo');
  });

  it('recentes vêm das sessões concluídas pela origem gravada, mais recentes primeiro', () => {
    const t1 = instanceFromItem(byId('leg-press'), opts('1'));
    const t2 = instanceFromItem(byId('stiff'), opts('2'));
    const s1 = { ...buildSession(routineOf([t1]), workout([t1]), [], 1000), status: 'completed' as const };
    const s2 = { ...buildSession(routineOf([t2, t1]), workout([t2, t1]), [], 2000), status: 'completed' as const };
    const active = { ...buildSession(routineOf([t2]), workout([t2]), [], 3000) };
    expect(recentKeys([s1, s2, active])).toEqual(['catalog:stiff', 'catalog:leg-press']);
  });

  it('referências contam instâncias e sessões pela origem (nunca por nome)', () => {
    const c = newCustomExercise(CX, FIELDS, 1);
    const t = instanceFromItem(customItem(c), opts('t'));
    const sameName = { ...instanceFromItem(byId('remada-baixa'), opts('n')), name: FIELDS.name };
    const r = routineOf([t, { ...t, id: 't2' }, sameName]);
    const s = buildSession(r, r.workouts[0], [], 1);
    expect(libraryReferences(customKey(CX), [r], [s])).toEqual({ templates: 2, sessions: 1 });
    expect(libraryReferences(customKey('cx_naoexiste-0000'), [r], [s])).toEqual({ templates: 0, sessions: 0 });
  });
});
