// Contratos dos provedores (P07): respostas simuladas realistas, conferidas com a documentação oficial
// consultada em 2026-10-27, incluindo respostas parciais, vazias, recusas, raciocínio, redirecionamentos,
// queda no meio do corpo e uso informado em respostas cobradas mas inaproveitáveis. Rede sempre simulada.
import { describe, expect, it } from 'vitest';
import { GatewayError } from '../src/errors.ts';
import { anthropicAdapter } from '../src/providers/anthropic.ts';
import { geminiAdapter } from '../src/providers/gemini.ts';
import { openaiAdapter } from '../src/providers/openai.ts';
import type { FetchLike, UpstreamAdapter, UpstreamContext, UpstreamRequest } from '../src/providers/types.ts';
import { json } from './helpers.ts';

const REQ: UpstreamRequest = { model: 'modelo-x.1', system: 'Sistema.', messages: [{ role: 'user', content: 'Pergunta' }], maxOutputTokens: 64 };
const ctx = (f: FetchLike, over: Partial<UpstreamContext> = {}): UpstreamContext => ({
  apiKey: 'chave-de-teste-123456',
  fetch: f,
  signal: new AbortController().signal,
  baseUrl: 'https://provedor.test',
  maxResponseBytes: 64 * 1024,
  apiVersion: '2026-10-21',
  ...over,
});
const reply = (body: unknown, status = 200): FetchLike => async () => json(status, body);
async function outcome(p: Promise<unknown>) {
  try {
    return { ok: true as const, value: await p };
  } catch (e) {
    if (!(e instanceof GatewayError)) throw e;
    return { ok: false as const, code: e.code, usage: e.usage };
  }
}

describe('OpenAI Responses — contrato', () => {
  const base = { id: 'resp_x', object: 'response', model: 'modelo-x.1' };

  it('resposta completa de modelo de raciocínio: ignora item reasoning, soma texto e informa uso', async () => {
    const r = await openaiAdapter.generate(
      REQ,
      ctx(
        reply({
          ...base,
          status: 'completed',
          output: [
            { type: 'reasoning', id: 'rs_1', summary: [] },
            { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Parte 1. ', annotations: [] }, { type: 'output_text', text: 'Parte 2.', annotations: [] }] },
          ],
          usage: { input_tokens: 21, output_tokens: 80, output_tokens_details: { reasoning_tokens: 64 }, total_tokens: 101 },
        }),
      ),
    );
    expect(r).toEqual({ text: 'Parte 1. Parte 2.', finishReason: 'stop', usage: { inputTokens: 21, outputTokens: 80 } });
  });

  it('resposta parcial (incomplete/max_output_tokens com texto) → length', async () => {
    const r = await openaiAdapter.generate(REQ, ctx(reply({ ...base, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Começo da resp' }] }], usage: { input_tokens: 5, output_tokens: 64 } })));
    expect(r.finishReason).toBe('length');
    expect(r.text).toBe('Começo da resp');
  });

  it('limite gasto só no raciocínio (sem item message): invalid_response COM o uso cobrado', async () => {
    const o = await outcome(openaiAdapter.generate(REQ, ctx(reply({ ...base, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning', summary: [] }], usage: { input_tokens: 30, output_tokens: 64, output_tokens_details: { reasoning_tokens: 64 } } }))));
    expect(o).toEqual({ ok: false, code: 'invalid_response', usage: { inputTokens: 30, outputTokens: 64 } });
  });

  it('recusa (item refusal) → content_filtered com uso', async () => {
    const o = await outcome(openaiAdapter.generate(REQ, ctx(reply({ ...base, status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Não posso ajudar.' }] }], usage: { input_tokens: 9, output_tokens: 4 } }))));
    expect(o).toMatchObject({ ok: false, code: 'content_filtered', usage: { inputTokens: 9, outputTokens: 4 } });
  });

  it('status cancelled/failed → provider_failure; queued/in_progress → invalid_response; vazia → invalid_response', async () => {
    expect(await outcome(openaiAdapter.generate(REQ, ctx(reply({ ...base, status: 'cancelled', output: [] }))))).toMatchObject({ code: 'provider_failure' });
    expect(await outcome(openaiAdapter.generate(REQ, ctx(reply({ ...base, status: 'in_progress', output: [] }))))).toMatchObject({ code: 'invalid_response' });
    expect(await outcome(openaiAdapter.generate(REQ, ctx(reply({ ...base, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '' }] }] }))))).toMatchObject({ code: 'invalid_response' });
  });

  it('erro de autenticação realista (401 invalid_api_key) não repassa a mensagem', async () => {
    const o = await outcome(openaiAdapter.generate(REQ, ctx(reply({ error: { message: 'Incorrect API key provided: sk-...abcd', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401))));
    expect(o).toEqual({ ok: false, code: 'provider_auth_failed', usage: undefined });
  });

  it('429 insufficient_quota / rate_limit_exceeded → provider_rate_limited', async () => {
    for (const c of ['rate_limit_exceeded', 'insufficient_quota']) expect(await outcome(openaiAdapter.generate(REQ, ctx(reply({ error: { code: c } }, 429))))).toMatchObject({ code: 'provider_rate_limited' });
  });
});

describe('Anthropic Messages — contrato', () => {
  const base = { id: 'msg_x', type: 'message', role: 'assistant', model: 'modelo-x.1' };

  it('blocos thinking/redacted_thinking não entram no texto; uso informado', async () => {
    const r = await anthropicAdapter.generate(
      REQ,
      ctx(reply({ ...base, content: [{ type: 'thinking', thinking: 'raciocínio interno', signature: 'sig' }, { type: 'redacted_thinking', data: 'xx' }, { type: 'text', text: 'Resposta final.' }], stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 12, output_tokens: 30, cache_read_input_tokens: 0 } })),
    );
    expect(r).toEqual({ text: 'Resposta final.', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 30 } });
  });

  it('recusa chega como HTTP 200 com stop_reason refusal e stop_details → content_filtered com uso', async () => {
    const o = await outcome(anthropicAdapter.generate(REQ, ctx(reply({ ...base, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'x' }, usage: { input_tokens: 10, output_tokens: 2 } }))));
    expect(o).toEqual({ ok: false, code: 'content_filtered', usage: { inputTokens: 10, outputTokens: 2 } });
  });

  it('parcial (max_tokens com texto) → length; max_tokens sem texto → invalid_response com uso', async () => {
    const r = await anthropicAdapter.generate(REQ, ctx(reply({ ...base, content: [{ type: 'text', text: 'Meia resp' }], stop_reason: 'max_tokens', usage: { input_tokens: 3, output_tokens: 64 } })));
    expect(r.finishReason).toBe('length');
    const o = await outcome(anthropicAdapter.generate(REQ, ctx(reply({ ...base, content: [{ type: 'thinking', thinking: '...' }], stop_reason: 'max_tokens', usage: { input_tokens: 3, output_tokens: 64 } }))));
    expect(o).toEqual({ ok: false, code: 'invalid_response', usage: { inputTokens: 3, outputTokens: 64 } });
  });

  it('end_turn vazio (caso documentado de resposta vazia) → invalid_response', async () => {
    expect(await outcome(anthropicAdapter.generate(REQ, ctx(reply({ ...base, content: [], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }))))).toMatchObject({ code: 'invalid_response' });
  });

  it('erros realistas: 401 authentication_error, 429 rate_limit_error, 529 overloaded_error', async () => {
    const err = (type: string) => ({ type: 'error', error: { type, message: 'detalhe' } });
    expect(await outcome(anthropicAdapter.generate(REQ, ctx(reply(err('authentication_error'), 401))))).toMatchObject({ code: 'provider_auth_failed' });
    expect(await outcome(anthropicAdapter.generate(REQ, ctx(reply(err('rate_limit_error'), 429))))).toMatchObject({ code: 'provider_rate_limited' });
    expect(await outcome(anthropicAdapter.generate(REQ, ctx(reply(err('overloaded_error'), 529))))).toMatchObject({ code: 'provider_failure' });
  });
});

describe('Gemini generateContent — contrato', () => {
  it('uso de saída = candidatos + raciocínio (thoughtsTokenCount é cobrado como saída)', async () => {
    const r = await geminiAdapter.generate(
      REQ,
      ctx(reply({ candidates: [{ content: { role: 'model', parts: [{ text: 'pensando', thought: true }, { text: 'Resposta.' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5, thoughtsTokenCount: 40, totalTokenCount: 56 }, modelVersion: 'modelo-x.1' })),
    );
    expect(r).toEqual({ text: 'Resposta.', finishReason: 'stop', usage: { inputTokens: 11, outputTokens: 45 } });
  });

  it('limite gasto no raciocínio (MAX_TOKENS sem partes) → invalid_response com uso', async () => {
    const o = await outcome(geminiAdapter.generate(REQ, ctx(reply({ candidates: [{ content: { role: 'model' }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 11, thoughtsTokenCount: 64, totalTokenCount: 75 } }))));
    expect(o).toEqual({ ok: false, code: 'invalid_response', usage: { inputTokens: 11, outputTokens: 64 } });
  });

  it('parcial: MAX_TOKENS e CONTINUATION com texto → length', async () => {
    for (const finishReason of ['MAX_TOKENS', 'CONTINUATION']) {
      const r = await geminiAdapter.generate(REQ, ctx(reply({ candidates: [{ content: { parts: [{ text: 'Parte' }] }, finishReason }] })));
      expect(r.finishReason, finishReason).toBe('length');
    }
  });

  it('bloqueios (prompt e candidato, incl. novos motivos) → content_filtered; PUP_LIMITED_DISABLED → provider_unavailable', async () => {
    expect(await outcome(geminiAdapter.generate(REQ, ctx(reply({ promptFeedback: { blockReason: 'OTHER' }, usageMetadata: { promptTokenCount: 4 } }))))).toMatchObject({ code: 'content_filtered', usage: { inputTokens: 4 } });
    for (const reason of ['SAFETY', 'PROHIBITED_CONTENT', 'SPII', 'ESCALATION', 'IMAGE_SAFETY']) expect(await outcome(geminiAdapter.generate(REQ, ctx(reply({ candidates: [{ finishReason: reason }] })))), reason).toMatchObject({ code: 'content_filtered' });
    expect(await outcome(geminiAdapter.generate(REQ, ctx(reply({ candidates: [{ finishReason: 'PUP_LIMITED_DISABLED' }] }))))).toMatchObject({ code: 'provider_unavailable' });
  });

  it('motivos inesperados (OTHER, MALFORMED_RESPONSE, UNEXPECTED_TOOL_CALL) e sem candidatos → invalid_response', async () => {
    for (const reason of ['OTHER', 'MALFORMED_RESPONSE', 'UNEXPECTED_TOOL_CALL']) expect(await outcome(geminiAdapter.generate(REQ, ctx(reply({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: reason }] })))), reason).toMatchObject({ code: 'invalid_response' });
    expect(await outcome(geminiAdapter.generate(REQ, ctx(reply({ candidates: [] }))))).toMatchObject({ code: 'invalid_response' });
  });

  it('erros realistas: 400 API_KEY_INVALID → provider_failure; 403 PERMISSION_DENIED → provider_forbidden; 429 RESOURCE_EXHAUSTED → provider_rate_limited', async () => {
    const err = (code: number, status: string) => ({ error: { code, message: 'detalhe', status } });
    // O Gemini devolve chave inválida como 400 INVALID_ARGUMENT: sem ler o corpo, vira falha do provedor.
    expect(await outcome(geminiAdapter.generate(REQ, ctx(reply(err(400, 'INVALID_ARGUMENT'), 400))))).toMatchObject({ code: 'provider_failure' });
    expect(await outcome(geminiAdapter.generate(REQ, ctx(reply(err(403, 'PERMISSION_DENIED'), 403))))).toMatchObject({ code: 'provider_forbidden' });
    expect(await outcome(geminiAdapter.generate(REQ, ctx(reply(err(429, 'RESOURCE_EXHAUSTED'), 429))))).toMatchObject({ code: 'provider_rate_limited' });
  });
});

describe('comum aos três — transporte', () => {
  const all: UpstreamAdapter[] = [openaiAdapter, anthropicAdapter, geminiAdapter];

  it.each(all.map((a) => [a.id, a] as const))('%s: pede redirect "manual" e recusa qualquer 3xx sem ler o corpo', async (_id, a) => {
    for (const status of [301, 302, 303, 307, 308]) {
      let init: Parameters<FetchLike>[1] | undefined;
      const f: FetchLike = async (_u, i) => {
        init = i;
        return new Response(null, { status, headers: { location: 'https://evil.example/coleta' } });
      };
      expect(await outcome(a.generate(REQ, ctx(f))), String(status)).toMatchObject({ code: 'provider_failure' });
      expect(init?.redirect).toBe('manual');
    }
  });

  it.each(all.map((a) => [a.id, a] as const))('%s: conexão cai no meio do corpo → provider_failure', async (_id, a) => {
    const f: FetchLike = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"status":"completed","output":[{"type":"mess'));
          c.error(new TypeError('terminated'));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
    };
    expect(await outcome(a.generate(REQ, ctx(f)))).toMatchObject({ code: 'provider_failure' });
  });

  it.each(all.map((a) => [a.id, a] as const))('%s: content-length acima do limite é recusado antes de ler', async (_id, a) => {
    // Corpo que nunca termina: se o adaptador tentasse lê-lo, o teste ficaria preso.
    const f: FetchLike = async () => new Response(new ReadableStream({}), { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } });
    expect(await outcome(a.generate(REQ, ctx(f, { maxResponseBytes: 1024 })))).toMatchObject({ code: 'invalid_response' });
  });
});
