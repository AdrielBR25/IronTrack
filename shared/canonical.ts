// JSON canônico e hash, compartilhados pelo app e pela API (Prompt 21). A importação compara o que o aparelho enviou
// com o que o PostgreSQL devolveu pelo hash deste texto; os dois lados PRECISAM usar exatamente esta função.
// Regras: chaves de objeto em ordem; propriedades `undefined` omitidas (como JSON.stringify); arrays na ordem;
// números como JSON.stringify (NaN/Infinity não existem em registros válidos e viram null, também como JSON).

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined || typeof v === 'function' ? 'null' : canonicalJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined && typeof obj[k] !== 'function')
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** SHA-256 em hexadecimal (Web Crypto: navegador e Node 22). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Hash do conteúdo canônico de um registro. */
export const recordHash = (doc: unknown): Promise<string> => sha256Hex(canonicalJson(doc));

/** Igualdade estrutural pelo JSON canônico. */
export const sameContent = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
