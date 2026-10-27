// OpenAI — Responses API (POST /v1/responses), conforme a referência oficial consultada em 2026-10-27:
// `model`, `instructions` (sistema), `input` (mensagens com `role` e `content` texto),
// `max_output_tokens` (mínimo 16) e `store: false` (não guardar a resposta no provedor).
// Resposta: `status` (`completed` | `incomplete` | `failed`…), `incomplete_details.reason`
// (`max_output_tokens` | `content_filter`), itens `output[]` do tipo `message` com conteúdo
// `output_text` (`text`) ou `refusal`, e `usage.input_tokens` / `usage.output_tokens`.
import { GatewayError } from '../errors.ts';
import { isObj, postJson, upstreamStatusError, usageOf } from './http.ts';
import type { UpstreamAdapter } from './types.ts';

/** Mínimo aceito pela API para `max_output_tokens`. */
export const OPENAI_MIN_OUTPUT_TOKENS = 16;

export const openaiAdapter: UpstreamAdapter = {
  id: 'openai',
  defaultBaseUrl: 'https://api.openai.com',
  async generate(req, ctx) {
    const body = {
      model: req.model,
      ...(req.system ? { instructions: req.system } : {}),
      input: req.messages.map((m) => ({ role: m.role, content: m.content })),
      max_output_tokens: Math.max(OPENAI_MIN_OUTPUT_TOKENS, req.maxOutputTokens),
      store: false,
    };
    const { status, json } = await postJson(ctx.fetch, `${ctx.baseUrl}/v1/responses`, { authorization: `Bearer ${ctx.apiKey}` }, body, ctx.signal, ctx.maxResponseBytes);
    if (status < 200 || status >= 300) throw upstreamStatusError(status);
    if (!isObj(json) || !Array.isArray(json.output)) throw new GatewayError('invalid_response');

    let text = '';
    let refused = false;
    for (const item of json.output) {
      if (!isObj(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
      for (const c of item.content) {
        if (isObj(c) && c.type === 'output_text' && typeof c.text === 'string') text += c.text;
        else if (isObj(c) && c.type === 'refusal') refused = true;
      }
    }
    const reason = isObj(json.incomplete_details) ? json.incomplete_details.reason : undefined;
    if (refused || reason === 'content_filter') throw new GatewayError('content_filtered');
    let finishReason: 'stop' | 'length';
    if (json.status === 'completed') finishReason = 'stop';
    else if (json.status === 'incomplete' && reason === 'max_output_tokens') finishReason = 'length';
    else if (json.status === 'failed') throw new GatewayError('provider_failure');
    else throw new GatewayError('invalid_response');
    if (!text) throw new GatewayError('invalid_response');
    const usage = isObj(json.usage) ? usageOf(json.usage.input_tokens, json.usage.output_tokens) : undefined;
    return { text, finishReason, ...(usage ? { usage } : {}) };
  },
};
