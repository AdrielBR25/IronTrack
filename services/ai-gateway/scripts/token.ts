// Emite uma credencial de acesso ao gateway FORA do cliente.
//   npm run gateway:token -- <id-do-titular>
// Mostra o token UMA vez (entregue ao titular por canal privado; nunca no repositório) e o trecho
// de configuração com o SHA-256, que é o único valor guardado no servidor.
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../src/auth.ts';

const id = process.argv[2] ?? 'dev';
if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) {
  process.stderr.write('ID inválido: use letras minúsculas, números, "-" ou "_".\n');
  process.exit(1);
}
const token = randomBytes(32).toString('base64url');
process.stdout.write(`Token (entregue ao titular; não será mostrado de novo):\n${token}\n\n`);
process.stdout.write(`Trecho para "clients" na configuração do gateway:\n${JSON.stringify({ id, tokenSha256: sha256Hex(token), enabled: true }, null, 2)}\n`);
