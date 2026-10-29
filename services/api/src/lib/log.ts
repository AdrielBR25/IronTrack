// Log estruturado (stdout, uma linha JSON por evento). Só metadados: rota (modelo, nunca o caminho digitado),
// status, duração, código de erro e o ID pseudônimo da conta. Nunca e-mail, senha, token, cookie, corpo, IP,
// DATABASE_URL ou chave de provedor.
export interface AccessEvent {
  ts: string;
  id: string;
  method: string;
  route: string;
  status: number;
  ms: number;
  code?: string;
  user?: string;
}

export type Logger = { access(e: AccessEvent): void; event(name: string, data?: Record<string, string | number | boolean>): void; error(where: string, e: unknown): void };

export function createLogger(enabled = true, write: (s: string) => void = (s) => process.stdout.write(s)): Logger {
  return {
    access: (e) => enabled && write(`${JSON.stringify({ type: 'access', ...e })}\n`),
    event: (name, data = {}) => write(`${JSON.stringify({ type: 'event', ts: new Date().toISOString(), name, ...data })}\n`),
    // Só o nome e o código do erro: mensagens de driver podem conter trechos de SQL ou valores.
    error: (where, e) =>
      write(`${JSON.stringify({ type: 'error', ts: new Date().toISOString(), where, name: e instanceof Error ? e.name : typeof e, code: e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined })}\n`),
  };
}

export const silentLogger: Logger = { access: () => {}, event: () => {}, error: () => {} };
