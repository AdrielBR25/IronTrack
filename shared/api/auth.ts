// Regras de conta compartilhadas (Prompt 21): normalização de e-mail, política de senha e formatos de entrada.
// O app usa para o indicador de requisitos; a API aplica de verdade (o cliente nunca é confiável).
import { z } from 'zod';

export const PASSWORD_MIN = 10;
/** Teto: Argon2 com entradas enormes vira negação de serviço. */
export const PASSWORD_MAX = 128;
export const NAME_MAX = 60;
export const EMAIL_MAX = 254;

/** E-mail normalizado: sem espaços nas pontas e em minúsculas (o domínio já é case-insensitive; a parte local na prática também). */
export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

const EMAIL_RE = /^[^\s@"<>()[\],;:\\]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const isValidEmail = (e: string): boolean => e.length <= EMAIL_MAX && EMAIL_RE.test(e);

/** Senhas comuns demais (lista curta; a regra principal é o tamanho). */
const COMMON = ['1234567890', '12345678910', 'senha12345', 'password123', 'qwerty12345', 'irontrack123', '0123456789', 'abcdefghij1', 'senhasenha1'];

export interface PasswordRequirement {
  id: 'length' | 'letter' | 'number' | 'not_email' | 'not_common' | 'max';
  label: string;
  ok: boolean;
}

export function passwordRequirements(password: string, email = ''): PasswordRequirement[] {
  const p = password;
  const local = normalizeEmail(email).split('@')[0] ?? '';
  return [
    { id: 'length', label: `Pelo menos ${PASSWORD_MIN} caracteres`, ok: p.length >= PASSWORD_MIN },
    { id: 'letter', label: 'Pelo menos uma letra', ok: /\p{L}/u.test(p) },
    { id: 'number', label: 'Pelo menos um número', ok: /\p{N}/u.test(p) },
    { id: 'not_email', label: 'Diferente do seu e-mail', ok: !p || !local || (p.toLowerCase() !== local && p.toLowerCase() !== normalizeEmail(email)) },
    { id: 'not_common', label: 'Não é uma senha comum', ok: !COMMON.includes(p.toLowerCase()) },
    { id: 'max', label: `No máximo ${PASSWORD_MAX} caracteres`, ok: p.length <= PASSWORD_MAX },
  ];
}

export const isStrongPassword = (password: string, email = ''): boolean => passwordRequirements(password, email).every((r) => r.ok);

export const normalizeName = (raw: string): string => raw.replace(/\s+/g, ' ').trim();

const nameSchema = z
  .string()
  .transform(normalizeName)
  .refine((s) => s.length >= 1 && s.length <= NAME_MAX, 'name');
const emailSchema = z
  .string()
  .max(EMAIL_MAX + 10)
  .transform(normalizeEmail)
  .refine(isValidEmail, 'email');
const passwordSchema = z.string().min(1).max(PASSWORD_MAX * 4);

export const signupSchema = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema, acceptTerms: z.literal(true) }).strict();
export const loginSchema = z.object({ email: emailSchema, password: passwordSchema }).strict();
export const forgotSchema = z.object({ email: emailSchema }).strict();
export const resetSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema }).strict();
export const verifySchema = z.object({ token: z.string().min(20).max(200) }).strict();
export const changePasswordSchema = z.object({ currentPassword: passwordSchema, newPassword: passwordSchema }).strict();
export const updateProfileSchema = z.object({ name: nameSchema }).strict();
export const deleteAccountSchema = z.object({ password: passwordSchema, confirm: z.literal('EXCLUIR') }).strict();

/** Conta como o app a vê (`GET /api/v1/me`). Nunca inclui hash, tokens ou dados de outras contas. */
export interface AccountInfo {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  /** Perfil de dados da conta (mesmo ID em todos os aparelhos). */
  dataProfileId: string;
  createdAt: string;
}

export interface ServerFeatures {
  /** Há provedor de e-mail configurado (verificação e recuperação funcionam). */
  email: boolean;
  /** Algum provedor de IA com chave configurada. */
  ai: boolean;
  /** A IA exige e-mail verificado. */
  aiRequiresVerifiedEmail: boolean;
  signup: boolean;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** Descrição curta do navegador (derivada do user-agent, sem versão completa). */
  device: string;
}
