import { memo, useMemo } from 'react';
import { emphasisFor, visualFor } from '@/modules/exercises/demos';
import type { LibraryItem } from '@/modules/exercises';
import { Badge } from '@/components/ui/badge';
import { MuscleMap2D } from './MuscleMap2D';

/**
 * Miniatura da lista da biblioteca (P20): mapa muscular 2D (frente e costas) do exercício. Decorativa para leitores de
 * tela (o grupo principal já está escrito na linha); leve: SVG, sem WebGL.
 */
export const ExerciseThumb = memo(function ExerciseThumb({ item }: { item: Pick<LibraryItem, 'primaryMuscles' | 'secondaryMuscles'> }) {
  const emphasis = useMemo(() => emphasisFor(item.primaryMuscles, item.secondaryMuscles), [item.primaryMuscles, item.secondaryMuscles]);
  return (
    <span className="block w-12 shrink-0" aria-hidden data-testid="exercise-thumb">
      <MuscleMap2D emphasis={emphasis} label="" className="pointer-events-none" />
    </span>
  );
});

/** Selo "3D" quando o exercício tem demonstração (animação ou posição) do humanoide. */
export function VisualBadge({ item }: { item: Pick<LibraryItem, 'kind' | 'refId'> }) {
  const v = visualFor(item.kind === 'catalog' ? item.refId : null);
  if (v.status === 'anatomia') return null;
  return (
    <Badge variant="default" title={v.status === 'animado' ? 'Demonstração 3D do movimento' : 'Posição 3D'} data-testid="badge-3d">
      3D{v.status === 'posicao' ? ' posição' : ''}
    </Badge>
  );
}
