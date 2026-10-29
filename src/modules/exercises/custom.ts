// Exercícios personalizados (P17, docs/BIBLIOTECA_EXERCICIOS.md §7–8): validação Zod, criação, edição,
// duplicação, arquivamento e a visão única (LibraryItem) junto com o catálogo. Puro: a gravação fica em src/db/library.ts.
// Segurança: só texto simples com limites (nada de HTML: a tela renderiza como texto e a validação recusa marcação),
// ID sempre `cx_…` (não colide com o catálogo), modalidade e tipo de carga coerentes.
import { z } from 'zod';
import { LATERALITIES, LOAD_MODES, LOAD_MODES_BY_MODALITY, MODALITIES } from '@/modules/training';
import type { LoadMode, TrainingModality } from '@/modules/training';
import { LIBRARY_EQUIPMENT, LIBRARY_MUSCLES } from './vocab';
import type { CatalogExercise, CustomExercise, LibraryEquipment, LibraryItem, LibraryKey, LibraryMuscle } from './types';

export const CUSTOM_LIMITS = {
  maxName: 80,
  maxText: 1000,
  maxSecondary: 4,
  maxEquipment: 4,
  /** Exercícios personalizados por perfil (arquivados contam). */
  maxPerProfile: 500,
} as const;

export const CUSTOM_ID_RE = /^cx_[A-Za-z0-9-]{8,64}$/;
export const isCustomId = (v: unknown): v is string => typeof v === 'string' && CUSTOM_ID_RE.test(v);
/** Formato dos IDs do catálogo (slug). Um ID de catálogo nunca começa com `cx_`. */
export const CATALOG_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Rejeita marcação: o texto é exibido como texto puro, mas nem o arquivo de backup deve trazer HTML. */
const NO_MARKUP = /<\s*\/?\s*[a-z!?]|javascript:/i;
const plain = (max: number) =>
  z
    .string()
    .max(max, `no máximo ${max} caracteres`)
    .refine((s) => !NO_MARKUP.test(s), 'sem HTML ou código');

const modality = z.enum(MODALITIES as [TrainingModality, ...TrainingModality[]]);
const muscle = z.enum(LIBRARY_MUSCLES as unknown as [LibraryMuscle, ...LibraryMuscle[]]);
const equipment = z.enum(LIBRARY_EQUIPMENT as unknown as [LibraryEquipment, ...LibraryEquipment[]]);

/** Campos editáveis pela pessoa (formulário "Criar exercício"). */
export const customFieldsSchema = z
  .object({
    name: plain(CUSTOM_LIMITS.maxName).refine((s) => s.trim().length > 0, 'informe o nome'),
    modality,
    primaryMuscle: muscle,
    secondaryMuscles: z.array(muscle).max(CUSTOM_LIMITS.maxSecondary, `no máximo ${CUSTOM_LIMITS.maxSecondary} grupos secundários`),
    equipment: z.array(equipment).min(1, 'escolha ao menos um equipamento').max(CUSTOM_LIMITS.maxEquipment, `no máximo ${CUSTOM_LIMITS.maxEquipment} equipamentos`),
    laterality: z.enum(LATERALITIES as ['bilateral', 'unilateral']),
    loadMode: z.enum(LOAD_MODES as [LoadMode, ...LoadMode[]]).nullable(),
    mechanics: z.enum(['compound', 'isolation']).nullable(),
    instructions: plain(CUSTOM_LIMITS.maxText).optional(),
    notes: plain(CUSTOM_LIMITS.maxText).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.secondaryMuscles.includes(f.primaryMuscle)) ctx.addIssue({ code: 'custom', path: ['secondaryMuscles'], message: 'o grupo principal não pode ser também secundário' });
    if (new Set(f.secondaryMuscles).size !== f.secondaryMuscles.length) ctx.addIssue({ code: 'custom', path: ['secondaryMuscles'], message: 'grupo secundário repetido' });
    if (new Set(f.equipment).size !== f.equipment.length) ctx.addIssue({ code: 'custom', path: ['equipment'], message: 'equipamento repetido' });
    const allowed = LOAD_MODES_BY_MODALITY[f.modality];
    if (f.modality === 'cardio' && f.loadMode !== null) ctx.addIssue({ code: 'custom', path: ['loadMode'], message: 'cardio não registra carga' });
    if (f.modality !== 'cardio' && (f.loadMode === null || !allowed.includes(f.loadMode)))
      ctx.addIssue({ code: 'custom', path: ['loadMode'], message: 'tipo de carga incompatível com a modalidade' });
    if (f.modality === 'cardio' && f.laterality === 'unilateral') ctx.addIssue({ code: 'custom', path: ['laterality'], message: 'cardio não é unilateral' });
  });

export type CustomFields = z.infer<typeof customFieldsSchema>;

const recordSchema = z
  .object({
    id: z.string().regex(CUSTOM_ID_RE, 'identificador inválido (esperado cx_…)'),
    profileId: z.string().min(1).max(200).optional(),
    archivedAt: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    revision: z.number().int().min(1),
  })
  .passthrough();

const pickFields = (r: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const k of ['name', 'modality', 'primaryMuscle', 'secondaryMuscles', 'equipment', 'laterality', 'loadMode', 'mechanics', 'instructions', 'notes']) if (r[k] !== undefined) out[k] = r[k];
  return out;
};

const fmtIssues = (e: z.ZodError) => e.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message));

/** Problemas de um registro gravado (ou vindo de um backup). Lista vazia = válido. */
export function customExerciseIssues(r: unknown): string[] {
  if (typeof r !== 'object' || r === null) return ['registro não é um objeto'];
  const rec = recordSchema.safeParse(r);
  const out = rec.success ? [] : fmtIssues(rec.error);
  const f = customFieldsSchema.safeParse(pickFields(r as Record<string, unknown>));
  if (!f.success) out.push(...fmtIssues(f.error));
  const x = r as Partial<CustomExercise>;
  if (typeof x.createdAt === 'number' && typeof x.updatedAt === 'number' && x.updatedAt < x.createdAt) out.push('updatedAt anterior a createdAt');
  return out;
}

export const isValidCustomExercise = (r: unknown): r is CustomExercise => customExerciseIssues(r).length === 0;

/** Erros do formulário (mensagens para a tela). */
export function customFieldErrors(f: unknown): string[] {
  const r = customFieldsSchema.safeParse(f);
  return r.success ? [] : fmtIssues(r.error);
}

export class CustomExerciseError extends Error {
  constructor(
    readonly code: 'invalid' | 'changed' | 'deleted' | 'in_use' | 'limit' | 'no_profile' | 'archived',
    readonly details: string[] = [],
  ) {
    super(CUSTOM_ERROR_MESSAGE[code]);
    this.name = 'CustomExerciseError';
  }
}

export const CUSTOM_ERROR_MESSAGE: Record<CustomExerciseError['code'], string> = {
  invalid: 'O exercício tem campos inválidos e não foi gravado.',
  changed: 'Este exercício foi alterado em outra aba. Nada foi gravado: confira a versão atual e tente de novo.',
  deleted: 'Este exercício não existe mais (talvez tenha sido excluído em outra aba). Nada foi gravado.',
  in_use: 'Este exercício é usado em fichas ou no histórico e não pode ser excluído. Arquive-o para tirá-lo da lista sem perder nada.',
  limit: `Limite de ${CUSTOM_LIMITS.maxPerProfile} exercícios personalizados atingido.`,
  no_profile: 'Perfil local não inicializado. Nada foi gravado; recarregue a página.',
  archived: 'Este exercício está arquivado. Restaure-o antes de adicioná-lo a uma ficha.',
};

/** Normaliza o texto do formulário (espaços nas pontas; textos vazios viram ausentes). */
export function normalizeCustomFields(f: CustomFields): CustomFields {
  const out: CustomFields = { ...f, name: f.name.trim().replace(/\s+/g, ' '), secondaryMuscles: [...f.secondaryMuscles], equipment: [...f.equipment] };
  const ins = f.instructions?.trim();
  const notes = f.notes?.trim();
  if (ins) out.instructions = ins;
  else delete out.instructions;
  if (notes) out.notes = notes;
  else delete out.notes;
  return out;
}

export function newCustomExercise(id: string, fields: CustomFields, now: number): CustomExercise {
  const f = normalizeCustomFields(fields);
  const errs = customFieldErrors(f);
  if (!isCustomId(id)) errs.unshift('identificador inválido');
  if (errs.length) throw new CustomExerciseError('invalid', errs);
  return { id, ...f, archivedAt: null, createdAt: now, updatedAt: now, revision: 1 };
}

/** Nova versão do registro com os campos editados (mesmo ID; a revisão sobe). Arquivamento não muda aqui. */
export function editCustomExercise(cur: CustomExercise, fields: CustomFields, now: number): CustomExercise {
  const f = normalizeCustomFields(fields);
  const errs = customFieldErrors(f);
  if (errs.length) throw new CustomExerciseError('invalid', errs);
  const { instructions: _i, notes: _n, ...rest } = cur;
  return { ...rest, ...f, updatedAt: Math.max(now, cur.updatedAt), revision: cur.revision + 1 };
}

export function setArchived(cur: CustomExercise, archived: boolean, now: number): { exercise: CustomExercise; changed: boolean } {
  if ((cur.archivedAt !== null) === archived) return { exercise: cur, changed: false };
  return { exercise: { ...cur, archivedAt: archived ? now : null, updatedAt: Math.max(now, cur.updatedAt), revision: cur.revision + 1 }, changed: true };
}

export const fieldsOfCustom = (c: CustomExercise): CustomFields => {
  const f: CustomFields = {
    name: c.name,
    modality: c.modality,
    primaryMuscle: c.primaryMuscle,
    secondaryMuscles: [...c.secondaryMuscles],
    equipment: [...c.equipment],
    laterality: c.laterality,
    loadMode: c.loadMode,
    mechanics: c.mechanics,
  };
  if (c.instructions) f.instructions = c.instructions;
  if (c.notes) f.notes = c.notes;
  return f;
};

/** Campos para "Duplicar" (um item do catálogo ou personalizado vira ponto de partida de um novo personalizado). */
export function duplicateFields(item: LibraryItem): CustomFields {
  const f: CustomFields = {
    name: `${item.name} (cópia)`.slice(0, CUSTOM_LIMITS.maxName),
    modality: item.modality,
    primaryMuscle: item.primaryMuscles[0] ?? 'corpo_inteiro',
    secondaryMuscles: [...new Set([...item.primaryMuscles.slice(1), ...item.secondaryMuscles])].filter((m) => m !== item.primaryMuscles[0]).slice(0, CUSTOM_LIMITS.maxSecondary),
    equipment: item.equipment.slice(0, CUSTOM_LIMITS.maxEquipment),
    laterality: item.modality === 'cardio' ? 'bilateral' : item.laterality,
    loadMode: item.modality === 'cardio' ? null : item.loadMode ?? LOAD_MODES_BY_MODALITY[item.modality][0] ?? null,
    mechanics: item.mechanics,
  };
  const ins = item.instructions.join('\n').slice(0, CUSTOM_LIMITS.maxText);
  if (ins) f.instructions = ins;
  if (item.notes) f.notes = item.notes;
  return f;
}

export const catalogKey = (catalogId: string): LibraryKey => `catalog:${catalogId}`;
export const customKey = (id: string): LibraryKey => `custom:${id}`;

export function catalogItem(c: CatalogExercise): LibraryItem {
  return {
    kind: 'catalog',
    key: catalogKey(c.catalogId),
    refId: c.catalogId,
    name: c.name,
    aliases: c.aliases,
    modality: c.modality,
    primaryMuscles: c.primaryMuscles,
    secondaryMuscles: c.secondaryMuscles,
    equipment: c.equipment,
    movementPattern: c.movementPattern,
    laterality: c.laterality,
    loadMode: c.loadMode,
    mechanics: c.mechanics,
    difficulty: c.difficulty,
    instructions: c.instructions,
    commonMistakes: c.commonMistakes,
    safetyNotes: c.safetyNotes,
    notes: null,
    tags: c.tags,
    archived: false,
    version: c.version,
  };
}

export function customItem(c: CustomExercise): LibraryItem {
  return {
    kind: 'custom',
    key: customKey(c.id),
    refId: c.id,
    name: c.name,
    aliases: [],
    modality: c.modality,
    primaryMuscles: [c.primaryMuscle],
    secondaryMuscles: c.secondaryMuscles,
    equipment: c.equipment,
    movementPattern: null,
    laterality: c.laterality,
    loadMode: c.loadMode,
    mechanics: c.mechanics,
    difficulty: null,
    instructions: c.instructions ? c.instructions.split('\n').map((s) => s.trim()).filter(Boolean) : [],
    commonMistakes: [],
    safetyNotes: [],
    notes: c.notes ?? null,
    tags: ['personalizado'],
    archived: c.archivedAt !== null,
    version: c.revision,
  };
}

/**
 * Catálogo + personalizados válidos, numa lista só (os inválidos são ignorados e informados à parte pela tela).
 * O catálogo vem de '@/modules/exercises/catalog' (passado por quem chama, para não puxá-lo para o pacote principal).
 */
export function libraryItems(customs: readonly CustomExercise[], catalog: readonly CatalogExercise[]): LibraryItem[] {
  return [...catalog.map(catalogItem), ...customs.filter(isValidCustomExercise).map(customItem)];
}
