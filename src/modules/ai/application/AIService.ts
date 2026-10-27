// Serviço central de IA: valida a solicitação, monta o contexto autorizado, confere o
// consentimento, executa o adaptador escolhido (sem troca automática e sem repetição),
// aplica cancelamento e tempo limite e normaliza a resposta.
//
// Fluxo em duas etapas, para que o usuário veja o que será enviado antes de autorizar:
//   1. prepare(input)              → PreparedAIRequest (mensagens exatas + assinatura)
//   2. createConsent(prepared)     → AIConsent (só depois de o usuário confirmar na interface)
//   3. execute(prepared, consent)  → AIResponse (somente leitura)
// Nada é persistido. A resposta não executa comandos nem altera registros.
import type { AIProviderDescriptor } from '../domain/contracts';
import { AIError, toAIError, type AIErrorCode } from '../domain/errors';
import { DEFAULT_CONSENT_TTL_MS, MAX_CONSENT_TTL_MS, evaluateConsent, isBlockedCategory, isPurpose, type AIConsent, type AIContextCategory, type AIPurpose, type ConsentTarget } from '../domain/permissions';
import type { AICapabilityFlag, AIMessage, AIOutput, AIRequest, AIResponse, AIResponseFormat, JsonValue } from '../domain/types';
import { buildAIContext, normalizeCategories, type AIContext, type AIContextSources, type ContextLimits } from './ContextBuilder';
import type { ProviderRegistry } from './ProviderRegistry';

export const AI_REQUEST_LIMITS = {
  maxInstructionChars: 2_000,
  maxSystemChars: 2_000,
  defaultOutputTokens: 512,
  maxOutputTokens: 4_096,
  /** Aproximação usada para cortar a saída sem tokenizador: ~4 caracteres por token. */
  charsPerToken: 4,
  defaultTimeoutMs: 60_000,
} as const;

/** Instrução fixa de sistema: deixa claro o papel e os limites da IA no IronTrack. */
export const BASE_SYSTEM_PROMPT =
  'Você é um assistente do IronTrack, um app pessoal de registro de treinos. Responda em português do Brasil, ' +
  'apenas com base no contexto fornecido. Não faça diagnóstico médico nem prescrição nutricional. Você não pode ' +
  'executar ações nem alterar dados do usuário.';

export interface AIPrepareInput {
  /** Escolha explícita: não há provedor padrão. */
  providerId: string;
  modelId: string;
  purpose: AIPurpose;
  /** Pergunta ou pedido do usuário. */
  instruction: string;
  /** Instrução de sistema adicional (opcional). */
  system?: string;
  /** Categorias que o usuário selecionou. Vazio = nenhum dado pessoal. */
  categories?: readonly AIContextCategory[];
  /** Dados oferecidos explicitamente por quem chama. O serviço não busca nada no banco. */
  sources?: AIContextSources;
  maxOutputTokens?: number;
  responseFormat?: AIResponseFormat;
}

/** Solicitação pronta para revisão e autorização. Congelada: alterá-la invalida a assinatura. */
export interface PreparedAIRequest {
  readonly requestId: string;
  readonly providerId: string;
  readonly modelId: string;
  /** Destino declarado pelo provedor (null = simulado, nada sai do aparelho). Assinado. */
  readonly destination: string | null;
  readonly purpose: AIPurpose;
  readonly categories: readonly AIContextCategory[];
  readonly context: AIContext;
  readonly request: AIRequest;
  readonly binding: string;
  readonly preparedAt: number;
}

export interface AIExecuteOptions {
  signal?: AbortSignal;
  /** Tempo limite em ms (padrão 60 s). */
  timeoutMs?: number;
}

/** Evento de log sem conteúdo: nunca inclui mensagens, contexto, resposta ou detalhes do provedor. */
export interface AILogEvent {
  type: 'execute_start' | 'execute_success' | 'execute_error';
  requestId: string;
  providerId: string;
  modelId: string;
  code?: AIErrorCode;
  durationMs?: number;
}

export interface AIServiceDeps {
  registry: ProviderRegistry;
  now?: () => number;
  randomId?: () => string;
  /** SHA-256 em hexadecimal. Padrão: Web Crypto. */
  digest?: (text: string) => Promise<string>;
  logger?: (event: AILogEvent) => void;
  contextLimits?: Partial<ContextLimits>;
}

async function webCryptoSha256(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  // Sem hash não dá para vincular a autorização à solicitação: falha segura.
  if (!subtle) throw new AIError('permission_denied');
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function defaultRandomId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  throw new AIError('request_invalid');
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** Texto canônico do que será enviado; a assinatura da autorização é o SHA-256 dele. */
function bindingText(p: Pick<PreparedAIRequest, 'requestId' | 'providerId' | 'modelId' | 'destination' | 'purpose' | 'categories' | 'request'>): string {
  return JSON.stringify([
    'irontrack.ai.binding.v2',
    p.requestId,
    p.providerId,
    p.modelId,
    p.destination ?? null,
    p.purpose,
    [...p.categories],
    p.request.modelId,
    p.request.messages.map((m) => [m.role, m.content]),
    p.request.maxOutputTokens,
    p.request.responseFormat.type === 'json' ? ['json', p.request.responseFormat.schemaName] : ['text'],
  ]);
}

const targetOf = (p: PreparedAIRequest): ConsentTarget => ({
  requestId: p.requestId,
  providerId: p.providerId,
  modelId: p.modelId,
  purpose: p.purpose,
  categories: p.categories,
  binding: p.binding,
});

function isJsonValue(v: unknown, depth = 0): v is JsonValue {
  if (depth > 32) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1));
  if (typeof v === 'object') return Object.values(v as object).every((x) => isJsonValue(x, depth + 1));
  return false;
}

/**
 * Cria a autorização para UMA solicitação preparada, depois que o usuário viu o destino, a
 * finalidade e os dados. Vale só para esse provedor, modelo, finalidade, categorias e conteúdo.
 */
export function createConsent(prepared: PreparedAIRequest, opts: { grantedAt: number; ttlMs?: number; id: string }): AIConsent {
  const ttl = Math.min(Math.max(1, opts.ttlMs ?? DEFAULT_CONSENT_TTL_MS), MAX_CONSENT_TTL_MS);
  return deepFreeze({
    id: opts.id,
    providerId: prepared.providerId,
    modelId: prepared.modelId,
    purpose: prepared.purpose,
    categories: [...prepared.categories],
    scope: { requestId: prepared.requestId, binding: prepared.binding },
    grantedAt: opts.grantedAt,
    expiresAt: opts.grantedAt + ttl,
  });
}

export class AIService {
  private readonly registry: ProviderRegistry;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly digest: (text: string) => Promise<string>;
  private readonly logger?: (event: AILogEvent) => void;
  private readonly contextLimits: Partial<ContextLimits>;
  /** Autorizações já usadas (só em memória): cada uma vale uma vez. */
  private readonly usedConsents = new Set<string>();

  constructor(deps: AIServiceDeps) {
    this.registry = deps.registry;
    this.now = deps.now ?? Date.now;
    this.randomId = deps.randomId ?? defaultRandomId;
    this.digest = deps.digest ?? webCryptoSha256;
    this.logger = deps.logger;
    this.contextLimits = deps.contextLimits ?? {};
  }

  /** Provedores disponíveis para a interface listar (sem o adaptador). */
  listProviders(): AIProviderDescriptor[] {
    return this.registry.list();
  }

  /** Valida a solicitação e monta as mensagens exatas. Não envia nada. */
  async prepare(input: AIPrepareInput): Promise<PreparedAIRequest> {
    if (!input || typeof input !== 'object') throw new AIError('request_invalid');
    if (!isPurpose(input.purpose)) throw new AIError('permission_denied');
    const responseFormat: AIResponseFormat = input.responseFormat ?? { type: 'text' };
    if (responseFormat.type !== 'text' && !(responseFormat.type === 'json' && typeof responseFormat.schemaName === 'string' && responseFormat.schemaName))
      throw new AIError('request_invalid');
    const required: AICapabilityFlag[] = ['textGeneration'];
    if (responseFormat.type === 'json') required.push('structuredOutput');
    const { provider, model } = this.registry.resolve(String(input.providerId ?? ''), String(input.modelId ?? ''), required);

    const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';
    if (!instruction || instruction.length > AI_REQUEST_LIMITS.maxInstructionChars) throw new AIError('request_invalid', provider.id);
    if (input.system !== undefined && (typeof input.system !== 'string' || input.system.length > AI_REQUEST_LIMITS.maxSystemChars))
      throw new AIError('request_invalid', provider.id);

    const maxOut = input.maxOutputTokens ?? Math.min(AI_REQUEST_LIMITS.defaultOutputTokens, model.capabilities.maxOutputTokens);
    if (!Number.isInteger(maxOut) || maxOut < 1 || maxOut > AI_REQUEST_LIMITS.maxOutputTokens || maxOut > model.capabilities.maxOutputTokens)
      throw new AIError('request_invalid', provider.id);

    const selected = normalizeCategories(input.categories ?? []);
    const context = buildAIContext(input.sources ?? {}, selected, this.contextLimits);
    // Categorias bloqueadas (fotos) ficam fora do pedido e da autorização; o contexto as lista em `excluded`.
    const categories = selected.filter((c) => !isBlockedCategory(c));

    const system = [BASE_SYSTEM_PROMPT, input.system?.trim()].filter(Boolean).join('\n\n');
    const user = context.included.length
      ? `${instruction}\n\nContexto autorizado pelo usuário (JSON):\n${JSON.stringify(context.data)}`
      : instruction;
    const messages: AIMessage[] = model.capabilities.systemMessages
      ? [{ role: 'system', content: system }, { role: 'user', content: user }]
      : [{ role: 'user', content: `${system}\n\n${user}` }];
    if (messages.reduce((a, m) => a + m.content.length, 0) > model.capabilities.maxInputChars) throw new AIError('request_invalid', provider.id);

    const base = {
      requestId: this.randomId(),
      providerId: provider.id,
      modelId: model.id,
      destination: provider.destination ?? null,
      purpose: input.purpose,
      categories,
      context,
      request: { modelId: model.id, messages, maxOutputTokens: maxOut, responseFormat: { ...responseFormat } },
      preparedAt: this.now(),
    };
    const binding = await this.digest(bindingText(base));
    return deepFreeze({ ...base, binding });
  }

  /** Executa uma solicitação preparada com a autorização correspondente. */
  async execute(prepared: PreparedAIRequest, consent: AIConsent | undefined, options: AIExecuteOptions = {}): Promise<AIResponse> {
    const providerId = typeof prepared?.providerId === 'string' ? prepared.providerId : '';
    const modelId = typeof prepared?.modelId === 'string' ? prepared.modelId : '';
    const requestId = typeof prepared?.requestId === 'string' ? prepared.requestId : '';
    const startedAt = this.now();
    const log = (type: AILogEvent['type'], extra: Partial<AILogEvent> = {}) => this.logger?.({ type, requestId, providerId, modelId, ...extra });
    try {
      if (options.signal?.aborted) throw new AIError('cancelled', providerId || undefined);
      await this.authorize(prepared, consent);
      const { provider, model } = this.registry.resolve(providerId, modelId, prepared.request.responseFormat.type === 'json' ? ['textGeneration', 'structuredOutput'] : ['textGeneration']);
      // O destino autorizado é o destino atual: reconectar a outro gateway invalida a autorização.
      if ((provider.destination ?? null) !== (prepared.destination ?? null)) throw new AIError('permission_denied', provider.id);
      if (provider.isAvailable && !(await provider.isAvailable())) throw new AIError('provider_unavailable', provider.id);
      log('execute_start');

      const raw: unknown = await this.run((signal) => provider.generate(prepared.request, { signal }), options, provider.id);
      const { output, finishReason, truncated } = this.normalize(raw, prepared, model.id, provider.id);
      const finishedAt = this.now();
      const usage = this.usage((raw as { usage?: unknown }).usage);
      log('execute_success', { durationMs: finishedAt - startedAt });
      return deepFreeze({
        providerId: provider.id,
        modelId: model.id,
        output,
        finishReason,
        ...(usage ? { usage } : {}),
        metadata: { requestId, startedAt, finishedAt, durationMs: finishedAt - startedAt, simulated: provider.kind === 'simulated', truncated },
      });
    } catch (e) {
      const err = toAIError(e, 'provider_failure', providerId || undefined);
      log('execute_error', { code: err.code, durationMs: this.now() - startedAt });
      throw err;
    }
  }

  /** Confere integridade da solicitação preparada e a autorização; consome a autorização. */
  private async authorize(prepared: PreparedAIRequest, consent: AIConsent | undefined): Promise<void> {
    if (!prepared || typeof prepared !== 'object' || !prepared.request || !Array.isArray(prepared.request.messages)) throw new AIError('request_invalid');
    // Recalcula a assinatura: qualquer mudança no destino, nas categorias ou no texto a invalida.
    const current = await this.digest(bindingText(prepared));
    if (current !== prepared.binding) throw new AIError('permission_denied', prepared.providerId);
    const decision = evaluateConsent(consent, targetOf(prepared), this.now());
    if (!decision.allowed) throw new AIError('permission_denied', prepared.providerId);
    const id = (consent as AIConsent).id;
    if (this.usedConsents.has(id)) throw new AIError('permission_denied', prepared.providerId);
    this.usedConsents.add(id);
  }

  /** Executa com cancelamento e tempo limite, mesmo que o adaptador ignore o sinal. */
  private run<T>(call: (signal: AbortSignal) => Promise<T>, options: AIExecuteOptions, providerId: string): Promise<T> {
    const ctrl = new AbortController();
    const timeoutMs = options.timeoutMs ?? AI_REQUEST_LIMITS.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => {
        ctrl.abort();
        finish(() => reject(new AIError('cancelled', providerId)));
      };
      const timer = setTimeout(() => {
        ctrl.abort();
        finish(() => reject(new AIError('timeout', providerId)));
      }, timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) return onAbort();
      Promise.resolve().then(() => call(ctrl.signal)).then(
        (v) => finish(() => resolve(v)),
        (e) => finish(() => reject(e)),
      );
    });
  }

  private normalize(raw: unknown, prepared: PreparedAIRequest, modelId: string, providerId: string): { output: AIOutput; finishReason: 'stop' | 'length'; truncated: boolean } {
    const bad = () => new AIError('invalid_response', providerId);
    if (!raw || typeof raw !== 'object') throw bad();
    const r = raw as { modelId?: unknown; output?: unknown; finishReason?: unknown };
    if (r.modelId !== modelId) throw bad();
    if (r.finishReason !== 'stop' && r.finishReason !== 'length') throw bad();
    const out = r.output as { type?: unknown; text?: unknown; value?: unknown } | undefined;
    if (!out || typeof out !== 'object' || typeof out.text !== 'string') throw bad();
    const wanted = prepared.request.responseFormat.type;
    if (out.type !== wanted) throw bad();
    const maxChars = prepared.request.maxOutputTokens * AI_REQUEST_LIMITS.charsPerToken;

    if (wanted === 'json') {
      // JSON cortado não é JSON: excede o limite → resposta inválida.
      if (out.text.length > maxChars || !isJsonValue(out.value)) throw bad();
      let parsed: unknown;
      try {
        parsed = JSON.parse(out.text);
      } catch {
        throw bad();
      }
      if (JSON.stringify(parsed) !== JSON.stringify(out.value)) throw bad();
      return { output: { type: 'json', text: out.text, value: out.value }, finishReason: r.finishReason, truncated: false };
    }
    const truncated = out.text.length > maxChars;
    return {
      output: { type: 'text', text: truncated ? out.text.slice(0, maxChars) : out.text },
      finishReason: truncated ? 'length' : r.finishReason,
      truncated,
    };
  }

  private usage(u: unknown): AIResponse['usage'] {
    if (!u || typeof u !== 'object') return undefined;
    const { inputTokens, outputTokens } = u as { inputTokens?: unknown; outputTokens?: unknown };
    const ok = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
    const out = { ...(ok(inputTokens) ? { inputTokens: inputTokens as number } : {}), ...(ok(outputTokens) ? { outputTokens: outputTokens as number } : {}) };
    return Object.keys(out).length ? out : undefined;
  }
}
