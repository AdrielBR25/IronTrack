// Contrato canônico de 1RM para as análises novas (IronTrack 2.0 F01/P09). Ver docs/ANALYTICS_TREINAMENTO.md §4.
// Não substitui as fórmulas antigas: `estimate1RM` (recordes) e o Epley inline de `exerciseSeries` (gráfico
// antigo da aba Treino) continuam iguais. O adaptador `legacyChartE1rm` só reproduz o gráfico antigo para
// comparação e testes; nada aqui muda números já exibidos.

/**
 * Libra internacional em kg (definição exata). É o mesmo valor de lib/units › KG_PER_LB (teste garante); fica
 * aqui para o domínio de analytics não depender de módulos de interface/unidade fora das regras de arquitetura.
 */
export const KG_PER_LB = 0.45359237;

/** Identificador do método. Uma tendência só junta estimativas com o mesmo id. */
export const E1RM_METHOD_ID = 'epley-1a12-v1';
/** Intervalo de repetições em que o método é aceito. Acima dele não há extrapolação. */
export const E1RM_MIN_REPS = 1;
export const E1RM_RANGE_MAX_REPS = 12;

export type E1rmMethodId = typeof E1RM_METHOD_ID;
export type LoadUnit = 'kg' | 'lb';

export interface E1rmMethod {
  id: E1rmMethodId;
  name: string;
  formula: string;
  minReps: number;
  maxReps: number;
  unit: 'kg';
}

export const E1RM_METHOD: E1rmMethod = {
  id: E1RM_METHOD_ID,
  name: 'Epley (1 a 12 repetições)',
  formula: '1 repetição: a própria carga · 2 a 12 repetições: carga × (1 + repetições ÷ 30)',
  minReps: E1RM_MIN_REPS,
  maxReps: E1RM_RANGE_MAX_REPS,
  unit: 'kg',
};

export type E1rmRejection = 'carga_invalida' | 'repeticoes_invalidas' | 'acima_do_intervalo';

export type E1rmResult =
  | {
      ok: true;
      /** kg, precisão completa (arredonde só para exibir). */
      valueKg: number;
      method: E1rmMethodId;
      /** `direta`: 1 repetição (a carga é o próprio 1RM); `estimada`: Epley. */
      kind: 'direta' | 'estimada';
      loadKg: number;
      reps: number;
    }
  | { ok: false; method: E1rmMethodId; reason: E1rmRejection };

/** Converte para kg sem arredondar (diferente de lib/units › fromDisplay, que arredonda para a interface). */
export function toKg(value: number, unit: LoadUnit): number {
  return unit === 'kg' ? value : value * KG_PER_LB;
}

export function fromKg(kg: number, unit: LoadUnit): number {
  return unit === 'kg' ? kg : kg / KG_PER_LB;
}

/**
 * 1RM canônico. Carga deve ser número finito > 0; repetições, inteiro de 1 a 12. Fora disso, devolve o motivo
 * em vez de um número (nunca 0, NaN ou uma extrapolação).
 */
export function canonicalE1rm(load: unknown, reps: unknown, unit: LoadUnit = 'kg'): E1rmResult {
  if (typeof load !== 'number' || !Number.isFinite(load) || load <= 0) return { ok: false, method: E1RM_METHOD_ID, reason: 'carga_invalida' };
  if (typeof reps !== 'number' || !Number.isInteger(reps) || reps < E1RM_MIN_REPS) return { ok: false, method: E1RM_METHOD_ID, reason: 'repeticoes_invalidas' };
  if (reps > E1RM_RANGE_MAX_REPS) return { ok: false, method: E1RM_METHOD_ID, reason: 'acima_do_intervalo' };
  const loadKg = toKg(load, unit);
  const direct = reps === 1;
  return { ok: true, valueKg: direct ? loadKg : loadKg * (1 + reps / 30), method: E1RM_METHOD_ID, kind: direct ? 'direta' : 'estimada', loadKg, reps };
}

/** Atalho: valor canônico em kg ou null. */
export function canonicalE1rmKg(load: unknown, reps: unknown, unit: LoadUnit = 'kg'): number | null {
  const r = canonicalE1rm(load, reps, unit);
  return r.ok ? r.valueKg : null;
}

/**
 * Adaptador de compatibilidade: reproduz exatamente o 1RM do gráfico antigo (`exerciseSeries`, aba Treino),
 * que aplica Epley a qualquer número de repetições, inclusive 1 (carga × 1,0333…). Só para comparação.
 */
export function legacyChartE1rm(load: number, reps: number): number {
  return load > 0 ? load * (1 + reps / 30) : 0;
}

export interface E1rmComparison {
  canonicalKg: number | null;
  legacyChartKg: number;
  /** legado − canônico (kg); null quando o canônico não se aplica. */
  diffKg: number | null;
  diffPct: number | null;
  reason?: E1rmRejection;
}

/** Diferença entre o gráfico antigo e o contrato canônico para uma série (documentação e testes). */
export function compareWithLegacyChart(loadKg: number, reps: number): E1rmComparison {
  const c = canonicalE1rm(loadKg, reps);
  const legacyChartKg = legacyChartE1rm(loadKg, reps);
  if (!c.ok) return { canonicalKg: null, legacyChartKg, diffKg: null, diffPct: null, reason: c.reason };
  return { canonicalKg: c.valueKg, legacyChartKg, diffKg: legacyChartKg - c.valueKg, diffPct: ((legacyChartKg - c.valueKg) / c.valueKg) * 100 };
}

export interface MethodTagged {
  method: string;
}

/** Garante que uma série de estimativas usa um único método (não mistura métodos numa tendência). */
export function sameMethodOnly<T extends MethodTagged>(items: readonly T[], method: string = E1RM_METHOD_ID): T[] {
  return items.filter((i) => i.method === method);
}
