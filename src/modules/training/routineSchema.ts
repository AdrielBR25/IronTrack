import { z } from 'zod';
import type { DistanceUnit, Equipment, ExerciseCategory, ExerciseLaterality, ExerciseModelFields, LoadMode, RestDefaults, Routine, TrainingModality } from './types';
import { LOAD_MODES_BY_MODALITY, MODEL_LIMITS, fromMetersTo, toMetersFrom } from './exerciseModel';
import { uid } from '@/lib/utils';
import { formatZodError, parseJsonText, type ParseResult } from '@/lib/validation';

// Esquema da ficha de treino (importação/exportação). Documentado em docs/FICHA_JSON.md.

export const FICHA_FORMAT = 'irontrack.ficha';
/** v1: formato original · v2 (P10): + campos opcionais de modalidade. Arquivos v1 continuam aceitos. */
export const FICHA_VERSION = 2;

// Campos opcionais do modelo v3 na ficha (P10). Só são lidos quando escritos explicitamente: um número em
// "repeticoes" nunca vira duração ou distância, e a modalidade nunca é deduzida do nome do exercício.
const MODALITY_MAP: Record<string, TrainingModality> = { musculacao: 'resistance', peso_corporal: 'bodyweight', tempo: 'timed', cardio: 'cardio' };
const MODALITY_REVERSE: Record<TrainingModality, string> = { resistance: 'musculacao', bodyweight: 'peso_corporal', timed: 'tempo', cardio: 'cardio' };
const LOAD_MODE_KEYS = ['externa', 'corporal', 'adicional', 'assistida'] as const satisfies readonly LoadMode[];

const EQUIP_MAP: Record<string, Equipment> = {
  barra: 'barbell',
  halteres: 'dumbbell',
  halter: 'dumbbell',
  maquina: 'machine',
  máquina: 'machine',
  polia: 'cable',
  cabo: 'cable',
  peso_corporal: 'bodyweight',
  'peso corporal': 'bodyweight',
  outro: 'other',
};
const EQUIP_REVERSE: Record<Equipment, string> = {
  barbell: 'barra',
  dumbbell: 'halteres',
  machine: 'maquina',
  cable: 'polia',
  bodyweight: 'peso_corporal',
  other: 'outro',
};

const TYPE_MAP: Record<string, ExerciseCategory> = {
  composto: 'compound',
  multiarticular: 'compound',
  isolado: 'isolation',
  isolador: 'isolation',
  monoarticular: 'isolation',
};

export interface RepRange {
  min: number;
  max: number;
}

/** Aceita 10, "10", "6-10", "6–10", "6 a 10", "8 — 12". */
export function parseRepRange(input: unknown): RepRange | null {
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 1 || input > 100) return null;
    return { min: input, max: input };
  }
  if (typeof input === 'object' && input !== null) {
    const o = input as Record<string, unknown>;
    const min = Number(o.min);
    const max = Number(o.max);
    if (Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max >= min && max <= 100) return { min, max };
    return null;
  }
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const single = /^(\d{1,3})$/.exec(s);
  if (single) return parseRepRange(Number(single[1]));
  const m = /^(\d{1,3})\s*(?:-|–|—|a|até|to)\s*(\d{1,3})$/i.exec(s);
  if (!m) return null;
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (min < 1 || max < min || max > 100) return null;
  return { min, max };
}

export function fmtRepRange(min: number, max: number): string {
  return min === max ? String(min) : `${min}–${max}`;
}

const repsSchema = z
  .union([z.number(), z.string(), z.object({ min: z.number(), max: z.number() })], {
    errorMap: () => ({ message: 'use um número (10) ou uma faixa em texto ("6-10")' }),
  })
  .superRefine((v, ctx) => {
    if (!parseRepRange(v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `faixa de repetições inválida (${JSON.stringify(v)}). Use, por exemplo, 10, "6-10" ou "8–12", com mínimo ≤ máximo`,
      });
    }
  });

const exerciseSchema = z.object({
  nome: z.string({ required_error: 'o nome do exercício é obrigatório' }).trim().min(1, 'o nome do exercício não pode ficar vazio').max(80),
  grupo: z.string({ required_error: 'informe o grupo muscular ("grupo")' }).trim().min(1, 'informe o grupo muscular'),
  tipo: z
    .string()
    .optional()
    .refine((v) => v === undefined || v.toLowerCase() in TYPE_MAP, { message: 'tipo deve ser "composto" ou "isolado"' }),
  equipamento: z
    .string()
    .optional()
    .refine((v) => v === undefined || v.toLowerCase() in EQUIP_MAP, {
      message: 'equipamento deve ser: barra, halteres, maquina, polia, peso_corporal ou outro',
    }),
  series: z
    .number({ required_error: 'informe o número de séries ("series")', invalid_type_error: 'séries deve ser um número' })
    .int('séries deve ser um número inteiro')
    .min(1, 'mínimo de 1 série')
    .max(20, 'máximo de 20 séries'),
  repeticoes: repsSchema,
  descanso: z.number({ invalid_type_error: 'descanso deve ser em segundos (número)' }).int().min(0).max(900, 'descanso máximo de 900 s').optional(),
  aquecimento: z.number({ invalid_type_error: 'aquecimento deve ser um número de séries' }).int().min(0).max(5).optional(),
  carga: z.number({ invalid_type_error: 'carga deve ser um número em kg' }).min(0).max(1000).optional(),
  observacoes: z.string().max(500).optional(),
  substitutos: z.array(z.string().trim().min(1)).max(10).optional(),
  modalidade: z.enum(['musculacao', 'peso_corporal', 'tempo', 'cardio'], { errorMap: () => ({ message: 'modalidade deve ser: musculacao, peso_corporal, tempo ou cardio' }) }).optional(),
  lateralidade: z.enum(['bilateral', 'unilateral'], { errorMap: () => ({ message: 'lateralidade deve ser "bilateral" ou "unilateral"' }) }).optional(),
  tipo_carga: z.enum(LOAD_MODE_KEYS, { errorMap: () => ({ message: 'tipo_carga deve ser: externa, corporal, adicional ou assistida' }) }).optional(),
  grupos_secundarios: z
    .array(z.string().trim().min(1, 'grupo secundário vazio').max(MODEL_LIMITS.maxMuscleChars), { invalid_type_error: 'grupos_secundarios deve ser uma lista de textos' })
    .max(MODEL_LIMITS.maxSecondaryMuscles, `no máximo ${MODEL_LIMITS.maxSecondaryMuscles} grupos secundários`)
    .optional(),
  unidade_distancia: z.enum(['m', 'km', 'mi'], { errorMap: () => ({ message: 'unidade_distancia deve ser "m", "km" ou "mi"' }) }).optional(),
  duracao: z
    .number({ invalid_type_error: 'duracao deve ser em segundos (número inteiro)' })
    .int('duracao deve ser um número inteiro de segundos')
    .min(1, 'duracao deve ser maior que zero')
    .max(MODEL_LIMITS.maxDurationSec, `duracao máxima de ${MODEL_LIMITS.maxDurationSec} s`)
    .optional(),
  distancia: z.number({ invalid_type_error: 'distancia deve ser um número' }).positive('distancia deve ser maior que zero').finite().optional(),
}).superRefine((e, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  const m = e.modalidade ? MODALITY_MAP[e.modalidade] : undefined;
  if (m && e.tipo_carga && !LOAD_MODES_BY_MODALITY[m].includes(e.tipo_carga)) issue('tipo_carga', `tipo_carga "${e.tipo_carga}" não combina com a modalidade "${e.modalidade}"`);
  if (e.duracao !== undefined && m !== 'timed' && m !== 'cardio') issue('duracao', 'duracao só vale com "modalidade": "tempo" ou "cardio" (escreva a modalidade explicitamente)');
  if (e.distancia !== undefined) {
    if (m !== 'cardio') issue('distancia', 'distancia só vale com "modalidade": "cardio"');
    if (!e.unidade_distancia) issue('distancia', 'informe "unidade_distancia" ("m", "km" ou "mi"): a distância não é interpretada sem unidade');
    else if (toMetersFrom(e.distancia, e.unidade_distancia) > MODEL_LIMITS.maxDistanceM) issue('distancia', 'distancia máxima de 1 000 km');
  }
  if (e.lateralidade === 'unilateral' && m === 'cardio') issue('lateralidade', 'cardio não pode ser unilateral');
});

const workoutSchema = z.object({
  rotulo: z.string({ required_error: 'cada treino precisa de um rótulo ("rotulo"), ex.: "A"' }).trim().min(1).max(4, 'rótulo com no máximo 4 caracteres'),
  nome: z.string({ required_error: 'cada treino precisa de um nome' }).trim().min(1).max(60),
  observacoes: z.string().max(500).optional(),
  exercicios: z.array(exerciseSchema, { required_error: 'cada treino precisa da lista "exercicios"' }).min(1, 'o treino precisa de pelo menos 1 exercício'),
});

export const fichaSchema = z
  .object({
    formato: z.literal(FICHA_FORMAT, {
      errorMap: () => ({ message: `o campo "formato" deve ser "${FICHA_FORMAT}"` }),
    }),
    versao: z.number().int().min(1).max(FICHA_VERSION, { message: `versão não suportada (máximo ${FICHA_VERSION}); atualize o IronTrack` }),
    nome: z.string({ required_error: 'a ficha precisa de um nome' }).trim().min(1).max(60),
    descricao: z.string().max(500).optional(),
    treinos: z.array(workoutSchema, { required_error: 'a ficha precisa da lista "treinos"' }).min(1, 'a ficha precisa de pelo menos 1 treino').max(10),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    f.treinos.forEach((t, i) => {
      const k = t.rotulo.toUpperCase();
      if (seen.has(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['treinos', i, 'rotulo'], message: `rótulo "${t.rotulo}" repetido` });
      seen.add(k);
    });
  });

export type FichaJson = z.infer<typeof fichaSchema>;

/** Rótulos dos caminhos de erro da ficha: "Treino 2 › Exercício 3 › series". */
const FICHA_PATH_LABELS: Record<string, string> = { treinos: 'Treino', exercicios: 'Exercício' };

/** Mensagens de erro da ficha, com caminhos em português (ex.: "Treino 1 › Exercício 2 › series: …"). */
export function formatFichaErrors(err: z.ZodError): string[] {
  return formatZodError(err, FICHA_PATH_LABELS);
}

export function fichaToRoutine(ficha: FichaJson, settings: Pick<RestDefaults, 'restCompoundSec' | 'restIsolationSec'>): Routine {
  const now = Date.now();
  return {
    id: uid(),
    name: ficha.nome,
    description: ficha.descricao,
    createdAt: now,
    updatedAt: now,
    workouts: ficha.treinos.map((t) => ({
      id: uid(),
      label: t.rotulo.toUpperCase(),
      name: t.nome,
      notes: t.observacoes,
      exercises: t.exercicios.map((e) => {
        const reps = parseRepRange(e.repeticoes)!;
        const category = e.tipo ? TYPE_MAP[e.tipo.toLowerCase()] : 'compound';
        return {
          id: uid(),
          name: e.nome,
          muscleGroup: e.grupo,
          category,
          equipment: e.equipamento ? EQUIP_MAP[e.equipamento.toLowerCase()] : 'other',
          sets: e.series,
          repMin: reps.min,
          repMax: reps.max,
          restSec: e.descanso ?? (category === 'compound' ? settings.restCompoundSec : settings.restIsolationSec),
          warmupSets: e.aquecimento ?? 0,
          targetWeight: e.carga,
          notes: e.observacoes,
          substitutes: e.substitutos,
          ...fichaModelFields(e),
        };
      }),
    })),
  };
}

/** Só os campos escritos na ficha; nada é deduzido. */
function fichaModelFields(e: z.infer<typeof exerciseSchema>): ExerciseModelFields {
  const out: ExerciseModelFields = {};
  if (e.modalidade) out.modality = MODALITY_MAP[e.modalidade];
  if (e.lateralidade) out.laterality = e.lateralidade as ExerciseLaterality;
  if (e.tipo_carga) out.loadMode = e.tipo_carga;
  if (e.grupos_secundarios?.length) out.secondaryMuscles = [...new Set(e.grupos_secundarios.map((g) => g.trim()))];
  if (e.unidade_distancia) out.distanceUnit = e.unidade_distancia as DistanceUnit;
  if (e.duracao !== undefined) out.targetDurationSec = e.duracao;
  if (e.distancia !== undefined && e.unidade_distancia) out.targetDistance = toMetersFrom(e.distancia, e.unidade_distancia);
  return out;
}

export function parseFicha(
  text: string,
  settings: Pick<RestDefaults, 'restCompoundSec' | 'restIsolationSec'>,
): ParseResult<Routine> {
  const raw = parseJsonText(text);
  if (!raw.ok) return raw;
  const res = fichaSchema.safeParse(raw.value);
  if (!res.success) return { ok: false, errors: formatFichaErrors(res.error) };
  return { ok: true, value: fichaToRoutine(res.data, settings) };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function modelToFicha(e: ExerciseModelFields) {
  return {
    ...(e.modality ? { modalidade: MODALITY_REVERSE[e.modality] as 'musculacao' } : {}),
    ...(e.laterality ? { lateralidade: e.laterality } : {}),
    ...(e.loadMode ? { tipo_carga: e.loadMode } : {}),
    ...(e.secondaryMuscles?.length ? { grupos_secundarios: [...e.secondaryMuscles] } : {}),
    ...(e.distanceUnit ? { unidade_distancia: e.distanceUnit } : {}),
    ...(e.targetDurationSec !== undefined ? { duracao: e.targetDurationSec } : {}),
    // Distância só é exportada com unidade explícita (na ficha a distância é escrita na unidade do exercício).
    ...(e.targetDistance !== undefined && e.distanceUnit ? { distancia: round3(fromMetersTo(e.targetDistance, e.distanceUnit)) } : {}),
  };
}

export function routineToFicha(r: Routine): FichaJson {
  const usesModel = r.workouts.some((w) => w.exercises.some((e) => Object.keys(modelToFicha(e)).length > 0));
  return {
    formato: FICHA_FORMAT,
    // Fichas sem campos novos continuam v1 (abrem em versões anteriores do app); com campos novos, v2, para que
    // uma versão antiga recuse o arquivo em vez de descartar os campos em silêncio.
    versao: usesModel ? FICHA_VERSION : 1,
    nome: r.name,
    ...(r.description ? { descricao: r.description } : {}),
    treinos: r.workouts.map((w) => ({
      rotulo: w.label,
      nome: w.name,
      ...(w.notes ? { observacoes: w.notes } : {}),
      exercicios: w.exercises.map((e) => ({
        nome: e.name,
        grupo: e.muscleGroup,
        tipo: e.category === 'compound' ? 'composto' : 'isolado',
        equipamento: EQUIP_REVERSE[e.equipment],
        series: e.sets,
        repeticoes: fmtRepRange(e.repMin, e.repMax).replace('–', '-'),
        descanso: e.restSec,
        aquecimento: e.warmupSets,
        ...(e.targetWeight !== undefined ? { carga: e.targetWeight } : {}),
        ...(e.notes ? { observacoes: e.notes } : {}),
        ...(e.substitutes?.length ? { substitutos: e.substitutes } : {}),
        ...modelToFicha(e),
      })),
    })),
  };
}
