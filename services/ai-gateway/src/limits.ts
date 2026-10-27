// Limites de uso por credencial: requisições por minuto, solicitações simultâneas e cota diária de
// tokens (reservada antes da chamada e ajustada pelo consumo real depois).
//
// IMPORTANTE: `MemoryUsageStore` vale só para UMA instância do gateway (desenvolvimento). Com várias
// instâncias (ou reinícios frequentes), cada uma teria contadores próprios e os limites seriam
// multiplicados ou zerados. Uma implantação distribuída precisa de um `UsageStore` com armazenamento
// compartilhado e operações atômicas (ex.: Redis/KV com INCR e expiração). Ver docs/IA_GATEWAY.md.

export interface UsageStore {
  /** Conta uma requisição na janela de 1 minuto e devolve o total da janela. */
  hit(clientId: string, now: number): Promise<number>;
  /** Tenta reservar `amount` tokens da cota do dia; false se ultrapassaria `budget`. */
  reserve(clientId: string, day: string, amount: number, budget: number): Promise<boolean>;
  /** Troca a reserva pelo consumo real (pode devolver tokens). */
  settle(clientId: string, day: string, reserved: number, actual: number): Promise<void>;
  /** Controle de simultaneidade: false se já há `max` em andamento. */
  acquire(clientId: string, max: number): Promise<boolean>;
  release(clientId: string): Promise<void>;
}

export const WINDOW_MS = 60_000;

export class MemoryUsageStore implements UsageStore {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly used = new Map<string, number>();
  private readonly inFlight = new Map<string, number>();

  async hit(clientId: string, now: number): Promise<number> {
    const w = this.windows.get(clientId);
    if (!w || now - w.start >= WINDOW_MS) {
      this.windows.set(clientId, { start: now, count: 1 });
      return 1;
    }
    w.count++;
    return w.count;
  }

  async reserve(clientId: string, day: string, amount: number, budget: number): Promise<boolean> {
    const key = `${clientId}|${day}`;
    const cur = this.used.get(key) ?? 0;
    if (cur + amount > budget) return false;
    this.used.set(key, cur + amount);
    // Só o dia corrente importa: descarta dias anteriores.
    for (const k of this.used.keys()) if (k.startsWith(`${clientId}|`) && k !== key) this.used.delete(k);
    return true;
  }

  async settle(clientId: string, day: string, reserved: number, actual: number): Promise<void> {
    const key = `${clientId}|${day}`;
    this.used.set(key, Math.max(0, (this.used.get(key) ?? 0) - reserved + actual));
  }

  async acquire(clientId: string, max: number): Promise<boolean> {
    const n = this.inFlight.get(clientId) ?? 0;
    if (n >= max) return false;
    this.inFlight.set(clientId, n + 1);
    return true;
  }

  async release(clientId: string): Promise<void> {
    const n = (this.inFlight.get(clientId) ?? 1) - 1;
    if (n <= 0) this.inFlight.delete(clientId);
    else this.inFlight.set(clientId, n);
  }

  /** Uso do dia (para testes e diagnóstico; não exposto por HTTP). */
  usage(clientId: string, day: string): number {
    return this.used.get(`${clientId}|${day}`) ?? 0;
  }
}

/** Dia UTC (yyyy-mm-dd) da cota. */
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Estimativa conservadora de tokens de entrada sem tokenizador: ~4 caracteres por token. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);
