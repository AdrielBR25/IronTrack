// Anthropic — Messages API (POST /v1/messages), conforme a referência oficial consultada em 2026-10-27:
// cabeçalhos `x-api-key` e `anthropic-version` (valor definido na configuração, ex.: 2026-10-21),
// corpo com `model`, `max_tokens` (obrigatório), `system` (campo próprio, não é mensagem) e
// `messages` com papéis `user`/`assistant`, começando por `user`. Não enviamos temperature/top_p/top_k
// (removidos na versão 2026-10-21). Resposta: blocos `content[]` (`type: "text"`), `stop_reason`
// (`end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`,
// `model_context_window_exceeded`) e `usage.input_tokens` / `usage.output_tokens`.
// Revisado em 2026-10-27 (P07, platform.claude.com "Handling stop reasons"): `refusal` chega como HTTP
// 200 (com `stop_details`), não como erro; blocos `thinking`/`redacted_thinking` não entram no texto;
// `max_tokens` com conteúdo vazio é cobrado e vira `invalid_response` com o uso informado.
// Hotfix 21.2 (referência revisada em 2026-10-31): `output_config.effort` e `thinking.type` por modelo, vindos só da
// configuração do servidor (Claude Haiku 5.5 aceita `disabled`; Claude Sonnet 5.5 recusa `disabled` e usa
// `between_tools`; em ambos o raciocínio conta no `max_tokens`). Erros classificados pelo status e por `error.type`
// (401 authentication_error, 402 billing_error, 403 permission_error, 404 not_found_error, 429 rate_limit_error).
// Diagnóstico sem custo: GET /v1/models/{id} (Models API) confirma a chave e se o modelo existe e está liberado.
import { GatewayError } from '../errors.ts';
import { getJson, isObj, postJson, upstreamStatusError, usageOf } from './http.ts';
import type { UpstreamAdapter, UpstreamRequest } from './types.ts';

/** A API exige alternância começando por `user`: mensagens seguidas do mesmo papel são unidas. */
export function toAnthropicMessages(messages: UpstreamRequest['messages']): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  if (out[0]?.role !== 'user') throw new GatewayError('request_invalid');
  return out;
}

export const anthropicAdapter: UpstreamAdapter = {
  id: 'anthropic',
  defaultBaseUrl: 'https://api.anthropic.com',
  async generate(req, ctx) {
    if (!ctx.apiVersion) throw new GatewayError('provider_unavailable');
    const body = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      ...(req.thinking ? { thinking: { type: req.thinking } } : {}),
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
      ...(req.system ? { system: req.system } : {}),
      messages: toAnthropicMessages(req.messages),
    };
    const { status, json } = await postJson(
      ctx.fetch,
      `${ctx.baseUrl}/v1/messages`,
      { 'x-api-key': ctx.apiKey, 'anthropic-version': ctx.apiVersion },
      body,
      ctx.signal,
      ctx.maxResponseBytes,
    );
    if (status < 200 || status >= 300) throw upstreamStatusError(status, json);
    if (!isObj(json) || !Array.isArray(json.content)) throw new GatewayError('invalid_response');
    const usage = isObj(json.usage) ? usageOf(json.usage.input_tokens, json.usage.output_tokens) : undefined;
    const text = json.content.map((b) => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
    let finishReason: 'stop' | 'length';
    switch (json.stop_reason) {
      case 'end_turn':
      case 'stop_sequence':
        finishReason = 'stop';
        break;
      case 'max_tokens':
      case 'model_context_window_exceeded':
        finishReason = 'length';
        break;
      case 'refusal':
        throw new GatewayError('content_filtered', usage);
      default:
        // tool_use / pause_turn: recursos não usados pelo IronTrack.
        throw new GatewayError('invalid_response', usage);
    }
    if (!text) throw new GatewayError('invalid_response', usage);
    return { text, finishReason, ...(usage ? { usage } : {}) };
  },
  async check(model, ctx) {
    if (!ctx.apiVersion) throw new GatewayError('provider_unavailable');
    const { status, json } = await getJson(ctx.fetch, `${ctx.baseUrl}/v1/models/${encodeURIComponent(model)}`, { 'x-api-key': ctx.apiKey, 'anthropic-version': ctx.apiVersion }, ctx.signal, ctx.maxResponseBytes);
    if (status < 200 || status >= 300) throw upstreamStatusError(status, json);
    if (!isObj(json) || json.id !== model) throw new GatewayError('invalid_response');
  },
};
