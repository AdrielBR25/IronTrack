import { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { BodyEntry } from '@/lib/types';
import { availableMeasures, beforeScale, compare, REGIONS, regionById, type Comparison, type RegionId, verdict } from '@/modules/body';
import { cn, fmtNum } from '@/lib/utils';
import { fmtDateShort, fromISODate } from '@/lib/dates';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { TrendChart } from '@/components/charts';

// Mapa anatômico estilizado (metade esquerda desenhada e espelhada).
// Coordenadas no viewBox 200×405, eixo central em x=100.

type View = 'front' | 'back';
interface Shape {
  d: string;
  region?: RegionId;
  /** centro usado para escalar o contorno "antes" */
  c?: [number, number];
}

const ARM = 'M50 98 Q43 114 43 133 Q49 141 57 137 Q61 119 59 104 Z';
const THIGH = 'M67 209 Q60 250 66 290 Q76 298 88 290 Q96 250 98 206 Q89 200 81 202 Z';
const CALF = 'M68 312 Q62 342 68 380 L82 382 Q90 344 88 312 Z';
const COMMON: Shape[] = [
  { d: 'M71 71 Q54 72 49 92 Q50 102 55 106 Q61 92 70 86 Z' }, // deltoide
  { d: 'M43 139 Q36 161 34 187 L44 189 Q52 163 57 141 Z' }, // antebraço
  { d: 'M38 187 Q31 196 35 207 Q41 210 44 204 Q45 194 44 189 Z' }, // mão
  { d: 'M70 293 Q68 302 71 309 Q79 313 87 309 Q90 300 88 293 Q79 298 70 293 Z' }, // joelho
  { d: 'M68 385 L83 385 L86 397 Q74 400 62 397 Z' }, // pé
];

const SHAPES: Record<View, Shape[]> = {
  front: [
    ...COMMON,
    { d: 'M91 60 Q79 65 70 71 L91 69 Z' },
    { d: 'M99 72 L74 73 Q64 84 66 100 Q80 112 99 107 Z', region: 'chest', c: [84, 90] },
    { d: ARM, region: 'arm', c: [51, 118] },
    { d: 'M66 102 Q63 118 67 136 L74 133 Q72 117 71 104 Z', region: 'side', c: [69, 118] },
    { d: 'M87 111 L98 111 L98 125 L87 125 Z M87 128 L98 128 L98 143 L87 143 Z M87 146 L98 146 L98 161 L87 161 Z', region: 'abs', c: [92, 136] },
    { d: 'M76 110 Q78 124 75 136 Q71 156 76 175 L85 177 L85 112 Z', region: 'waist', c: [80, 144] },
    { d: 'M87 164 L99 164 L99 198 Q92 192 87 180 Z' },
    { d: 'M76 178 Q67 189 67 205 L81 207 Q85 193 87 181 Z', region: 'hip', c: [77, 192] },
    { d: THIGH, region: 'thigh', c: [80, 250] },
    { d: CALF, region: 'calf', c: [77, 346] },
  ],
  back: [
    ...COMMON,
    { d: 'M99 56 Q84 62 71 71 Q80 80 99 96 Z' }, // trapézio
    { d: ARM, region: 'triceps', c: [51, 118] },
    { d: 'M72 86 Q65 104 71 124 Q84 130 99 126 L99 98 Q84 86 72 86 Z', region: 'back', c: [85, 108] },
    { d: 'M71 127 Q68 150 75 176 L99 178 L99 129 Q85 133 71 127 Z' }, // lombar
    { d: 'M75 179 Q65 194 69 211 Q85 220 99 211 L99 180 Z', region: 'hip', c: [85, 196] },
    { d: THIGH, region: 'thigh', c: [80, 250] },
    { d: CALF, region: 'calf', c: [77, 346] },
  ],
};

// Contorno do corpo (metade esquerda), suavizado com Catmull-Rom.
const OUTLINE: [number, number][] = [
  [100, 49], [92, 50], [90, 62], [80, 66], [66, 69], [54, 74], [47, 88], [43, 108], [41, 132], [37, 152], [33, 176], [31, 190], [30, 201],
  [34, 209], [41, 210], [45, 202], [46, 190], [50, 168], [56, 146], [59, 124], [63, 106], [65, 124], [68, 142], [70, 158], [67, 178],
  [64, 200], [61, 236], [62, 270], [65, 296], [66, 316], [63, 344], [66, 372], [67, 386], [61, 396], [74, 400], [87, 398], [86, 384],
  [89, 354], [90, 322], [90, 304], [93, 280], [97, 246], [99, 214], [100, 212],
];

function smooth(pts: [number, number][]) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const [p1, p2] = [pts[i], pts[i + 1]];
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0]} ${p2[1]}`;
  }
  return d + ' Z';
}
const SILHOUETTE = smooth(OUTLINE);
const MUSCLE = 'hsl(var(--muted-foreground) / 0.2)';
const scaleAbout = ([cx, cy]: [number, number], s: number) => `translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})`;
const MIRROR = 'translate(200 0) scale(-1 1)';

function Figure({ view, selected, tint, cmp, onSelect }: { view: View; selected: RegionId; tint: (r: RegionId) => string | null; cmp: Comparison | null; onSelect: (r: RegionId) => void }) {
  const shapes = SHAPES[view];
  const sel = shapes.filter((s) => s.region === selected);
  const s = cmp ? beforeScale(cmp) : 1;
  const half = (mirror: boolean) => (
    <g transform={mirror ? MIRROR : undefined}>
      {shapes.map((sh, i) => {
        const t = sh.region ? tint(sh.region) : null;
        const isSel = sh.region === selected;
        return (
          <path
            key={i}
            d={sh.d}
            fill={isSel ? 'hsl(var(--primary))' : t ?? MUSCLE}
            fillOpacity={isSel ? 0.9 : 1}
            stroke="hsl(var(--background))"
            strokeWidth={1.1}
            strokeLinejoin="round"
            className={cn(sh.region && 'cursor-pointer transition-[fill] duration-200')}
            onClick={sh.region ? () => onSelect(sh.region!) : undefined}
          />
        );
      })}
      {cmp &&
        Math.abs(s - 1) > 0.005 &&
        sel.map((sh, i) => (
          <path
            key={`b${i}`}
            d={sh.d}
            transform={scaleAbout(sh.c!, s)}
            fill="hsl(var(--warn))"
            fillOpacity={0.16}
            stroke="hsl(var(--warn))"
            strokeWidth={1.3}
            strokeDasharray="3 2"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        ))}
    </g>
  );
  return (
    <svg viewBox="22 14 156 390" className="mx-auto h-[min(62vh,440px)] w-auto" role="img" aria-label={`Corpo, vista ${view === 'front' ? 'frontal' : 'posterior'}`}>
      <defs>
        <linearGradient id="skin" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="hsl(var(--secondary))" />
          <stop offset="0.5" stopColor="hsl(var(--accent))" />
          <stop offset="1" stopColor="hsl(var(--secondary))" />
        </linearGradient>
      </defs>
      <ellipse cx={100} cy={31} rx={15} ry={19} fill="url(#skin)" />
      <path d={SILHOUETTE} fill="url(#skin)" />
      <path d={SILHOUETTE} transform={MIRROR} fill="url(#skin)" />
      {half(false)}
      {half(true)}
    </svg>
  );
}

const pctFmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0, signDisplay: 'always' });

export function BodyMap({ entries }: { entries: BodyEntry[] }) {
  const withData = REGIONS.filter((r) => availableMeasures(entries, r).length);
  const [region, setRegion] = useState<RegionId>(() => (withData.some((r) => r.id === 'arm') ? 'arm' : (withData[0]?.id ?? 'arm')));
  const [measureId, setMeasureId] = useState<string | null>(null);
  const [base, setBase] = useState<'first' | 'previous'>('first');
  const [view, setView] = useState<View>('front');
  if (!withData.length) return null;

  const r = regionById(region);
  const measures = availableMeasures(entries, r);
  const measure = measures.find((m) => m.id === measureId) ?? measures[0];
  const cmp = measure ? compare(entries, measure, base) : null;

  // Cor de fundo de cada região: verde se a medida principal melhorou, laranja se piorou.
  const tint = (id: RegionId) => {
    const ms = availableMeasures(entries, regionById(id));
    const main = ms.find((m) => m.good !== 'neutral') ?? ms[0];
    const c = main && compare(entries, main, base);
    if (!c) return null;
    const v = verdict(c.measure.good, c.delta);
    return v === 'better' ? 'hsl(var(--primary) / 0.32)' : v === 'worse' ? 'hsl(var(--warn) / 0.4)' : 'hsl(var(--muted-foreground) / 0.35)';
  };

  const select = (id: RegionId) => {
    setRegion(id);
    setMeasureId(null);
    const reg = regionById(id);
    if (!reg.views.includes(view)) setView(reg.views[0]);
  };

  const v = cmp ? verdict(cmp.measure.good, cmp.delta, cmp.measure.unit === 'mm' ? 0.1 : 0.05) : 'same';
  const tone = v === 'better' ? 'text-primary' : v === 'worse' ? 'text-warn' : 'text-muted-foreground';
  const Icon = !cmp || v === 'same' ? Minus : cmp.delta < 0 ? ArrowDownRight : ArrowUpRight;
  const val = (n: number) => `${fmtNum(n, 1)} ${cmp?.measure.unit ?? ''}`;

  return (
    <Card className="overflow-hidden p-0" data-testid="body-map">
      <div className="space-y-3 p-4 pb-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-display text-lg font-bold">Mapa do corpo</h3>
            <p className="text-xs text-muted-foreground">Toque numa região para ver antes × agora</p>
          </div>
          <Segmented
            size="sm"
            className="w-36 shrink-0"
            aria-label="Vista"
            value={view}
            onChange={setView}
            options={[
              { value: 'front', label: 'Frente' },
              { value: 'back', label: 'Costas' },
            ]}
          />
        </div>
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {withData.map((reg) => (
            <button
              key={reg.id}
              type="button"
              onClick={() => select(reg.id)}
              aria-pressed={reg.id === region}
              className={cn(
                'shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                reg.id === region ? 'border-primary bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground',
              )}
            >
              {reg.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:items-center">
        <div className="rounded-2xl bg-gradient-to-b from-secondary/40 to-transparent py-2">
          <Figure view={view} selected={region} tint={tint} cmp={cmp} onSelect={select} />
          {cmp && (
            <div className="flex justify-center gap-4 pt-1 text-[11px] text-muted-foreground">
              <p className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-primary" /> Agora · {fmtDateShort(cmp.now.date)}
              </p>
              <p className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm border border-dashed border-warn bg-warn/20" /> Antes · {fmtDateShort(cmp.before.date)}
              </p>
            </div>
          )}
        </div>

        {cmp && (
          <div className="space-y-3" data-testid="region-detail">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-primary">{r.label}</p>
              {measures.length > 1 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {measures.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setMeasureId(m.id)}
                      aria-pressed={m.id === measure.id}
                      className={cn(
                        'rounded-lg border px-2.5 py-1 text-xs transition-colors',
                        m.id === measure.id ? 'border-primary/60 bg-primary/15 text-foreground' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-sm">{measure.label}</p>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl border border-dashed border-warn/50 p-2">
                <p className="text-[11px] text-muted-foreground">Antes</p>
                <p className="font-display font-bold tabular">{val(cmp.before.v)}</p>
              </div>
              <div className="rounded-xl border border-primary/50 bg-primary/10 p-2">
                <p className="text-[11px] text-muted-foreground">Agora</p>
                <p className="font-display font-bold tabular">{val(cmp.now.v)}</p>
              </div>
              <div className="rounded-xl border p-2">
                <p className="text-[11px] text-muted-foreground">Diferença</p>
                <p className={cn('flex items-center justify-center font-display font-bold tabular', tone)} data-testid="region-delta">
                  <Icon className="h-4 w-4" />
                  {fmtNum(Math.abs(cmp.delta), 1)}
                </p>
                <p className={cn('text-[10px] tabular', tone)}>{pctFmt.format((cmp.delta / cmp.before.v) * 100)}%</p>
              </div>
            </div>

            <Segmented
              size="sm"
              aria-label="Comparar com"
              value={base}
              onChange={setBase}
              options={[
                { value: 'first', label: 'Desde o início' },
                { value: 'previous', label: 'Última avaliação' },
              ]}
            />

            <TrendChart
              data={cmp.series.map((p) => ({ t: fromISODate(p.date).getTime(), v: p.v }))}
              x="t"
              y="v"
              height={140}
              fmt={(n) => val(n)}
              xFmt={(t) => fmtDateShort(Number(t))}
            />
            <p className="text-[11px] text-muted-foreground">
              {cmp.measure.kind === 'fold' ? 'Dobra cutânea mede a gordura sob a pele no local: quanto menor, menos gordura ali.' : 'Circunferência inclui músculo e gordura.'}{' '}
              No desenho, a diferença de tamanho é ampliada para ficar visível.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
