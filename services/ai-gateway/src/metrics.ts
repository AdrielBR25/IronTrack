// Métricas operacionais mínimas, SEM dados pessoais: contagens, códigos de erro, duração, provedor,
// modelo, uso de tokens (informado pelo provedor ou estimado) e limites atingidos. Ficam só na memória do
// processo (zeradas ao reiniciar), não são expostas por HTTP e nunca são enviadas a terceiros. Não há
// titular, keyId, IP, prompt, resposta ou cabeçalho aqui: só agregados.
import type { GatewayErrorCode } from './errors.ts';

export type LimitKind = 'requests_per_minute' | 'concurrency_client' | 'concurrency_total' | 'daily_quota';

/** O que as métricas recebem de cada requisição (subconjunto do evento de log). */
export interface MetricInput {
  route: string;
  status: number;
  code?: GatewayErrorCode;
  provider?: string;
  model?: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  usageSource?: 'reported' | 'estimated';
  limit?: LimitKind;
}

interface ModelStats {
  requests: number;
  ok: number;
  errors: number;
  durationMsTotal: number;
  durationMsMax: number;
  reportedInputTokens: number;
  reportedOutputTokens: number;
  estimatedTokens: number;
}

export interface MetricsSnapshot {
  since: string;
  requests: number;
  byRoute: Record<string, number>;
  byStatus: Record<string, number>;
  errorsByCode: Partial<Record<GatewayErrorCode, number>>;
  limitsHit: Partial<Record<LimitKind, number>>;
  byModel: Record<string, ModelStats>;
}

/** Rótulos de rota conhecidos; qualquer outro caminho vira "outra" (não guardamos URLs arbitrárias). */
const ROUTES = new Set(['GET /v1/models', 'POST /v1/generate', 'OPTIONS /v1/models', 'OPTIONS /v1/generate']);

export class GatewayMetrics {
  private readonly since: number;
  private requests = 0;
  private readonly byStatus = new Map<string, number>();
  private readonly errors = new Map<GatewayErrorCode, number>();
  private readonly limits = new Map<LimitKind, number>();
  private readonly models = new Map<string, ModelStats>();
  private readonly routes = new Map<string, number>();

  constructor(now: number = Date.now()) {
    this.since = now;
  }

  record(e: MetricInput): void {
    const inc = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);
    this.requests++;
    inc(this.byStatus, String(e.status));
    inc(this.routes, ROUTES.has(e.route) ? e.route : 'outra');
    if (e.code) inc(this.errors, e.code);
    if (e.limit) inc(this.limits, e.limit);
    if (!e.provider || !e.model) return;
    const key = `${e.provider}/${e.model}`;
    const s = this.models.get(key) ?? { requests: 0, ok: 0, errors: 0, durationMsTotal: 0, durationMsMax: 0, reportedInputTokens: 0, reportedOutputTokens: 0, estimatedTokens: 0 };
    s.requests++;
    if (e.status === 200) s.ok++;
    else s.errors++;
    s.durationMsTotal += e.durationMs;
    s.durationMsMax = Math.max(s.durationMsMax, e.durationMs);
    const tokens = (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
    if (e.usageSource === 'reported') {
      s.reportedInputTokens += e.inputTokens ?? 0;
      s.reportedOutputTokens += e.outputTokens ?? 0;
    } else if (e.usageSource === 'estimated') s.estimatedTokens += tokens;
    this.models.set(key, s);
  }

  snapshot(): MetricsSnapshot {
    return {
      since: new Date(this.since).toISOString(),
      requests: this.requests,
      byRoute: Object.fromEntries(this.routes),
      byStatus: Object.fromEntries(this.byStatus),
      errorsByCode: Object.fromEntries(this.errors) as MetricsSnapshot['errorsByCode'],
      limitsHit: Object.fromEntries(this.limits) as MetricsSnapshot['limitsHit'],
      byModel: Object.fromEntries([...this.models].map(([k, v]) => [k, { ...v }])),
    };
  }
}
