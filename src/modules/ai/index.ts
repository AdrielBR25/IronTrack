// API pública do módulo de IA (IronTrack 2.0 F01/P04): contratos de provedor, registro,
// consentimento por solicitação, construção de contexto e serviço central.
// Sem React, sem Dexie e sem rede. Nenhum provedor real existe ainda; os adaptadores
// (src/modules/ai/adapters) não são exportados daqui: só uma futura raiz de composição os registra.
// Fora deste diretório, importe sempre por '@/modules/ai'. Ver docs/IA_ARQUITETURA.md.
export type * from './domain/types';
export type * from './domain/contracts';
export * from './domain/errors';
export * from './domain/permissions';
export * from './application/ProviderRegistry';
export * from './application/ContextBuilder';
export * from './application/AIService';
