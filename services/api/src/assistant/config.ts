// Configuração do Assistente IA central (Fase 00). Provedor, modelos permitidos e limites ficam no servidor:
// o app só escolhe entre os modelos desta lista. Sem segredos: a chave vem da variável `apiKeyEnv`.
// Fonte: ASSISTANT_CONFIG_JSON > ASSISTANT_CONFIG_PATH > config/assistant.json.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const effort = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

const modelSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/),
    displayName: z.string().min(1).max(60),
    description: z.string().max(140).default(''),
    reasoningEffort: effort.optional(),
    maxOutputTokens: z.number().int().min(256).max(32_000),
  })
  .strict();

const limitsSchema = z
  .object({
    messagesPerMinute: z.number().int().min(1).max(120),
    messagesPerDay: z.number().int().min(1).max(10_000),
    tokensPerDay: z.number().int().min(1_000).max(50_000_000),
    maxConcurrentPerUser: z.number().int().min(1).max(5),
    maxConcurrentTotal: z.number().int().min(1).max(200),
    maxToolRounds: z.number().int().min(1).max(12),
    providerTimeoutMs: z.number().int().min(5_000).max(300_000),
    turnTimeoutMs: z.number().int().min(5_000).max(300_000),
    historyMessages: z.number().int().min(2).max(80),
    historyChars: z.number().int().min(2_000).max(200_000),
    summarizeAfterMessages: z.number().int().min(6).max(400),
    maxToolOutputChars: z.number().int().min(1_000).max(100_000),
    maxProviderResponseBytes: z.number().int().min(65_536).max(32 * 1024 * 1024),
    actionTtlHours: z.number().int().min(1).max(24 * 30),
  })
  .strict();

export const assistantConfigSchema = z
  .object({
    $comment: z.string().optional(),
    enabled: z.boolean(),
    provider: z.literal('openai'),
    displayName: z.string().min(1).max(60),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    /** Só para testes (provedor simulado em loopback). Em produção é sempre o endereço oficial. */
    baseUrl: z.string().url().optional(),
    defaultModel: z.string(),
    summaryModel: z.string(),
    models: z.array(modelSchema).min(1).max(10),
    limits: limitsSchema,
  })
  .strict()
  .superRefine((c, ctx) => {
    const ids = new Set(c.models.map((m) => m.id));
    if (ids.size !== c.models.length) ctx.addIssue({ code: 'custom', message: 'models: IDs repetidos', path: ['models'] });
    if (!ids.has(c.defaultModel)) ctx.addIssue({ code: 'custom', message: 'defaultModel fora de models', path: ['defaultModel'] });
    if (!ids.has(c.summaryModel)) ctx.addIssue({ code: 'custom', message: 'summaryModel fora de models', path: ['summaryModel'] });
    if (c.limits.turnTimeoutMs < c.limits.providerTimeoutMs) ctx.addIssue({ code: 'custom', message: 'turnTimeoutMs menor que providerTimeoutMs', path: ['limits'] });
  });

export type AssistantConfig = z.infer<typeof assistantConfigSchema>;
export type AssistantModel = AssistantConfig['models'][number];

export function loadAssistantConfig(env: Record<string, string | undefined>): { config: AssistantConfig | null; errors: string[] } {
  let raw: unknown;
  try {
    raw = env.ASSISTANT_CONFIG_JSON
      ? JSON.parse(env.ASSISTANT_CONFIG_JSON)
      : JSON.parse(readFileSync(env.ASSISTANT_CONFIG_PATH ?? new URL('../../config/assistant.json', import.meta.url).pathname, 'utf8'));
  } catch {
    return { config: null, errors: [env.ASSISTANT_CONFIG_JSON ? 'ASSISTANT_CONFIG_JSON (JSON inválido)' : 'ASSISTANT_CONFIG_PATH (arquivo ausente ou JSON inválido)'] };
  }
  const r = assistantConfigSchema.safeParse(raw);
  if (!r.success) return { config: null, errors: r.error.issues.map((i) => `assistente: ${i.path.join('.') || '(raiz)'} ${i.message}`) };
  if (env.NODE_ENV === 'production' && r.data.baseUrl && !r.data.baseUrl.startsWith('https://')) return { config: null, errors: ['assistente: baseUrl (produção exige https)'] };
  if (env.ASSISTANT_ENABLED === 'false') return { config: { ...r.data, enabled: false }, errors: [] };
  return { config: r.data, errors: [] };
}

/** Formato de chave da API da OpenAI ("sk-..."; inclui chaves de projeto "sk-proj-..."). Pega valor colado errado. */
export const openAiKeyFormatOk = (k: string) => /^sk-[A-Za-z0-9_-]{16,}$/.test(k) && !k.startsWith('sk-ant-') && !k.startsWith('sk-admin-');
