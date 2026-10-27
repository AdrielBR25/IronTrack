import type { ProviderId } from '../config.ts';
import { anthropicAdapter } from './anthropic.ts';
import { geminiAdapter } from './gemini.ts';
import { openaiAdapter } from './openai.ts';
import type { UpstreamAdapter } from './types.ts';

/** Adaptadores conhecidos. Não há fallback: cada solicitação vai só ao provedor escolhido. */
export const ADAPTERS: Record<ProviderId, UpstreamAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
};
