// Adaptadores do gateway: mapeamento de mensagens e modelos, respostas textuais, erros, cancelamento,
// limite de saída e recursos não suportados. A rede é sempre simulada.
import { describe, expect, it } from 'vitest';
import { GatewayError } from '../src/errors.ts';
import { anthropicAdapter, toAnthropicMessages } from '../src/providers/anthropic.ts';
import { geminiAdapter } from '../src/providers/gemini.ts';
import { OPENAI_MIN_OUTPUT_TOKENS, openaiAdapter } from '../src/providers/openai.ts';
import { splitSystem, type FetchLike, type UpstreamAdapter, type UpstreamContext, type UpstreamRequest } from '../src/providers/types.ts';
import { hang, json, openaiOk } from './helpers.ts';

const REQ: UpstreamRequest = {
  model: 'modelo-x.1',
  system: 'Sistema fixo.',
  messages: [
    { role: 'user', content: 'Primeira' },
    { role: 'assistant', content: 'Resposta anterior' },
    { role: 'user', content: 'Pergunta atual' },
  ],
  maxOutputTokens: 300,
};

function capture(res: () => Response | Promise<Response>) {
  const calls: { url: string; init: Parameters<FetchLike>[1]; body: Record<string, unknown> }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return res();
  };
  return { calls, f };
}

const ctx = (f: FetchLike, over: Partial<UpstreamContext> = {}): UpstreamContext => ({
  apiKey: 'chave-de-teste-123456',
  fetch: f,
  signal: new AbortController().signal,
  baseUrl: 'https://provedor.test',
  maxResponseBytes: 64 * 1024,
  apiVersion: '2026-10-21',
  ...over,
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof GatewayError ? e.code : `outro:${String(e)}`;
  }
};

describe('splitSystem', () => {
  it('separa a primeira mensagem de sistema', () => {
    expect(splitSystem([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }])).toEqual({ system: 's', messages: [{ role: 'user', content: 'u' }] });
    expect(splitSystem([{ role: 'user', content: 'u' }])).toEqual({ messages: [{ role: 'user', content: 'u' }] });
  });
});

describe('OpenAI (Responses API)', () => {
  it('mapeia mensagens, modelo, instrução, limite de saída e store:false', async () => {
    const { calls, f } = capture(() => json(200, openaiOk('Olá')));
    const r = await openaiAdapter.generate(REQ, ctx(f));
    expect(r).toEqual({ text: 'Olá', finishReason: 'stop', usage: { inputTokens: 40, outputTokens: 8 } });
    expect(calls[0].url).toBe('https://provedor.test/v1/responses');
    expect(calls[0].init.headers.authorization).toBe('Bearer chave-de-teste-123456');
    expect(calls[0].body).toEqual({
      model: 'modelo-x.1',
      instructions: 'Sistema fixo.',
      input: [
        { role: 'user', content: 'Primeira' },
        { role: 'assistant', content: 'Resposta anterior' },
        { role: 'user', content: 'Pergunta atual' },
      ],
      max_output_tokens: 300,
      store: false,
    });
  });

  it('respeita o mínimo de max_output_tokens da API', async () => {
    const { calls, f } = capture(() => json(200, openaiOk()));
    await openaiAdapter.generate({ ...REQ, maxOutputTokens: 4 }, ctx(f));
    expect(calls[0].body.max_output_tokens).toBe(OPENAI_MIN_OUTPUT_TOKENS);
  });

  it('incompleto por limite → length; filtro/recusa → content_filtered; failed → provider_failure', async () => {
    const inc = { ...openaiOk('parcial'), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
    expect((await openaiAdapter.generate(REQ, ctx(capture(() => json(200, inc)).f))).finishReason).toBe('length');
    expect(await code(openaiAdapter.generate(REQ, ctx(capture(() => json(200, { ...inc, incomplete_details: { reason: 'content_filter' } })).f)))).toBe('content_filtered');
    const refusal = { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'não' }] }] };
    expect(await code(openaiAdapter.generate(REQ, ctx(capture(() => json(200, refusal)).f)))).toBe('content_filtered');
    expect(await code(openaiAdapter.generate(REQ, ctx(capture(() => json(200, { status: 'failed', output: [] })).f)))).toBe('provider_failure');
    expect(await code(openaiAdapter.generate(REQ, ctx(capture(() => json(200, { status: 'queued', output: [] })).f)))).toBe('invalid_response');
  });

  it('ignora itens que não são mensagem (ex.: raciocínio) e junta os textos', async () => {
    const body = { status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'A' }, { type: 'output_text', text: 'B' }] }] };
    expect((await openaiAdapter.generate(REQ, ctx(capture(() => json(200, body)).f))).text).toBe('AB');
  });
});

describe('Anthropic (Messages API)', () => {
  it('mapeia system em campo próprio, max_tokens, versão e cabeçalhos', async () => {
    const { calls, f } = capture(() => json(200, { type: 'message', content: [{ type: 'text', text: 'Oi' }, { type: 'text', text: '!' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 } }));
    const r = await anthropicAdapter.generate(REQ, ctx(f));
    expect(r).toEqual({ text: 'Oi!', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 3 } });
    expect(calls[0].url).toBe('https://provedor.test/v1/messages');
    expect(calls[0].init.headers['x-api-key']).toBe('chave-de-teste-123456');
    expect(calls[0].init.headers['anthropic-version']).toBe('2026-10-21');
    expect(calls[0].init.headers.authorization).toBeUndefined();
    expect(calls[0].body).toEqual({ model: 'modelo-x.1', max_tokens: 300, system: 'Sistema fixo.', messages: REQ.messages });
    expect(calls[0].body).not.toHaveProperty('temperature');
  });

  it('une papéis repetidos e exige começar por user', () => {
    expect(toAnthropicMessages([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }])).toEqual([{ role: 'user', content: 'a\n\nb' }]);
    expect(() => toAnthropicMessages([{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }])).toThrow(GatewayError);
  });

  it('stop_reason: max_tokens → length; refusal → content_filtered; tool_use (não suportado) → invalid_response', async () => {
    const r = (stop_reason: string) => anthropicAdapter.generate(REQ, ctx(capture(() => json(200, { content: [{ type: 'text', text: 'x' }], stop_reason })).f));
    expect((await r('max_tokens')).finishReason).toBe('length');
    expect((await r('model_context_window_exceeded')).finishReason).toBe('length');
    expect(await code(r('refusal'))).toBe('content_filtered');
    expect(await code(r('tool_use'))).toBe('invalid_response');
    expect(await code(r('pause_turn'))).toBe('invalid_response');
  });

  it('sem versão de API configurada: provider_unavailable', async () => {
    expect(await code(anthropicAdapter.generate(REQ, ctx(capture(() => json(200, {})).f, { apiVersion: undefined })))).toBe('provider_unavailable');
  });
});

describe('Gemini (generateContent)', () => {
  it('mapeia systemInstruction, papéis user/model, maxOutputTokens, modelo na rota e chave no cabeçalho', async () => {
    const { calls, f } = capture(() =>
      json(200, { candidates: [{ content: { role: 'model', parts: [{ text: 'pensando', thought: true }, { text: 'Resposta' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } }),
    );
    const r = await geminiAdapter.generate(REQ, ctx(f));
    expect(r).toEqual({ text: 'Resposta', finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 5 } });
    expect(calls[0].url).toBe('https://provedor.test/v1beta/models/modelo-x.1:generateContent');
    expect(calls[0].init.headers['x-goog-api-key']).toBe('chave-de-teste-123456');
    expect(calls[0].body).toEqual({
      systemInstruction: { parts: [{ text: 'Sistema fixo.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Primeira' }] },
        { role: 'model', parts: [{ text: 'Resposta anterior' }] },
        { role: 'user', parts: [{ text: 'Pergunta atual' }] },
      ],
      generationConfig: { maxOutputTokens: 300 },
    });
  });

  it('ID de modelo é codificado na rota', async () => {
    const { calls, f } = capture(() => json(200, { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] }));
    await geminiAdapter.generate({ ...REQ, model: 'a/../b' }, ctx(f));
    expect(calls[0].url).toBe('https://provedor.test/v1beta/models/a%2F..%2Fb:generateContent');
  });

  it('MAX_TOKENS → length; SAFETY e blockReason → content_filtered; sem candidato → invalid_response', async () => {
    const r = (body: unknown) => geminiAdapter.generate(REQ, ctx(capture(() => json(200, body)).f));
    expect((await r({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] })).finishReason).toBe('length');
    expect(await code(r({ candidates: [{ finishReason: 'SAFETY' }] }))).toBe('content_filtered');
    expect(await code(r({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }))).toBe('content_filtered');
    expect(await code(r({ candidates: [] }))).toBe('invalid_response');
    expect(await code(r({ candidates: [{ content: { parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] }))).toBe('invalid_response');
  });
});

describe('comum aos três adaptadores', () => {
  const all: UpstreamAdapter[] = [openaiAdapter, anthropicAdapter, geminiAdapter];

  it('endereços oficiais fixos (https) e sem chave na URL', () => {
    expect(all.map((a) => a.defaultBaseUrl)).toEqual(['https://api.openai.com', 'https://api.anthropic.com', 'https://generativelanguage.googleapis.com']);
  });

  it.each(all.map((a) => [a.id, a] as const))('%s: erros HTTP normalizados sem repetir', async (_id, a) => {
    for (const [status, want] of [
      [401, 'provider_unavailable'],
      [403, 'provider_unavailable'],
      [400, 'provider_failure'],
      [404, 'provider_failure'],
      [413, 'payload_too_large'],
      [429, 'provider_failure'],
      [500, 'provider_failure'],
      [529, 'provider_failure'],
    ] as const) {
      const { calls, f } = capture(() => json(status, { error: { message: 'segredo do provedor' } }));
      expect(await code(a.generate(REQ, ctx(f))), `${status}`).toBe(want);
      expect(calls).toHaveLength(1);
    }
  });

  it.each(all.map((a) => [a.id, a] as const))('%s: cancelamento repassa o motivo do sinal', async (_id, a) => {
    const ctrl = new AbortController();
    const p = a.generate(REQ, ctx(hang, { signal: ctrl.signal }));
    ctrl.abort(new GatewayError('cancelled'));
    expect(await code(p)).toBe('cancelled');
  });

  it.each(all.map((a) => [a.id, a] as const))('%s: resposta acima do limite de bytes → invalid_response', async (_id, a) => {
    const { f } = capture(() => json(200, openaiOk('x'.repeat(10_000))));
    expect(await code(a.generate(REQ, ctx(f, { maxResponseBytes: 1_000 })))).toBe('invalid_response');
  });

  it.each(all.map((a) => [a.id, a] as const))('%s: corpo não JSON → invalid_response', async (_id, a) => {
    const { f } = capture(() => new Response('<html>', { status: 200 }));
    expect(await code(a.generate(REQ, ctx(f)))).toBe('invalid_response');
  });

  it.each(all.map((a) => [a.id, a] as const))('%s: falha de rede → provider_failure', async (_id, a) => {
    expect(
      await code(
        a.generate(
          REQ,
          ctx(async () => {
            throw new TypeError('fetch failed');
          }),
        ),
      ),
    ).toBe('provider_failure');
  });
});
