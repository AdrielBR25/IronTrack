// Categorias de contexto, finalidades e consentimento por solicitação (puros).
// Regra geral: na dúvida, negar. Política completa em docs/IA_ARQUITETURA.md, seções 6 a 8.

/** Categorias de dados que podem, com autorização, compor o contexto enviado a um provedor. */
export const AI_CONTEXT_CATEGORIES = [
  'training_summary',
  'training_history',
  'body_measurements',
  'body_evolution',
  'profile_preferences',
  /** P20: metas de treino (título, tipo, alvo, progresso calculado e prazo). */
  'training_goals',
  'progress_photos',
] as const;
export type AIContextCategory = (typeof AI_CONTEXT_CATEGORIES)[number];

/**
 * Categorias bloqueadas nesta versão, mesmo com consentimento: fotos nunca entram no contexto
 * textual (nem como data URL) e nenhum modelo recebe imagens.
 */
export const BLOCKED_CATEGORIES: readonly AIContextCategory[] = ['progress_photos'];

export const isContextCategory = (v: unknown): v is AIContextCategory => typeof v === 'string' && (AI_CONTEXT_CATEGORIES as readonly string[]).includes(v);
export const isBlockedCategory = (c: AIContextCategory) => BLOCKED_CATEGORIES.includes(c);

/** Finalidades declaradas. Uma finalidade desconhecida é negada. */
export const AI_PURPOSES = ['training_review', 'body_review', 'general_question'] as const;
export type AIPurpose = (typeof AI_PURPOSES)[number];
export const isPurpose = (v: unknown): v is AIPurpose => typeof v === 'string' && (AI_PURPOSES as readonly string[]).includes(v);

/** Validade padrão e máxima de uma autorização. Ela vale para uma única solicitação. */
export const DEFAULT_CONSENT_TTL_MS = 5 * 60_000;
export const MAX_CONSENT_TTL_MS = 15 * 60_000;

/**
 * Autorização explícita do usuário para UMA solicitação: destino (provedor e modelo), finalidade,
 * categorias e escopo (a solicitação exata, pela assinatura do conteúdo). Fica só na memória:
 * nunca é gravada no IndexedDB, no localStorage nem no backup.
 */
export interface AIConsent {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly purpose: AIPurpose;
  /** Categorias autorizadas. Nenhuma outra categoria fica implícita. */
  readonly categories: readonly AIContextCategory[];
  readonly scope: {
    /** Solicitação preparada a que esta autorização se refere. */
    readonly requestId: string;
    /** SHA-256 do destino, da finalidade, das categorias e das mensagens exatas. */
    readonly binding: string;
  };
  /** Momento da autorização (ms). */
  readonly grantedAt: number;
  readonly expiresAt: number;
}

/** O que a solicitação efetiva vai fazer, comparado com a autorização. */
export interface ConsentTarget {
  requestId: string;
  providerId: string;
  modelId: string;
  purpose: AIPurpose;
  categories: readonly AIContextCategory[];
  binding: string;
}

export type ConsentDenialReason =
  | 'missing'
  | 'malformed'
  | 'provider_mismatch'
  | 'model_mismatch'
  | 'purpose_mismatch'
  | 'unknown_category'
  | 'blocked_category'
  | 'category_mismatch'
  | 'scope_mismatch'
  | 'not_yet_valid'
  | 'expired';

export type ConsentDecision = { allowed: true } | { allowed: false; reason: ConsentDenialReason };

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Confere a autorização contra a solicitação efetiva. Qualquer divergência nega. */
export function evaluateConsent(consent: unknown, target: ConsentTarget, now: number): ConsentDecision {
  const deny = (reason: ConsentDenialReason): ConsentDecision => ({ allowed: false, reason });
  if (consent === undefined || consent === null) return deny('missing');
  if (!isObj(consent) || !isObj(consent.scope)) return deny('malformed');
  const c = consent;
  const scope = consent.scope;
  if (![c.id, c.providerId, c.modelId, scope.requestId, scope.binding].every(isStr) || !isNum(c.grantedAt) || !isNum(c.expiresAt) || !Array.isArray(c.categories))
    return deny('malformed');
  if (!isPurpose(c.purpose)) return deny('malformed');
  if (!c.categories.every(isContextCategory)) return deny('unknown_category');
  const granted = c.categories as AIContextCategory[];
  if (granted.some(isBlockedCategory)) return deny('blocked_category');
  if (c.providerId !== target.providerId) return deny('provider_mismatch');
  if (c.modelId !== target.modelId) return deny('model_mismatch');
  if (c.purpose !== target.purpose) return deny('purpose_mismatch');
  // Igualdade exata de conjuntos: autorizar mais do que se pede também é negado, para que uma
  // autorização ampla não seja reaproveitada em pedidos menores sem o usuário ver.
  const want = new Set(target.categories);
  const have = new Set(granted);
  if (want.size !== have.size || [...want].some((x) => !have.has(x))) return deny('category_mismatch');
  if (scope.requestId !== target.requestId || scope.binding !== target.binding) return deny('scope_mismatch');
  if (now < c.grantedAt) return deny('not_yet_valid');
  if (now >= c.expiresAt || c.expiresAt - c.grantedAt > MAX_CONSENT_TTL_MS) return deny('expired');
  return { allowed: true };
}
