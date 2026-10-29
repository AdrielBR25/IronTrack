// Operações em lote do construtor de fichas (IronTrack 2.0 F01/P18, docs/RECONHECIMENTO_EXERCICIOS.md §11–12):
// adicionar vários itens da biblioteca de uma vez e substituir vários exercícios de uma ficha. Puro: monta a prévia
// e a operação; a gravação é uma operação única (`addMany`/`replaceMany`) numa transação, tudo ou nada.
import type { ExerciseTemplate, Workout } from '@/modules/training';
import { instanceFromItem, substitutionPreview, type InstanceOptions, type SubstitutionPreview } from './instance';
import { instanceFingerprint } from './recognition';
import type { WorkoutOp } from './workoutOps';
import type { LibraryItem } from './types';

/** Uma linha da seleção múltipla: o item e o ID novo da instância (gerado uma vez, ao abrir a confirmação). */
export interface AddManyLine {
  item: LibraryItem;
  id: string;
}

/**
 * Instâncias novas, na ordem da seleção (a mesma que a pessoa vê), cada uma com ID próprio e a configuração padrão da
 * modalidade (sem carga). Itens arquivados são recusados aqui também.
 */
export function instancesForAddMany(lines: readonly AddManyLine[], o: Omit<InstanceOptions, 'id' | 'config'>): ExerciseTemplate[] {
  return lines.filter((l) => !l.item.archived).map((l) => instanceFromItem(l.item, { ...o, id: l.id }));
}

export const addManyOp = (exercises: ExerciseTemplate[]): WorkoutOp => ({ type: 'addMany', exercises });

/** Planejamento total (séries) de uma lista de exercícios: estimativa do que foi PLANEJADO, nunca volume executado. */
export function plannedSets(exercises: readonly Pick<ExerciseTemplate, 'sets'>[]): number {
  return exercises.reduce((n, e) => n + (Number.isFinite(e.sets) && e.sets > 0 ? e.sets : 0), 0);
}

export interface BulkReplacePick {
  /** Exercício da ficha a substituir. */
  id: string;
  item: LibraryItem;
  /** ID novo do substituto (gerado uma vez pela tela). */
  newId: string;
}

export interface BulkReplacePreview {
  rows: (SubstitutionPreview & { expected: string; position: number })[];
  /** Ordem final da ficha (nomes), com os substitutos nas posições dos originais. */
  finalOrder: { id: string; name: string; replaced: boolean }[];
  /** Total de metas que continuam ligadas aos exercícios anteriores (não são redirecionadas). */
  linkedGoals: number;
  /** Exercícios escolhidos que não estão mais na ficha (removidos em outra aba): ficam fora da prévia. */
  missing: string[];
  goalNote: string;
}

export const BULK_GOAL_NOTE = 'As metas vinculadas ao exercício anterior continuarão vinculadas a ele.';

/** Prévia da substituição múltipla, a partir da versão do treino que a tela tem. Nada é gravado aqui. */
export function bulkReplacePreview(
  w: Workout,
  picks: readonly BulkReplacePick[],
  o: Omit<InstanceOptions, 'id' | 'config'>,
  goalsByTemplate: ReadonlyMap<string, number>,
): BulkReplacePreview {
  const rows: BulkReplacePreview['rows'] = [];
  const missing: string[] = [];
  for (const p of picks) {
    const position = w.exercises.findIndex((e) => e.id === p.id);
    if (position < 0) {
      missing.push(p.id);
      continue;
    }
    const current = w.exercises[position];
    const pv = substitutionPreview(current, p.item, { ...o, id: p.newId, linkedGoals: goalsByTemplate.get(current.id) ?? 0 });
    rows.push({ ...pv, expected: instanceFingerprint(current), position });
  }
  rows.sort((a, b) => a.position - b.position);
  const byOld = new Map(rows.map((r) => [r.current.id, r.next]));
  const finalOrder = w.exercises.map((e) => {
    const n = byOld.get(e.id);
    return n ? { id: n.id, name: n.name, replaced: true } : { id: e.id, name: e.name, replaced: false };
  });
  return { rows, finalOrder, linkedGoals: rows.reduce((n, r) => n + r.linkedGoals, 0), missing, goalNote: BULK_GOAL_NOTE };
}

export const replaceManyOp = (pv: BulkReplacePreview): WorkoutOp => ({ type: 'replaceMany', pairs: pv.rows.map((r) => ({ id: r.current.id, expected: r.expected, exercise: r.next })) });
