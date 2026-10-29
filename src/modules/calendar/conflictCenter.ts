// Central de divergências (IronTrack 2.0 F01/P15, docs/CONSOLIDACAO_AGENDAS.md §5 e §9). Agrupa os conflitos que o
// P14 já detecta (nenhuma regra nova de detecção), sem repetir mensagens, explicando a ORIGEM, o IMPACTO e quais ações
// existem. Puro e só de leitura: nada aqui resolve ou grava. Uma decisão só é "aplicada" quando altera o planejamento
// (pela tela, com confirmação); fechar ou recolher um aviso é sempre apenas visual.
import type { CalendarConflict, ConflictKind, ConflictSeverity, ResolvedDay } from './types';

/** Ação que a tela pode oferecer para um dia do grupo. `legacy_for_day` altera o planejamento (exceção da data). */
export type ConflictAction = 'open_day' | 'edit_plan' | 'see_legacy' | 'legacy_for_day';

export interface ConflictGroupDay {
  date: string;
  /** O dia já passou (só leitura). */
  isPast: boolean;
  /** Mensagens do dia neste grupo, sem repetição. */
  messages: string[];
  conflicts: CalendarConflict[];
  actions: ConflictAction[];
  /** O que "Usar a agenda anterior só neste dia" gravaria (null quando não é suportado com segurança). */
  legacyChoice: { kind: 'workout' | 'rest'; routineId: string; workoutId: string | null; label: string } | null;
}

export interface ConflictGroup {
  id: string;
  kind: ConflictKind;
  severity: ConflictSeverity;
  title: string;
  /** De onde vem a divergência. */
  origin: string;
  /** O que acontece se nada for feito. */
  impact: string;
  days: ConflictGroupDay[];
}

const META: Record<ConflictKind, { title: string; origin: string; impact: Record<ConflictSeverity, string> }> = {
  plan_vs_legacy_workout: {
    title: 'Planejamento × agenda anterior: treinos diferentes',
    origin: 'Agenda anterior: dias de treino das Configurações e reagendamentos feitos na tela Treinos.',
    impact: {
      warning: 'Vale o planejamento (Início, Treinos e Planejamento mostram o planejado). Quem seguir a agenda anterior pode iniciar outro treino.',
      info: 'Só previsão: a agenda anterior não define estes dias. Nada muda se você não fizer nada.',
    },
  },
  plan_rest_vs_legacy_workout: {
    title: 'Descanso ou dia livre planejado × treino na agenda anterior',
    origin: 'Agenda anterior: dias de treino das Configurações e reagendamentos feitos na tela Treinos.',
    impact: { warning: 'Vale o planejamento (descanso). A agenda anterior ainda indica treino nestes dias.', info: 'Vale o planejamento (descanso).' },
  },
  plan_workout_vs_legacy_rest: {
    title: 'Treino planejado × descanso na agenda anterior',
    origin: 'Agenda anterior: descanso reagendado na tela Treinos ou dia que não é de treino nas Configurações.',
    impact: { warning: 'Vale o planejamento (treino). A agenda anterior marcou descanso nestes dias.', info: 'Vale o planejamento. Nas Configurações estes não são dias de treino.' },
  },
  exception_replaces_recurring: {
    title: 'Exceção substitui o planejamento semanal',
    origin: 'Planejamento: alteração feita "só neste dia".',
    impact: { warning: 'Vale a exceção.', info: 'Vale a exceção; o planejamento semanal das outras semanas não muda.' },
  },
  rotation_differs: {
    title: 'Planejado × próximo da rotação',
    origin: 'Rotação: ponteiro atual da rotina (tela Treinos).',
    impact: { warning: 'Você escolhe qual treino iniciar.', info: 'Ao iniciar, você escolhe qual treino; ao concluir, a rotação segue a regra de sempre.' },
  },
  session_off_plan: {
    title: 'Treino realizado fora do planejado',
    origin: 'Histórico: sessão concluída num dia em que não estava planejada.',
    impact: { warning: 'O treino conta normalmente.', info: 'O treino conta normalmente; não é erro e nada é movido.' },
  },
};

const ORDER: ConflictKind[] = ['plan_vs_legacy_workout', 'plan_rest_vs_legacy_workout', 'plan_workout_vs_legacy_rest', 'rotation_differs', 'exception_replaces_recurring', 'session_off_plan'];

/** "Usar a agenda anterior só neste dia": só quando o que a agenda anterior indica é conhecido e o dia é editável. */
function legacyChoiceFor(day: ResolvedDay, c: CalendarConflict): ConflictGroupDay['legacyChoice'] {
  const l = day.legacy;
  if (!l || day.isPast || !c.kind.startsWith('plan_')) return null;
  if (l.kind === 'rest' && l.source === 'override') return { kind: 'rest', routineId: l.routineId, workoutId: null, label: 'descanso' };
  if (l.kind === 'workout') {
    // Reagendamento: o treino escolhido. Dia de treino pela rotação: "próximo da rotação" (nunca um treino fixo).
    if (l.source === 'override' && l.workoutId) return { kind: 'workout', routineId: l.routineId, workoutId: l.workoutId, label: l.workoutLabel ? `Treino ${l.workoutLabel}` : 'treino reagendado' };
    if (l.source === 'rotation') return { kind: 'workout', routineId: l.routineId, workoutId: null, label: 'próximo da rotação' };
  }
  return null;
}

/**
 * Agrupa os conflitos dos dias por tipo e gravidade. Avisos (`warning`) vêm sempre; informações só com
 * `includeInfo` (preferência de exibição — o que é escondido continua consultável no detalhe de cada dia).
 * P16: conflitos com decisão lembrada valendo ficam fora (não são reapresentados como novos); `remembered: true`
 * agrupa SÓ esses (para a seção "Decisões lembradas" do período).
 */
export function groupConflicts(days: readonly ResolvedDay[], opts: { includeInfo: boolean; remembered?: boolean }): ConflictGroup[] {
  const groups = new Map<string, ConflictGroup>();
  for (const day of days) {
    for (const c of day.conflicts) {
      if (!!c.remembered !== !!opts.remembered) continue;
      if (c.severity === 'info' && !opts.includeInfo && !opts.remembered) continue;
      const id = `${c.kind}:${c.severity}`;
      let g = groups.get(id);
      if (!g) {
        const m = META[c.kind];
        g = { id, kind: c.kind, severity: c.severity, title: m.title, origin: m.origin, impact: m.impact[c.severity], days: [] };
        groups.set(id, g);
      }
      let gd = g.days.find((x) => x.date === day.date);
      if (!gd) {
        gd = { date: day.date, isPast: day.isPast, messages: [], conflicts: [], actions: ['open_day'], legacyChoice: null };
        g.days.push(gd);
      }
      if (!gd.messages.includes(c.message)) gd.messages.push(c.message);
      gd.conflicts.push(c);
      if (!day.isPast && !gd.actions.includes('edit_plan')) gd.actions.push('edit_plan');
      if (c.kind.startsWith('plan_') && !gd.actions.includes('see_legacy')) gd.actions.push('see_legacy');
      const choice = gd.legacyChoice ?? legacyChoiceFor(day, c);
      if (choice) {
        gd.legacyChoice = choice;
        if (!gd.actions.includes('legacy_for_day')) gd.actions.push('legacy_for_day');
      }
    }
  }
  return [...groups.values()].sort((a, b) => (a.severity === b.severity ? ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) : a.severity === 'warning' ? -1 : 1));
}

/**
 * Contagem para o botão "Revisar divergências": dias com aviso e observações informativas (à parte), sem os
 * conflitos com decisão lembrada valendo (P16), que são contados separadamente em `rememberedDays`.
 */
export function conflictCounts(days: readonly ResolvedDay[]): { warningDays: number; infoDays: number; rememberedDays: number } {
  return {
    warningDays: days.filter((d) => d.hasWarning).length,
    infoDays: days.filter((d) => !d.hasWarning && d.conflicts.some((c) => !c.remembered)).length,
    rememberedDays: days.filter((d) => d.rememberedCount > 0).length,
  };
}
