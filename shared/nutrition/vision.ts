// Reconhecimento de refeições por foto (IronTrack Life — Fase 03, docs/ALIMENTACAO_FOTO.md). Contrato compartilhado
// entre a API (que chama a OpenAI, valida e calcula) e o app (que captura, comprime e mostra a revisão).
//
// Divisão de responsabilidades:
//  - a OpenAI só IDENTIFICA alimentos e ESTIMA porções (saída estruturada, validada aqui). O esquema NÃO tem campos de
//    calorias ou macros: o modelo não tem onde "inventar" valores nutricionais;
//  - o servidor procura cada item no catálogo (TACO / alimentos da pessoa) e o sistema calcula os totais;
//  - nada é salvo: o resultado é um RASCUNHO que a pessoa revisa e confirma (ou o Assistente propõe e a pessoa aprova).
import { z } from 'zod';
import type { Macros, MealDraftItem, MealKind } from './protocol.ts';

export const MEAL_VISION_PROTOCOL = 'irontrack.life.mealPhoto.v1';
/** Versão do aviso de envio de fotos à OpenAI. Mudou o texto de forma relevante → sobe e o app pede de novo. */
export const PHOTO_NOTICE_VERSION = 1;

/**
 * Finalidades de leitura de imagem. `label` (rótulo nutricional) está só preparada: o servidor recusa até existir o
 * esquema próprio. Uma finalidade nova = esquema de saída + instruções + validação, sem mexer na captura nem na rota.
 */
export const VISION_PURPOSES = ['meal', 'label'] as const;
export type VisionPurpose = (typeof VISION_PURPOSES)[number];
export const VISION_PURPOSE_STATUS: Record<VisionPurpose, 'available' | 'planned'> = { meal: 'available', label: 'planned' };

/** Limites da imagem enviada. O app já reduz para ~1.536 px em JPEG; o servidor confere de novo. */
export const PHOTO_LIMITS = {
  /**
   * Bytes da imagem decodificada (base64 → binário). 3,5 MB em base64 ≈ 4,7 MB: cabe no limite de 5 MB do Caddy do
   * irontrack-web (o app costuma mandar ~0,3–1,4 MB).
   */
  maxBytes: 3_500_000,
  /** Lado maior aceito pelo servidor (o app manda até `targetSide`). */
  maxSide: 4096,
  minSide: 160,
  /** Lado maior que o app produz: suficiente para distinguir arroz, feijão e carnes sem custo alto. */
  targetSide: 1536,
  /** Formatos aceitos pelo servidor. HEIC/HEIF e outros são convertidos em JPEG no aparelho antes do envio. */
  mimes: ['image/jpeg', 'image/png'] as const,
  /** Observação opcional da pessoa ("frito no azeite", "sem açúcar"). */
  noteChars: 200,
} as const;
export type PhotoMime = (typeof PHOTO_LIMITS.mimes)[number];

/** Corpo enviado para análise. A imagem vai em data URL base64 (sem multipart, sem upload a outro serviço). */
export const photoAnalyzeSchema = z
  .object({
    image: z.string().min(32).max(Math.ceil((PHOTO_LIMITS.maxBytes * 4) / 3) + 64),
    purpose: z.enum(VISION_PURPOSES).default('meal'),
    note: z.string().trim().max(PHOTO_LIMITS.noteChars).nullish().transform((v) => (v ? v : null)),
    kind: z.enum(['breakfast', 'lunch', 'snack', 'dinner', 'supper', 'custom']).nullish(),
  })
  .strict();
export type PhotoAnalyzeInput = z.output<typeof photoAnalyzeSchema>;

// ------------------------------------------------------------------ saída estruturada do modelo

export const PREPARATIONS = ['cozido', 'grelhado', 'assado', 'frito', 'refogado', 'ensopado', 'vapor', 'cru', 'empanado', 'nao_identificado'] as const;
export type Preparation = (typeof PREPARATIONS)[number];
export const PREPARATION_LABEL: Record<Preparation, string> = { cozido: 'cozido', grelhado: 'grelhado', assado: 'assado', frito: 'frito', refogado: 'refogado', ensopado: 'ensopado', vapor: 'no vapor', cru: 'cru', empanado: 'empanado', nao_identificado: '' };
export const ITEM_ROLES = ['principal', 'acompanhamento', 'molho', 'bebida', 'sobremesa'] as const;
export const CONFIDENCE = ['alta', 'media', 'baixa'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE)[number];
export const CONFIDENCE_SCORE: Record<ConfidenceLevel, number> = { alta: 0.85, media: 0.6, baixa: 0.3 };
export const IMAGE_QUALITY = ['boa', 'desfocada', 'escura', 'parcial'] as const;

const visionItemSchema = z
  .object({
    nome: z.string().trim().min(1).max(80),
    termos_busca: z.array(z.string().trim().min(1).max(60)).max(4),
    preparo: z.enum(PREPARATIONS),
    papel: z.enum(ITEM_ROLES),
    quantidade: z.number().min(0).max(5000).nullable(),
    quantidade_min: z.number().min(0).max(5000).nullable(),
    quantidade_max: z.number().min(0).max(5000).nullable(),
    unidade: z.enum(['g', 'ml']),
    confianca: z.enum(CONFIDENCE),
    observacao: z.string().trim().max(200).nullable(),
  })
  .strict();

/** Validação REAL da resposta do modelo (o modelo pode errar ou ser induzido a errar por texto na imagem). */
export const mealVisionOutputSchema = z
  .object({
    contem_comida: z.boolean(),
    qualidade_imagem: z.enum(IMAGE_QUALITY),
    itens: z.array(visionItemSchema).max(20),
    observacoes_caloricas: z.array(z.string().trim().max(200)).max(6),
    nao_identificado: z.array(z.string().trim().max(160)).max(6),
    resumo: z.string().trim().max(300),
  })
  .strict();
export type MealVisionOutput = z.infer<typeof mealVisionOutputSchema>;
export type MealVisionItem = MealVisionOutput['itens'][number];

const nullable = (t: string) => ({ type: [t, 'null'] });
/** JSON Schema enviado à OpenAI (Structured Outputs, `strict: true`): todos os campos obrigatórios, sem extras. */
export const MEAL_VISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['contem_comida', 'qualidade_imagem', 'itens', 'observacoes_caloricas', 'nao_identificado', 'resumo'],
  properties: {
    contem_comida: { type: 'boolean', description: 'true só se a foto mostra comida ou bebida para consumo.' },
    qualidade_imagem: { type: 'string', enum: [...IMAGE_QUALITY] },
    itens: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['nome', 'termos_busca', 'preparo', 'papel', 'quantidade', 'quantidade_min', 'quantidade_max', 'unidade', 'confianca', 'observacao'],
        properties: {
          nome: { type: 'string', description: 'Nome curto e genérico em português do Brasil (ex.: "arroz branco", "feijão carioca", "peito de frango").' },
          termos_busca: { type: 'array', maxItems: 4, items: { type: 'string' }, description: 'De 1 a 4 nomes como numa tabela de composição brasileira (TACO), do mais específico ao mais genérico (ex.: "arroz tipo 1 cozido", "arroz cozido").' },
          preparo: { type: 'string', enum: [...PREPARATIONS] },
          papel: { type: 'string', enum: [...ITEM_ROLES] },
          quantidade: { ...nullable('number'), description: 'Estimativa visual da porção em g (sólidos) ou ml (bebidas). null se não der para estimar.' },
          quantidade_min: nullable('number'),
          quantidade_max: nullable('number'),
          unidade: { type: 'string', enum: ['g', 'ml'] },
          confianca: { type: 'string', enum: [...CONFIDENCE] },
          observacao: { ...nullable('string'), description: 'Dúvida curta (ex.: "pode ser purê ou arroz").' },
        },
      },
    },
    observacoes_caloricas: { type: 'array', maxItems: 6, items: { type: 'string' }, description: 'Óleo, manteiga, molhos ou preparo que podem mudar bastante as calorias e não dá para ver.' },
    nao_identificado: { type: 'array', maxItems: 6, items: { type: 'string' }, description: 'O que aparece mas não dá para identificar com segurança.' },
    resumo: { type: 'string', description: 'Uma frase descrevendo o prato.' },
  },
} as const;

// ------------------------------------------------------------------ visões devolvidas ao app

export interface PhotoItemView extends MealDraftItem {
  /** Id estável dentro da análise (para a revisão). */
  id: string;
  preparation: Preparation;
  role: (typeof ITEM_ROLES)[number];
  unit: 'g' | 'ml';
  range: { min: number; max: number } | null;
  confidenceLevel: ConfidenceLevel;
  /** true = a pessoa deve olhar este item (confiança baixa, sem correspondência, sem quantidade, preparo divergente). */
  needsReview: boolean;
  /** Termo que encontrou o alimento no catálogo (transparência). */
  matchedBy: string | null;
}

export interface PhotoAnalysisView {
  protocol: typeof MEAL_VISION_PROTOCOL;
  /** Id da análise (não fica salvo; serve de semente para o clientId do registro). */
  id: string;
  status: 'ok' | 'no_food' | 'low_quality';
  imageQuality: (typeof IMAGE_QUALITY)[number];
  summary: string;
  items: PhotoItemView[];
  /** Observações curtas sobre óleo, molhos e preparo (podem mudar as calorias). */
  calorieNotes: string[];
  uncertain: string[];
  /** Totais calculados pelo SISTEMA com os alimentos do catálogo (itens sem alimento ou sem quantidade ficam de fora). */
  totals: Macros;
  /** Itens que não entraram no total e nutrientes ausentes na fonte (não viram zero silencioso). */
  completeness: { itemsCounted: number; itemsPending: number; missing: Partial<Record<'protein' | 'carbs' | 'fat' | 'fiber', number>> };
  suggestedKind: MealKind | null;
  model: string;
  /** Sempre false: a foto não é guardada. */
  storedPhoto: false;
}

export interface VisionStatusView {
  available: boolean;
  /** Motivo quando indisponível (frase fixa). */
  reason: string | null;
  notice: { version: number; accepted: boolean };
  limits: { photosPerDay: number; maxBytes: number; targetSide: number };
  usage: { day: string; photos: number };
  purposes: Record<VisionPurpose, 'available' | 'planned'>;
}

/** Nutrientes ausentes na fonte de cada item (null em per100). */
export function missingNutrients(items: { per100: { protein: number | null; carbs: number | null; fat: number | null; fiber: number | null } }[]): PhotoAnalysisView['completeness']['missing'] {
  const out: PhotoAnalysisView['completeness']['missing'] = {};
  for (const i of items) for (const k of ['protein', 'carbs', 'fat', 'fiber'] as const) if (i.per100[k] == null) out[k] = (out[k] ?? 0) + 1;
  return out;
}

// Mensagens de erro: ASSISTANT_ERROR_MESSAGES (shared/assistant/protocol.ts), mesmas chaves da IA central.
