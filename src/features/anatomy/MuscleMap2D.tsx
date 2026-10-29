import { useId } from 'react';
import { cn } from '@/lib/utils';
import type { Emphasis, MusclePart } from '@/modules/exercises/demos';
import { ARM, CALF, MIRROR, SILHOUETTE, THIGH } from '@/features/body/silhouette';
import { MUSCLE_COLORS } from './colors';

// Mapa muscular 2D (P20): a mesma silhueta do mapa do corpo e as mesmas regiões do humanoide 3D (uma taxonomia só,
// ver src/modules/exercises/demos/muscles.ts). É o modo leve (miniaturas da biblioteca) e o substituto quando o aparelho
// não abre WebGL. Metade esquerda desenhada e espelhada.

interface Shape {
  d: string;
  part?: MusclePart;
}

const FRONT: Shape[] = [
  { d: 'M91 60 Q79 65 70 71 L91 69 Z', part: 'trapezio' },
  { d: 'M71 71 Q54 72 49 92 Q50 102 55 106 Q61 92 70 86 Z', part: 'deltoide' },
  { d: 'M99 72 L74 73 Q64 84 66 100 Q80 112 99 107 Z', part: 'peitoral' },
  { d: ARM, part: 'biceps' },
  { d: 'M43 139 Q36 161 34 187 L44 189 Q52 163 57 141 Z', part: 'antebraco' },
  { d: 'M38 187 Q31 196 35 207 Q41 210 44 204 Q45 194 44 189 Z' },
  { d: 'M66 102 Q63 118 67 136 L74 133 Q72 117 71 104 Z' },
  { d: 'M76 110 Q78 124 75 136 Q71 156 76 175 L85 177 L85 112 Z', part: 'obliquos' },
  { d: 'M87 111 L98 111 L98 125 L87 125 Z M87 128 L98 128 L98 143 L87 143 Z M87 146 L98 146 L98 161 L87 161 Z M87 164 L99 164 L99 198 Q92 192 87 180 Z', part: 'reto_abdominal' },
  { d: 'M76 178 Q67 189 67 205 L81 207 Q85 193 87 181 Z', part: 'gluteo_medio' },
  { d: THIGH, part: 'quadriceps' },
  { d: 'M89 212 Q97 222 97 246 Q94 262 89 270 Q85 240 89 212 Z', part: 'adutores' },
  { d: 'M70 293 Q68 302 71 309 Q79 313 87 309 Q90 300 88 293 Q79 298 70 293 Z' },
  { d: CALF },
  { d: 'M68 385 L83 385 L86 397 Q74 400 62 397 Z' },
];

const BACK: Shape[] = [
  { d: 'M99 56 Q84 62 71 71 Q80 80 99 96 Z', part: 'trapezio' },
  { d: 'M71 71 Q54 72 49 92 Q50 102 55 106 Q61 92 70 86 Z', part: 'deltoide' },
  { d: ARM, part: 'triceps' },
  { d: 'M43 139 Q36 161 34 187 L44 189 Q52 163 57 141 Z', part: 'antebraco' },
  { d: 'M38 187 Q31 196 35 207 Q41 210 44 204 Q45 194 44 189 Z' },
  { d: 'M72 86 Q65 104 71 124 Q84 130 99 126 L99 98 Q84 86 72 86 Z', part: 'dorsal' },
  { d: 'M71 127 Q68 150 75 176 L99 178 L99 129 Q85 133 71 127 Z', part: 'eretores' },
  { d: 'M73 170 Q66 178 67 190 Q76 183 86 180 Q80 174 73 170 Z', part: 'gluteo_medio' },
  { d: 'M75 179 Q65 194 69 211 Q85 220 99 211 L99 180 Z', part: 'gluteo_maximo' },
  { d: THIGH, part: 'isquiotibiais' },
  { d: 'M70 293 Q68 302 71 309 Q79 313 87 309 Q90 300 88 293 Q79 298 70 293 Z' },
  { d: CALF, part: 'panturrilha' },
  { d: 'M68 385 L83 385 L86 397 Q74 400 62 397 Z' },
];

/** Regiões que aparecem em cada vista do mapa 2D. */
export const MAP2D_PARTS: Record<'front' | 'back', MusclePart[]> = {
  front: FRONT.flatMap((s) => (s.part ? [s.part] : [])),
  back: BACK.flatMap((s) => (s.part ? [s.part] : [])),
};

function Half({ shapes, emphasis, hatch, mirror }: { shapes: Shape[]; emphasis: ReadonlyMap<MusclePart, Emphasis>; hatch: string; mirror: boolean }) {
  return (
    <g transform={mirror ? MIRROR : undefined}>
      {shapes.map((sh, i) => {
        const e = sh.part ? emphasis.get(sh.part) : undefined;
        const fill = e === 'primary' ? MUSCLE_COLORS.primary : e === 'secondary' ? `url(#${hatch})` : sh.part ? 'hsl(var(--muted-foreground) / 0.32)' : 'hsl(var(--muted-foreground) / 0.16)';
        return <path key={i} d={sh.d} fill={fill} stroke="hsl(var(--background))" strokeWidth={1.1} strokeLinejoin="round" data-part={sh.part} data-emphasis={e} />;
      })}
    </g>
  );
}

/**
 * Corpo de frente e de costas com os músculos do exercício: principal em vermelho, secundário em laranja com hachura,
 * o resto neutro. `label` descreve a figura para leitores de tela (a legenda em texto fica fora, em quem usa).
 */
export function MuscleMap2D({ emphasis, label, className, views = ['front', 'back'] }: { emphasis: ReadonlyMap<MusclePart, Emphasis>; label: string; className?: string; views?: ('front' | 'back')[] }) {
  const uid = useId().replace(/:/g, '');
  const hatch = `hatch-${uid}`;
  return (
    <svg viewBox={`0 0 ${200 * views.length} 422`} className={cn('h-auto w-full', className)} role="img" aria-label={label} data-testid="muscle-map-2d">
      <defs>
        <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill={MUSCLE_COLORS.secondary} />
          <line x1="0" y1="0" x2="0" y2="6" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="2" />
        </pattern>
      </defs>
      {views.map((v, i) => (
        <g key={v} transform={`translate(${i * 200} 0)`}>
          <ellipse cx={100} cy={31} rx={15} ry={19} fill="hsl(var(--secondary))" />
          <path d={SILHOUETTE} fill="hsl(var(--secondary))" />
          <path d={SILHOUETTE} transform={MIRROR} fill="hsl(var(--secondary))" />
          <Half shapes={v === 'front' ? FRONT : BACK} emphasis={emphasis} hatch={hatch} mirror={false} />
          <Half shapes={v === 'front' ? FRONT : BACK} emphasis={emphasis} hatch={hatch} mirror />
          <text x={100} y={418} textAnchor="middle" fontSize={13} fill="hsl(var(--muted-foreground))">
            {v === 'front' ? 'Frente' : 'Costas'}
          </text>
        </g>
      ))}
    </svg>
  );
}
