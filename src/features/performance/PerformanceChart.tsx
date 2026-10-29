import { useMemo, useState, type KeyboardEvent } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import { Empty } from '@/components/charts';
import { CHART_GAP_DAYS, type ChartSeries } from '@/modules/performance';
import { axisValue, fmtIsoDate, fmtPerf, unitLong, type FmtCtx } from './format';

// Gráfico de evolução (P19): eixo temporal real (data da sessão), unidade na legenda, linha interrompida em pausas
// longas (com a pausa marcada), navegação por teclado (setas, Home, End) e tabela como alternativa textual.

const PRIMARY = 'hsl(var(--primary))';
const GRID = 'hsl(var(--border))';
const AXIS = 'hsl(var(--muted-foreground))';
const GAP_FILL = 'hsl(var(--muted))';

const tickFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' });
const tickFmtYear = new Intl.DateTimeFormat('pt-BR', { month: 'short', year: '2-digit' });

interface Row {
  t: number;
  v: number | null;
  i: number | null;
}

function Tip({ active, payload, series, ctx }: TooltipProps<number, string> & { series: ChartSeries; ctx: FmtCtx }) {
  const i = payload?.[0]?.payload?.i as number | null | undefined;
  if (!active || i === null || i === undefined) return null;
  const p = series.points[i];
  return (
    <div className="rounded-xl border bg-popover px-3 py-2 text-sm shadow-xl">
      <p className="text-xs text-muted-foreground">{fmtIsoDate(p.date)}</p>
      <p className="font-display font-bold tabular">{fmtPerf(p.value, series.unit, ctx)}</p>
    </div>
  );
}

export function PerformanceChart({ series, label, ctx, testId = 'perf-chart' }: { series: ChartSeries; label: string; ctx: FmtCtx; testId?: string }) {
  const pts = series.points;
  const [active, setActive] = useState<number | null>(null);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    pts.forEach((p, i) => {
      // Ponto vazio no meio da pausa: a linha não liga sessões separadas por um longo período sem registro.
      if (p.gapBefore) out.push({ t: (pts[i - 1].ts + p.ts) / 2, v: null, i: null });
      out.push({ t: p.ts, v: axisValue(p.value, series.unit, ctx), i });
    });
    return out;
  }, [pts, series.unit, ctx]);
  const spanDays = pts.length > 1 ? (pts[pts.length - 1].ts - pts[0].ts) / 86_400_000 : 0;
  const xFmt = (t: number) => (spanDays > 200 ? tickFmtYear : tickFmt).format(new Date(t)).replace('.', '');
  if (!pts.length) return <Empty text="Sem registros desta medida no período." />;

  const values = pts.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const gaps = pts.filter((p) => p.gapBefore).length;
  const summary = `${label}: ${pts.length} ${pts.length === 1 ? 'sessão' : 'sessões'} de ${fmtIsoDate(pts[0].date)} a ${fmtIsoDate(pts[pts.length - 1].date)}. Menor ${fmtPerf(min, series.unit, ctx)}, maior ${fmtPerf(max, series.unit, ctx)}, última ${fmtPerf(values[values.length - 1], series.unit, ctx)}.${gaps ? ` ${gaps} ${gaps === 1 ? 'pausa longa' : 'pausas longas'} sem registros.` : ''}`;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = pts.length - 1;
    const cur = active ?? last;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = Math.max(0, active === null ? last : cur - 1);
    else if (e.key === 'ArrowRight') next = Math.min(last, active === null ? last : cur + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Escape') setActive(null);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };
  const ap = active !== null ? pts[active] : null;
  return (
    <figure className="space-y-2" data-testid={testId}>
      <div
        role="group"
        tabIndex={0}
        aria-label={`Gráfico: ${label}, em ${unitLong(series.unit, ctx)}. Use as setas para percorrer as sessões.`}
        aria-describedby={`${testId}-summary`}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        className="h-52 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            {pts.map((p, i) =>
              p.gapBefore ? <ReferenceArea key={`gap-${p.sessionId}`} x1={pts[i - 1].ts} x2={p.ts} fill={GAP_FILL} fillOpacity={0.5} ifOverflow="extendDomain" label={{ value: 'pausa', fill: AXIS, fontSize: 10, position: 'insideTop' }} /> : null,
            )}
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={pts.length > 1 ? ['dataMin', 'dataMax'] : [pts[0].ts - 86_400_000 * 3, pts[0].ts + 86_400_000 * 3]}
              tickFormatter={xFmt}
              stroke={AXIS}
              fontSize={11}
              tickLine={false}
              axisLine={false}
              minTickGap={28}
            />
            <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} width={44} domain={['auto', 'auto']} allowDecimals={series.unit !== 'repeticoes'} />
            <Tooltip content={<Tip series={series} ctx={ctx} />} cursor={{ stroke: AXIS, strokeDasharray: '3 3' }} />
            <Line type="linear" dataKey="v" stroke={PRIMARY} strokeWidth={2} connectNulls={false} dot={{ r: 3.5, fill: PRIMARY, strokeWidth: 0 }} activeDot={{ r: 5 }} isAnimationActive={false} />
            {ap && <ReferenceDot x={ap.ts} y={axisValue(ap.value, series.unit, ctx)} r={7} fill="none" stroke={PRIMARY} strokeWidth={2} />}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="space-y-1 text-xs text-muted-foreground">
        <p>
          <span className="mr-1 inline-block h-2 w-3 rounded-sm bg-primary align-middle" aria-hidden /> {label} por sessão, em {unitLong(series.unit, ctx)}.
          {gaps > 0 && ` Áreas cinza marcam pausas de mais de ${CHART_GAP_DAYS} dias: a linha não liga esses pontos.`}
          {pts.length === 1 && ' Registre mais uma sessão para ver a linha de evolução.'}
        </p>
        <p id={`${testId}-summary`}>{summary}</p>
        <p aria-live="polite" className="min-h-4 font-medium text-foreground" data-testid={`${testId}-active`}>
          {ap ? `${fmtIsoDate(ap.date)}: ${fmtPerf(ap.value, series.unit, ctx)}` : ''}
        </p>
      </figcaption>
      <details className="rounded-xl border px-3 py-2 text-sm" data-testid={`${testId}-table`}>
        <summary className="cursor-pointer select-none py-1 font-medium">Ver dados em tabela</summary>
        <table className="mt-2 w-full text-left tabular">
          <caption className="sr-only">{label} por sessão</caption>
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
              <th scope="col" className="pb-1 font-medium">Data</th>
              <th scope="col" className="pb-1 font-medium">{label}</th>
              <th scope="col" className="pb-1 font-medium">Observação</th>
            </tr>
          </thead>
          <tbody>
            {pts.map((p) => (
              <tr key={p.sessionId} className="border-t">
                <td className="py-1">{fmtIsoDate(p.date)}</td>
                <td className="py-1">{fmtPerf(p.value, series.unit, ctx)}</td>
                <td className="py-1 text-xs text-muted-foreground">{p.gapBefore ? `após ${p.gapDays} dias sem registro` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
