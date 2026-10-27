import type { Equipment, ProgressionPrefs, SessionSet } from './types';

// Progressão dupla: ao atingir o topo da faixa de repetições em todas as séries
// planejadas, com margem (RIR/RPE compatível), sugere-se um pequeno aumento de
// carga. A sugestão nunca é aplicada sem confirmação do usuário.

export type SuggestionKind = 'increase' | 'keep' | 'decrease' | 'none';

export interface ProgressionPlan {
  repMin: number;
  repMax: number;
  plannedSets: number;
  equipment: Equipment;
}

export interface Suggestion {
  kind: SuggestionKind;
  currentWeight: number | null;
  suggestedWeight: number | null;
  reason: string;
}

function workingSets(sets: SessionSet[]): SessionSet[] {
  return sets.filter((s) => s.status === 'done' && s.type === 'normal' && (s.reps ?? 0) > 0);
}

function roundTo(n: number, step: number) {
  if (step <= 0) return n;
  return Math.round(n / step) * step;
}

/**
 * @param last séries da última sessão do exercício
 * @param previous séries da sessão anterior à última (para detectar estagnação)
 */
export function suggestProgression(
  plan: ProgressionPlan,
  last: SessionSet[] | null,
  prefs: ProgressionPrefs,
  previous: SessionSet[] | null = null,
): Suggestion {
  const sets = last ? workingSets(last) : [];
  if (!sets.length) return { kind: 'none', currentWeight: null, suggestedWeight: null, reason: 'Sem histórico ainda. Registre este treino para receber sugestões.' };

  const top = sets.slice(0, plan.plannedSets);
  const weight = Math.min(...top.map((s) => s.weight ?? 0));
  const inc = prefs.increments[plan.equipment] ?? 2.5;

  if (top.length < plan.plannedSets) {
    return { kind: 'keep', currentWeight: weight, suggestedWeight: weight, reason: `Na última vez foram ${top.length} de ${plan.plannedSets} séries. Complete todas antes de subir a carga.` };
  }

  const allTop = top.every((s) => (s.reps ?? 0) >= plan.repMax);
  const marginOk = top.every((s) => (s.rir == null || s.rir >= prefs.minRir) && (s.rpe == null || s.rpe <= prefs.maxRpe));
  const anyBelow = top.some((s) => (s.reps ?? 0) < plan.repMin);

  if (allTop && marginOk) {
    const next = roundTo(weight + inc, inc >= 1 ? 0.5 : 0.25);
    return {
      kind: 'increase',
      currentWeight: weight,
      suggestedWeight: next,
      reason: `Você fez ${plan.plannedSets} × ${plan.repMax} com ${fmt(weight)} kg e margem adequada. Sugestão: +${fmt(inc)} kg.`,
    };
  }
  if (allTop && !marginOk) {
    return { kind: 'keep', currentWeight: weight, suggestedWeight: weight, reason: 'Topo da faixa atingido, mas perto da falha (RIR/RPE). Repita a carga buscando mais folga.' };
  }
  if (anyBelow) {
    const prevSets = previous ? workingSets(previous).slice(0, plan.plannedSets) : [];
    const prevBelow = prevSets.length > 0 && prevSets.some((s) => (s.reps ?? 0) < plan.repMin) && Math.min(...prevSets.map((s) => s.weight ?? 0)) <= weight;
    if (prevBelow && weight > 0) {
      const next = Math.max(0, roundTo(weight * 0.92, inc >= 1 ? 0.5 : 0.25));
      return { kind: 'decrease', currentWeight: weight, suggestedWeight: next, reason: `Duas sessões abaixo de ${plan.repMin} repetições. Considere reduzir para ${fmt(next)} kg e reconstruir.` };
    }
    return { kind: 'keep', currentWeight: weight, suggestedWeight: weight, reason: `Algumas séries ficaram abaixo de ${plan.repMin} repetições. Mantenha a carga e busque entrar na faixa.` };
  }
  return { kind: 'keep', currentWeight: weight, suggestedWeight: weight, reason: `Mantenha ${fmt(weight)} kg e busque +1 repetição até chegar a ${plan.repMax} em todas as séries.` };
}

function fmt(n: number) {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(n);
}
