// Tokens opacos e hashes. Tokens (sessão, verificação, recuperação) têm 256 bits aleatórios e só o SHA-256 vai para
// o banco: um vazamento do banco não entrega sessões nem links válidos.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

export const newToken = (): string => randomBytes(32).toString('base64url');
export const tokenHash = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();
export const uuid = (): string => randomUUID();
/** Chave de limite derivada de um valor pessoal (IP, e-mail) sem guardá-lo em texto puro. */
export const keyedHash = (secret: string, value: string): string => createHmac('sha256', secret).update(value).digest('base64url').slice(0, 32);
