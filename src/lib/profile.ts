import type { LocalProfile } from './types';

// Regras puras do perfil local (sem acesso ao banco). Modelo em docs/PERFIL_LOCAL.md.

export const DEFAULT_PROFILE_NAME = 'Meu perfil';
export const PROFILE_NAME_MAX = 40;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** IDs de perfil são UUID v4 em minúsculas. */
export function isValidProfileId(v: unknown): v is string {
  return typeof v === 'string' && UUID_V4.test(v);
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

/**
 * Gera um ID de perfil aleatório. Usa crypto.randomUUID quando existe e, senão,
 * crypto.getRandomValues (disponível em todos os navegadores suportados, mesmo fora de
 * contexto seguro). Sem fonte criptográfica, falha em vez de gerar um ID fraco.
 */
export function generateProfileId(c: Pick<Crypto, 'getRandomValues'> & { randomUUID?: () => string } | undefined = globalThis.crypto): string {
  if (c && typeof c.randomUUID === 'function') {
    const id = c.randomUUID().toLowerCase();
    if (isValidProfileId(id)) return id;
  }
  if (!c || typeof c.getRandomValues !== 'function') throw new ProfileError('Este navegador não oferece um gerador de números aleatórios seguro para criar o perfil local.');
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function newDefaultProfile(id: string, now: number): LocalProfile {
  return { id, displayName: DEFAULT_PROFILE_NAME, createdAt: now, updatedAt: now, isDefault: true };
}

/** Normaliza o nome digitado; devolve null se for inválido. */
export function normalizeProfileName(name: string): string | null {
  const t = name.replace(/\s+/g, ' ').trim();
  if (!t || t.length > PROFILE_NAME_MAX) return null;
  return t;
}

/**
 * Escolhe o perfil principal de forma determinística: o marcado como principal mais antigo
 * (desempate pelo ID). Nunca apaga nem renomeia perfis; duplicidades são só informadas.
 */
export function pickDefaultProfile(profiles: LocalProfile[]): LocalProfile | undefined {
  const valid = profiles.filter((p) => isValidProfileId(p?.id));
  const order = (a: LocalProfile, b: LocalProfile) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id);
  return valid.filter((p) => p.isDefault === true).sort(order)[0];
}

/** Forma abreviada do ID para exibição. */
export const shortProfileId = (id: string) => id.slice(0, 8);
