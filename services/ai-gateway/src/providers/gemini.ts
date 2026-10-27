// Google Gemini — models.generateContent (POST /v1beta/models/{model}:generateContent), conforme a
// referência oficial consultada em 2026-10-27: chave no cabeçalho `x-goog-api-key` (nunca na URL),
// `systemInstruction` (só texto), `contents[]` com papéis `user`/`model` e `parts[].text`, e
// `generationConfig.maxOutputTokens`. Resposta: `candidates[].content.parts[].text`,
// `candidates[].finishReason` (`STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`…),
// `promptFeedback.blockReason` e `usageMetadata.promptTokenCount` / `candidatesTokenCount`.
// Partes marcadas como raciocínio (`thought: true`) não entram no texto.
import { GatewayError } from '../errors.ts';
import { isObj, postJson, upstreamStatusError, usageOf } from './http.ts';
import type { UpstreamAdapter } from './types.ts';

const BLOCKED = new Set(['SAFETY', 'RECITATION', 'LANGUAGE', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

export const geminiAdapter: UpstreamAdapter = {
  id: 'gemini',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  async generate(req, ctx) {
    const body = {
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: req.maxOutputTokens },
    };
    // O ID já passou pela allowlist e pela expressão do config (sem "/"); ainda assim é codificado.
    const url = `${ctx.baseUrl}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`;
    const { status, json } = await postJson(ctx.fetch, url, { 'x-goog-api-key': ctx.apiKey }, body, ctx.signal, ctx.maxResponseBytes);
    if (status < 200 || status >= 300) throw upstreamStatusError(status);
    if (!isObj(json)) throw new GatewayError('invalid_response');
    if (isObj(json.promptFeedback) && typeof json.promptFeedback.blockReason === 'string') throw new GatewayError('content_filtered');
    const cand = Array.isArray(json.candidates) ? json.candidates[0] : undefined;
    if (!isObj(cand)) throw new GatewayError('invalid_response');
    const reason = cand.finishReason;
    if (typeof reason === 'string' && BLOCKED.has(reason)) throw new GatewayError('content_filtered');
    let finishReason: 'stop' | 'length';
    if (reason === 'STOP') finishReason = 'stop';
    else if (reason === 'MAX_TOKENS') finishReason = 'length';
    else throw new GatewayError('invalid_response');
    const parts = isObj(cand.content) && Array.isArray(cand.content.parts) ? cand.content.parts : [];
    const text = parts.map((p) => (isObj(p) && p.thought !== true && typeof p.text === 'string' ? p.text : '')).join('');
    if (!text) throw new GatewayError('invalid_response');
    const usage = isObj(json.usageMetadata) ? usageOf(json.usageMetadata.promptTokenCount, json.usageMetadata.candidatesTokenCount) : undefined;
    return { text, finishReason, ...(usage ? { usage } : {}) };
  },
};
