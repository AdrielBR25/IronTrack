// Textos do painel de planejamento (IronTrack 2.0 F01/P13). Estados sempre em texto (nunca só cor) e sem
// linguagem de culpa: dia sem treino não "falhou".
import { fromISODate, weekdayLong } from '@/lib/dates';
import type { ActivityStatus, DayState, PlannedActivity } from '@/modules/planner';

export const fmtDayLong = (iso: string) => new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(fromISODate(iso));
export const fmtDayShort = (iso: string) => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(fromISODate(iso));
export const fmtWeekRange = (monday: string, sunday: string) => {
  const f = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' });
  const y = fromISODate(sunday).getFullYear();
  return `${f.format(fromISODate(monday)).replace('.', '')} – ${f.format(fromISODate(sunday)).replace('.', '')} ${y}`;
};

/** "toda segunda", "todo sábado"… */
export const everyWeekday = (weekday: number) => `${weekday === 0 || weekday === 6 ? 'todo' : 'toda'} ${weekdayLong(weekday)}`;

export function activityTitle(a: Pick<PlannedActivity, 'availability' | 'routineName' | 'workoutLabel' | 'workoutName' | 'followsRotation'>, rotationNext?: { label: string; name: string } | null): string {
  if (a.availability === 'routine_missing') return 'Rotina excluída';
  if (a.availability === 'workout_missing') return `${a.routineName} · treino removido da rotina`;
  if (a.followsRotation) return `${a.routineName} · próximo da rotação${rotationNext ? ` (Treino ${rotationNext.label})` : ''}`;
  return `Treino ${a.workoutLabel} · ${a.workoutName}`;
}

export const DAY_STATE_SHORT: Record<DayState, string> = {
  futuro: 'Futuro',
  planejado: 'Planejado',
  concluido: 'Concluído',
  parcial: 'Parcial',
  sem_plano: 'Sem plano',
};

export const ACTIVITY_TONE: Record<ActivityStatus, string> = {
  realizada: 'bg-primary/15 text-primary',
  em_andamento: 'bg-primary/15 text-primary',
  pendente: 'bg-secondary text-secondary-foreground',
  nao_registrada: 'bg-secondary text-muted-foreground',
  futura: 'border text-muted-foreground',
};

export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
