// Núcleo de uma geração de texto (extraído de gateway.ts no Prompt 21 para ser reutilizado pela API com contas,
// services/api). Recebe uma solicitação JÁ autenticada e com formato validado e aplica, nesta ordem: allowlist de
// provedor e modelo → limites de entrada/saída → chave do provedor no servidor → simultaneidade (titular e total) →
// cota diária (reserva) → chamada com tempo limite, cancelamento e sem redirecionamentos → normalização → acerto da cota.
// Comportamento idêntico ao do gateway antes da extração (coberto pelos testes do gateway).
import { isProviderId, type GatewayConfig, type ProviderId } from './config.ts';
import { GatewayError, isGatewayError } from './errors.ts';
import { estimateTokens, utcDay, type UsageStore } from './limits.ts';
import type { LimitKind } from './metrics.ts';
import { inputChars, type GenerateRequest, type GenerateResponse } from './protocol.ts';
import { splitSystem, type FetchLike, type UpstreamAdapter } from './providers/types.ts';

/** Metadados preenchidos durante a geração (para log e métricas; nunca conteúdo). */
export interface GenerationLog {
  provider?: string;
  model?: string;
  limit?: LimitKind;
  inputTokens?: number;
  outputTokens?: number;
  usageSource?: 'reported' | 'estimated';
}

export interface GenerationDeps {
  store: UsageStore;
  adapters: Record<ProviderId, UpstreamAdapter>;
  fetch: FetchLike;
  now: () => number;
  /** Chamadas a provedores em andamento no processo (todas as contas/titulares). */
  upstream: { active: number };
}

export interface GenerationInput {
  config: GatewayConfig;
  body: GenerateRequest;
  /** Titular (gateway) ou conta (API) usado nos limites e na cota. */
  clientId: string;
  dailyBudget: number;
  maxConcurrent: number;
  signal: AbortSignal;
  /** Chave do provedor no servidor (nunca vem do cliente). */
  apiKeyFor: (id: ProviderId) => string | undefined;
  log: GenerationLog;
}

/** Corre `p` mas termina assim que o sinal abortar (mesmo se o adaptador ignorar o sinal). */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export async function runGeneration(deps: GenerationDeps, input: GenerationInput): Promise<GenerateResponse> {
  const { config: c, body, clientId, dailyBudget, maxConcurrent, signal, log } = input;
  if (!isProviderId(body.provider) || !c.providers[body.provider]?.enabled) throw new GatewayError('provider_not_allowed');
  const pid = body.provider;
  const pcfg = c.providers[pid]!;
  log.provider = pid;
  const model = pcfg.models.find((m) => m.id === body.model);
  if (!model) throw new GatewayError('model_not_allowed');
  log.model = model.id;
  const chars = inputChars(body.messages);
  if (chars > Math.min(c.limits.maxInputChars, model.maxInputChars)) throw new GatewayError('payload_too_large');
  if (body.maxOutputTokens > Math.min(c.limits.maxOutputTokens, model.maxOutputTokens)) throw new GatewayError('request_invalid');
  const apiKey = input.apiKeyFor(pid);
  if (!apiKey) throw new GatewayError('provider_unavailable');

  // Todos os limites são aplicados ANTES de qualquer chamada ao provedor pago.
  if (!(await deps.store.acquire(clientId, maxConcurrent))) {
    log.limit = 'concurrency_client';
    throw new GatewayError('rate_limited');
  }
  try {
    if (deps.upstream.active >= c.limits.maxConcurrentTotal) {
      log.limit = 'concurrency_total';
      throw new GatewayError('rate_limited');
    }
    deps.upstream.active++;
    try {
      const day = utcDay(deps.now());
      const reserved = estimateTokens(chars) + body.maxOutputTokens;
      if (!(await deps.store.reserve(clientId, day, reserved, dailyBudget))) {
        log.limit = 'daily_quota';
        throw new GatewayError('quota_exceeded');
      }
      if (signal.aborted) {
        await deps.store.settle(clientId, day, reserved, 0);
        throw signal.reason;
      }
      // Rastreia se a solicitação chegou a sair e o status devolvido, para acertar a reserva.
      let dispatched = false;
      let upstreamStatus: number | undefined;
      const tracked: FetchLike = async (url, init) => {
        if (init.signal.aborted) throw init.signal.reason;
        dispatched = true;
        const res = await deps.fetch(url, init);
        upstreamStatus = res.status;
        return res;
      };
      const adapter = deps.adapters[pid];
      try {
        const result = await raceAbort(
          adapter.generate(
            { model: model.id, ...splitSystem(body.messages), maxOutputTokens: body.maxOutputTokens, ...(model.effort ? { effort: model.effort } : {}), ...(model.thinking ? { thinking: model.thinking } : {}) },
            { apiKey, fetch: tracked, signal, baseUrl: pcfg.baseUrl ?? adapter.defaultBaseUrl, maxResponseBytes: c.limits.maxUpstreamResponseBytes, ...(pcfg.apiVersion ? { apiVersion: pcfg.apiVersion } : {}) },
          ),
          signal,
        );
        // Conferência final do formato devolvido pelo adaptador.
        if (!result || typeof result.text !== 'string' || (result.finishReason !== 'stop' && result.finishReason !== 'length')) throw new GatewayError('invalid_response');
        const maxChars = body.maxOutputTokens * 4;
        const cut = result.text.length > maxChars;
        const inTok = result.usage?.inputTokens ?? estimateTokens(chars);
        const outTok = result.usage?.outputTokens ?? estimateTokens(Math.min(result.text.length, maxChars));
        await deps.store.settle(clientId, day, reserved, inTok + outTok);
        log.inputTokens = inTok;
        log.outputTokens = outTok;
        log.usageSource = result.usage?.inputTokens !== undefined && result.usage?.outputTokens !== undefined ? 'reported' : 'estimated';
        return {
          provider: pid,
          model: model.id,
          output: { type: 'text', text: cut ? result.text.slice(0, maxChars) : result.text },
          finishReason: cut ? 'length' : result.finishReason,
          ...(result.usage ? { usage: { ...result.usage } } : {}),
        };
      } catch (e) {
        // Acerto da reserva em falhas:
        //  - a solicitação nem saiu (validação do adaptador, cancelamento antes do envio): devolve tudo;
        //  - o provedor respondeu 2xx mas recusou/veio inválido e informou uso: cobra o uso informado;
        //  - o provedor respondeu com erro HTTP (não cobra solicitações recusadas): devolve tudo;
        //  - tempo limite, cancelamento ou queda de rede DEPOIS do envio: mantém a reserva (o provedor
        //    pode ter gerado e cobrado a resposta inteira).
        const usage = isGatewayError(e) ? e.usage : undefined;
        let actual: number | null = null;
        if (!dispatched) actual = 0;
        else if (usage) {
          actual = (usage.inputTokens ?? estimateTokens(chars)) + (usage.outputTokens ?? 0);
          log.inputTokens = usage.inputTokens ?? estimateTokens(chars);
          log.outputTokens = usage.outputTokens ?? 0;
          log.usageSource = usage.inputTokens !== undefined && usage.outputTokens !== undefined ? 'reported' : 'estimated';
        } else if (upstreamStatus !== undefined && (upstreamStatus < 200 || upstreamStatus >= 300)) actual = 0;
        if (actual !== null) await deps.store.settle(clientId, day, reserved, actual);
        else {
          log.inputTokens = estimateTokens(chars);
          log.outputTokens = body.maxOutputTokens;
          log.usageSource = 'estimated';
        }
        throw e;
      }
    } finally {
      deps.upstream.active--;
    }
  } finally {
    await deps.store.release(clientId);
  }
}
