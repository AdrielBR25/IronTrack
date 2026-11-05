// OpenAI — Responses API (POST /v1/responses) com ferramentas (function calling) e streaming (SSE).
// Conferido na documentação oficial (developers.openai.com/api/docs) em 2026-11-05: a Responses API é a recomendada
// para integrações novas e a única com ferramentas nos modelos atuais; eventos `response.output_text.delta` (texto aos
// poucos) e `response.completed` (resposta final com `output[]` e `usage`); itens `function_call` ({ call_id, name,
// arguments }) voltam como `function_call_output` ({ call_id, output }); itens de raciocínio devolvidos junto com
// chamadas de ferramenta precisam ser reenviados com os resultados.
// Privacidade: `store: false` (o provedor não guarda a resposta para recuperação) e, como o histórico é mantido por nós,
// pedimos `reasoning.encrypted_content` para reenviar o raciocínio dentro do mesmo turno sem armazenamento no provedor.
// Nunca devolvemos nem registramos o corpo de erro do provedor (pode ecoar o prompt). Redirecionamento não é seguido.
import { GatewayError } from '../../../../ai-gateway/src/errors.ts';
import { getJson, isObj, upstreamStatusError } from '../../../../ai-gateway/src/providers/http.ts';
import type { ChatContext, ChatItem, ChatProvider, ChatRequest, ChatResult } from './types.ts';

const MIN_OUTPUT_TOKENS = 16;

function toInput(items: ChatItem[]): unknown[] {
  return items.map((it) => {
    switch (it.type) {
      case 'message':
        return { role: it.role, content: it.content };
      case 'tool_call':
        return it.raw ?? { type: 'function_call', call_id: it.callId, name: it.name, arguments: it.arguments };
      case 'tool_result':
        return { type: 'function_call_output', call_id: it.callId, output: it.output };
      case 'opaque':
        return it.raw;
    }
  });
}

export function buildOpenAiBody(req: ChatRequest): Record<string, unknown> {
  const reasoning = req.reasoningEffort && req.reasoningEffort !== 'none';
  return {
    model: req.model,
    instructions: req.instructions,
    input: toInput(req.input),
    ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })), tool_choice: 'auto' } : {}),
    max_output_tokens: Math.max(MIN_OUTPUT_TOKENS, req.maxOutputTokens),
    ...(req.reasoningEffort ? { reasoning: { effort: req.reasoningEffort } } : {}),
    ...(reasoning ? { include: ['reasoning.encrypted_content'] } : {}),
    store: false,
    stream: true,
  };
}

/** Lê o corpo SSE em eventos JSON, com limite total de bytes e cancelamento. */
async function* readSse(res: Response, maxBytes: number, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new GatewayError('invalid_response');
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        try {
          const ev = JSON.parse(data) as unknown;
          if (isObj(ev)) yield ev;
        } catch {
          throw new GatewayError('invalid_response');
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

/** Interpreta a resposta final (`response`) da Responses API. Exportado para testes. */
export function parseFinalResponse(resp: Record<string, unknown>, streamedText: string): ChatResult {
  const usage = isObj(resp.usage) ? { inputTokens: int(resp.usage.input_tokens), outputTokens: int(resp.usage.output_tokens) } : { inputTokens: 0, outputTokens: 0 };
  const output = Array.isArray(resp.output) ? resp.output : [];
  const toolCalls: ChatResult['toolCalls'] = [];
  const outputItems: ChatItem[] = [];
  let text = '';
  let refused = false;
  for (const item of output) {
    if (!isObj(item)) continue;
    if (item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
      const args = typeof item.arguments === 'string' ? item.arguments : '{}';
      toolCalls.push({ callId: item.call_id, name: item.name, arguments: args });
      outputItems.push({ type: 'tool_call', callId: item.call_id, name: item.name, arguments: args, raw: item });
      continue;
    }
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (isObj(c) && c.type === 'output_text' && typeof c.text === 'string') text += c.text;
        else if (isObj(c) && c.type === 'refusal') refused = true;
      }
    }
    outputItems.push({ type: 'opaque', raw: item });
  }
  const reason = isObj(resp.incomplete_details) ? resp.incomplete_details.reason : undefined;
  if (refused || reason === 'content_filter') throw new GatewayError('content_filtered', usage);
  if (resp.status === 'failed' || resp.status === 'cancelled') throw new GatewayError('provider_failure', usage);
  let finish: ChatResult['finish'];
  if (toolCalls.length) finish = 'tool_calls';
  else if (resp.status === 'incomplete' && reason === 'max_output_tokens') finish = 'length';
  else if (resp.status === 'completed') finish = 'stop';
  else throw new GatewayError('invalid_response', usage);
  if (!text) text = streamedText;
  if (!text && !toolCalls.length && finish !== 'length') throw new GatewayError('invalid_response', usage);
  return { text, toolCalls, outputItems, finish, usage };
}

export const openAiProvider: ChatProvider = {
  id: 'openai',
  defaultBaseUrl: 'https://api.openai.com',

  async stream(req: ChatRequest, ctx: ChatContext, onText) {
    let res: Response;
    try {
      res = await ctx.fetch(`${ctx.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${ctx.apiKey}` },
        body: JSON.stringify(buildOpenAiBody(req)),
        signal: ctx.signal,
        redirect: 'manual',
      });
    } catch {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      throw new GatewayError('provider_unreachable');
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      res.body?.cancel().catch(() => {});
      throw new GatewayError('provider_failure');
    }
    if (res.status < 200 || res.status >= 300) {
      // O corpo só é lido para classificar a causa (nunca repassado nem registrado).
      let json: unknown;
      try {
        json = JSON.parse((await res.text()).slice(0, 65_536));
      } catch {
        json = undefined;
      }
      throw upstreamStatusError(res.status, json);
    }
    let streamed = '';
    let final: Record<string, unknown> | null = null;
    try {
      for await (const ev of readSse(res, ctx.maxResponseBytes, ctx.signal)) {
        const t = ev.type;
        if (t === 'response.output_text.delta' && typeof ev.delta === 'string') {
          streamed += ev.delta;
          onText(ev.delta);
        } else if ((t === 'response.completed' || t === 'response.incomplete' || t === 'response.failed') && isObj(ev.response)) {
          final = ev.response;
        } else if (t === 'error') {
          const code = isObj(ev.error) ? ev.error.code : ev.code;
          throw code === 'rate_limit_exceeded' ? new GatewayError('provider_rate_limited') : new GatewayError('provider_failure');
        }
      }
    } catch (e) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      throw e instanceof GatewayError ? e : new GatewayError('provider_failure');
    }
    if (!final) throw new GatewayError('invalid_response');
    return parseFinalResponse(final, streamed);
  },

  async check(model, ctx) {
    // GET /v1/models/{model}: sem custo (nenhum token gerado). 401 = chave recusada; 404 = modelo inexistente/não liberado.
    const { status } = await getJson(ctx.fetch, `${ctx.baseUrl}/v1/models/${encodeURIComponent(model)}`, { authorization: `Bearer ${ctx.apiKey}` }, ctx.signal, 65_536);
    if (status < 200 || status >= 300) throw upstreamStatusError(status);
  },
};
