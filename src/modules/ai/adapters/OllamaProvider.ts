// Contrato para modelos LOCAIS via Ollama (IronTrack 2.0 F01/P06) — preparado, NÃO registrado na
// interface. Regras: o endereço é sempre digitado pelo usuário (sem padrão ativo, sem descoberta na
// rede, sem varredura de portas) e só loopback é aceito nesta etapa. Uma página HTTPS (GitHub Pages)
// chamando http://localhost esbarra em conteúdo misto, CORS (OLLAMA_ORIGINS) e nas regras de acesso
// à rede privada dos navegadores; servidores em OUTROS aparelhos ficam fora até haver HTTPS e
// confirmação explícita do destino. Ver docs/IA_GATEWAY.md, seção 11.
// Formato da API (POST /api/chat, stream:false): `model`, `messages[{role, content}]`,
// `options.num_predict`; resposta `message.content`, `done_reason` (`stop` | `length`),
// `prompt_eval_count`, `eval_count`.
import type { AIProvider } from '../domain/contracts';
import { AIError } from '../domain/errors';
import type { AIModelInfo, AIProviderResult, AIRequest, AIRequestOptions } from '../domain/types';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export type LocalEndpointCheck = { ok: true; origin: string } | { ok: false; reason: 'empty' | 'malformed' | 'not_loopback' | 'credentials' | 'path' };

/** Valida um endereço digitado pelo usuário. Nada é contatado aqui. */
export function validateLocalEndpoint(input: string): LocalEndpointCheck {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { ok: false, reason: 'empty' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'malformed' };
  if (u.username || u.password) return { ok: false, reason: 'credentials' };
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return { ok: false, reason: 'path' };
  if (!LOOPBACK.has(u.hostname)) return { ok: false, reason: 'not_loopback' };
  return { ok: true, origin: u.origin };
}

export type LocalTransport = (req: { path: '/api/chat'; body: unknown; signal?: AbortSignal }) => Promise<{ status: number; body: unknown }>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface OllamaProviderOptions {
  /** Endereço validado por `validateLocalEndpoint` (digitado pelo usuário). */
  origin: string;
  transport: LocalTransport;
  /** Modelos escolhidos explicitamente pelo usuário. */
  models: AIModelInfo[];
}

export class OllamaProvider implements AIProvider {
  readonly id = 'ollama';
  readonly displayName = 'Ollama (local)';
  readonly kind = 'local' as const;
  readonly models: readonly AIModelInfo[];
  readonly destination: string;
  private readonly transport: LocalTransport;

  constructor(opts: OllamaProviderOptions) {
    const check = validateLocalEndpoint(opts.origin);
    if (!check.ok) throw new AIError('provider_invalid');
    this.destination = `${check.origin} (servidor local)`;
    this.transport = opts.transport;
    this.models = opts.models;
  }

  async generate(request: AIRequest, options: AIRequestOptions = {}): Promise<AIProviderResult> {
    if (options.signal?.aborted) throw new AIError('cancelled', this.id);
    if (request.responseFormat.type !== 'text') throw new AIError('capability_unsupported', this.id);
    const body = {
      model: request.modelId,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      options: { num_predict: request.maxOutputTokens },
    };
    const res = await this.transport({ path: '/api/chat', body, signal: options.signal });
    if (res.status === 404) throw new AIError('model_unsupported', this.id);
    if (res.status !== 200) throw new AIError('provider_failure', this.id);
    const b = res.body;
    if (!isObj(b) || !isObj(b.message) || typeof b.message.content !== 'string' || !b.message.content) throw new AIError('invalid_response', this.id);
    const finishReason = b.done_reason === 'length' ? 'length' : b.done_reason === 'stop' || b.done_reason === undefined ? 'stop' : null;
    if (!finishReason) throw new AIError('invalid_response', this.id);
    const ok = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
    const usage = { ...(ok(b.prompt_eval_count) ? { inputTokens: b.prompt_eval_count } : {}), ...(ok(b.eval_count) ? { outputTokens: b.eval_count } : {}) };
    return { modelId: request.modelId, output: { type: 'text', text: b.message.content }, finishReason, ...(Object.keys(usage).length ? { usage } : {}) };
  }
}
