import type { Modifier } from '@dnd-kit/core';

/** Restringe o arraste ao eixo vertical (evita depender de @dnd-kit/modifiers). */
export const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });
