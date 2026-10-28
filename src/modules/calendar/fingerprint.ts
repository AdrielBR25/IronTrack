// Impressão digital dos conflitos (IronTrack 2.0 F01/P16, docs/DECISOES_CALENDARIO.md §3–4). Hash síncrono de 64 bits
// (dois FNV-1a de 32 bits com sementes diferentes) sobre partes já canônicas. Só compara estados; não é segurança.
export function fingerprintOf(parts: readonly string[]): string {
  const s = parts.join('\u001f');
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
