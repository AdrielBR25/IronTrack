// Conquistas locais (IronTrack 2.0 F01/P12). Ver docs/METAS_TREINAMENTO.md §8.
// Derivadas, nunca gravadas: cada conquista aponta para uma meta e para a evidência calculada a partir dos
// registros. Sem pontuação, sem ranking, sem comparação entre pessoas e sem envio de dados.
import type { GoalProgress } from './progress';
import type { TrainingGoal } from './types';

export type AchievementKind = 'primeira_meta' | 'tres_metas' | 'frequencia_semanal' | 'recorde_meta';

export interface Achievement {
  /** Estável para o mesmo fato (ex.: 'recorde_meta:<id da meta>'). */
  id: string;
  kind: AchievementKind;
  title: string;
  /** Data local da evidência. */
  date: string;
  goalId: string;
  goalTitle: string;
}

export const ACHIEVEMENT_TITLE: Record<AchievementKind, string> = {
  primeira_meta: 'Primeira meta atingida',
  tres_metas: 'Três metas atingidas',
  frequencia_semanal: 'Meta de frequência cumprida numa semana',
  recorde_meta: 'Recorde pessoal numa meta',
};

/** Data em que a meta foi atingida pela primeira vez (frequência semanal: primeira semana cumprida). */
function firstAchievement(goal: TrainingGoal, p: GoalProgress): string | null {
  if (goal.type === 'weekly_frequency') return p.weekly?.firstMet?.metOn ?? null;
  return p.achievedAt;
}

export function deriveAchievements(items: readonly { goal: TrainingGoal; progress: GoalProgress }[]): Achievement[] {
  const done = items
    .map(({ goal, progress }) => ({ goal, progress, date: firstAchievement(goal, progress) }))
    .filter((x): x is typeof x & { date: string } => x.date !== null)
    .sort((a, b) => a.date.localeCompare(b.date) || a.goal.createdAt - b.goal.createdAt || a.goal.id.localeCompare(b.goal.id));
  const out: Achievement[] = [];
  const make = (kind: AchievementKind, x: (typeof done)[number], id: string = kind): Achievement => ({ id, kind, title: ACHIEVEMENT_TITLE[kind], date: x.date, goalId: x.goal.id, goalTitle: x.goal.title });
  if (done[0]) out.push(make('primeira_meta', done[0]));
  if (done[2]) out.push(make('tres_metas', done[2]));
  const weekly = done.find((x) => x.goal.type === 'weekly_frequency');
  if (weekly) out.push(make('frequencia_semanal', weekly));
  for (const x of done) if (x.goal.period === 'recorde' && x.progress.personalRecord) out.push(make('recorde_meta', x, `recorde_meta:${x.goal.id}`));
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
