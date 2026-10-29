// Textos e ícones do calendário unificado (IronTrack 2.0 F01/P14). Estado sempre em texto (nunca só cor) e origem
// sempre dita: planejamento explícito, sugestão da agenda anterior e previsão da rotação nunca se confundem.
import { CalendarClock, Check, Circle, CircleDot, Coffee, Minus, Moon, Play, type LucideIcon } from 'lucide-react';
import { entryText, type Certainty, type ResolvedEntry, type RotationForecast, type UnifiedDayStatus } from '@/modules/calendar';

export const STATUS_ICON: Record<UnifiedDayStatus, LucideIcon> = {
  done: Check,
  trained: Check,
  partial: CircleDot,
  in_progress: Play,
  planned: Circle,
  suggested: CalendarClock,
  rest: Moon,
  free: Coffee,
  not_recorded: Minus,
  empty: Minus,
};

export const STATUS_SHORT: Record<UnifiedDayStatus, string> = {
  done: 'Concluído',
  trained: 'Treinou',
  partial: 'Parcial',
  in_progress: 'Em andamento',
  planned: 'Planejado',
  suggested: 'Sugestão',
  rest: 'Descanso',
  free: 'Livre',
  not_recorded: 'Sem registro',
  empty: '—',
};

export const ORIGIN_LABEL: Record<ResolvedEntry['origin'], string> = {
  session: 'Sessão registrada',
  active_session: 'Treino em andamento',
  plan_exception: 'Planejamento só deste dia (exceção)',
  plan_recurring: 'Planejamento semanal',
  legacy_override: 'Agenda anterior · reagendamento',
  legacy_rotation: 'Agenda anterior · dia de treino',
  legacy_off: 'Agenda anterior · não é dia de treino',
};

/** Quando a informação pode mudar (mostrado junto de previsões). */
export const CERTAINTY_HINT: Partial<Record<Certainty, string>> = {
  current: 'Próximo da rotação agora. Muda se você concluir outro treino desta rotina antes, pular ou corrigir a sequência.',
  forecast: 'Previsão baseada na rotação atual. Pode mudar se você treinar em outro dia, pular, trocar o treino, não concluir ou alterar a agenda.',
  undetermined: 'Treino a definir pela rotação.',
  suggestion: 'Sugestão da agenda anterior (dias de treino das Configurações). Não conta como planejado.',
};

/** Texto curto da previsão de uma atividade que segue a rotação. */
export function forecastText(f: RotationForecast | undefined): string {
  if (!f || f.certainty === 'undetermined' || !f.workoutLabel) return 'treino a definir pela rotação';
  const w = `Treino ${f.workoutLabel}`;
  if (f.certainty === 'fact') return w;
  if (f.certainty === 'current') return `${w} (próximo da rotação agora)`;
  return `${w} (previsão)`;
}

/** Linha completa de uma entrada resolvida, com a previsão identificada como tal. */
export function entryLine(e: ResolvedEntry): string {
  const base = entryText(e);
  if (e.kind !== 'workout' || e.origin === 'session' || e.origin === 'active_session') return base;
  if (e.followsRotation && e.certainty === 'forecast') return `${base} (previsão)`;
  if (e.followsRotation && e.certainty === 'current') return `${base} (próximo da rotação)`;
  return base;
}

/** Versão curta (só a letra do treino), para células compactas e rótulos acessíveis delas. */
export function entryShort(e: ResolvedEntry): string {
  if (e.kind === 'rest') return 'descanso';
  if (e.kind === 'free') return 'dia livre';
  if (!e.workoutLabel) return e.followsRotation ? 'treino a definir pela rotação' : 'dia de treino';
  const w = `Treino ${e.workoutLabel}`;
  if (e.followsRotation && e.certainty === 'forecast') return `${w} (previsão)`;
  if (e.followsRotation && e.certainty === 'current') return `${w} (próximo da rotação)`;
  return w;
}

