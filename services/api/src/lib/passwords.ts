// Hash de senhas com Argon2id (@node-rs/argon2). Parâmetros: recomendação mínima da OWASP (19 MiB, t=2, p=1),
// adequada a um contêiner pequeno do Railway (~50 ms por hash). O hash guarda os parâmetros: aumentar depois não
// invalida senhas existentes (`needsRehash` regrava no próximo login).
import { hash, verify } from '@node-rs/argon2';

/** `algorithm: 2` = Algorithm.Argon2id (enum constante do pacote, não importável com verbatimModuleSyntax). */
export const ARGON2_PARAMS = { algorithm: 2 as const, memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export const hashPassword = (password: string): Promise<string> => hash(password, ARGON2_PARAMS);

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

export const needsRehash = (stored: string): boolean => !stored.startsWith(`$argon2id$v=19$m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}$`);

/** Hash fixo usado quando o e-mail não existe: o login leva o mesmo tempo (sem enumeração por tempo de resposta). */
let dummy: Promise<string> | null = null;
export const dummyHash = (): Promise<string> => (dummy ??= hashPassword('irontrack-dummy-password-0000'));
