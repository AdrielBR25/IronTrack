// Google Gemini — models.generateContent (POST /v1beta/models/{model}:generateContent), conforme a
// referência oficial consultada em 2026-10-27: chave no cabeçalho `x-goog-api-key` (nunca na URL),
// `systemInstruction` (só texto), `contents[]` com papéis `user`/`model` e `parts[].text`, e
// `generationConfig.maxOutputTokens`. Resposta: `candidates[].content.parts[].text`,
// `candidates[].finishReason` (`STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`…),
// `promptFeedback.blockReason` e `usageMetadata.promptTokenCount` / `candidatesTokenCount`.
// Partes marcadas como raciocínio (`thought: true`) não entram no texto.
// Revisado em 2026-10-27 (P07): `usageMetadata.thoughtsTokenCount` (raciocínio) vem SEPARADO de
// `candidatesTokenCount` e é cobrado como saída, então o uso de saída = candidatos + raciocínio. Em modelos
// com raciocínio, `maxOutputTokens` também limita o raciocínio: o limite pode acabar sem texto
// (`MAX_TOKENS` sem partes) → `invalid_response` com o uso informado. Enum `FinishReason` conferido na
// referência (STOP, MAX_TOKENS, SAFETY, RECITATION, LANGUAGE, OTHER, BLOCKLIST, PROHIBITED_CONTENT, SPII,
// IMAGE_*, MALFORMED_*, ESCALATION, PUP_LIMITED_DISABLED, CONTINUATION…).
import { GatewayError } from '../errors.ts';
import { isObj, postJson, upstreamStatusError, usageOf } from './http.ts';
import type { UpstreamAdapter } from './types.ts';

const BLOCKED = new Set(['SAFETY', 'RECITATION', 'LANGUAGE', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'ESCALATION']);

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
    const um = json.usageMetadata;
    const usage = isObj(um) ? usageOf(um.promptTokenCount, um.candidatesTokenCount, um.thoughtsTokenCount) : undefined;
    if (isObj(json.promptFeedback) && typeof json.promptFeedback.blockReason === 'string') throw new GatewayError('content_filtered', usage);
    const cand = Array.isArray(json.candidates) ? json.candidates[0] : undefined;
    if (!isObj(cand)) throw new GatewayError('invalid_response', usage);
    const reason = cand.finishReason;
    if (typeof reason === 'string' && BLOCKED.has(reason)) throw new GatewayError('content_filtered', usage);
    // Conta limitada/desativada por violação de política no provedor: indisponível, não é falha transitória.
    if (reason === 'PUP_LIMITED_DISABLED') throw new GatewayError('provider_unavailable', usage);
    let finishReason: 'stop' | 'length';
    if (reason === 'STOP') finishReason = 'stop';
    // CONTINUATION: limite por solicitação atingido com resposta incompleta (não continuamos).
    else if (reason === 'MAX_TOKENS' || reason === 'CONTINUATION') finishReason = 'length';
    else throw new GatewayError('invalid_response', usage);
    const parts = isObj(cand.content) && Array.isArray(cand.content.parts) ? cand.content.parts : [];
    const text = parts.map((p) => (isObj(p) && p.thought !== true && typeof p.text === 'string' ? p.text : '')).join('');
    if (!text) throw new GatewayError('invalid_response', usage);
    return { text, finishReason, ...(usage ? { usage } : {}) };
  },
};
