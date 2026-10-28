import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// Gráficos de série única: cor de destaque, marcas finas, grade discreta e tooltip.

const PRIMARY = 'hsl(var(--primary))';
const GRID = 'hsl(var(--border))';
const WARN = 'hsl(var(--warn))';
const AXIS = 'hsl(var(--muted-foreground))';
const compactFmt = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const compact = (v: number) => compactFmt.format(v);

export function ChartCard({ title, description, children, action }: { title: string; description?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription className="text-xs">{description}</CardDescription>}
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Tip({ active, payload, label, fmt, labelFmt }: TooltipProps<number, string> & { fmt: (v: number) => string; labelFmt?: (l: string | number) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border bg-popover px-3 py-2 text-sm shadow-xl">
      <p className="text-xs text-muted-foreground">{labelFmt ? labelFmt(label) : label}</p>
      <p className="font-display font-bold tabular">{fmt(Number(payload[0].value))}</p>
    </div>
  );
}

/** P12: linha de meta (valor desejado), tracejada e com rótulo em texto; a escala se estende para mostrá-la. */
export interface GoalLine {
  value: number;
  label: string;
}

function goalLines(lines: GoalLine[] | undefined) {
  return (lines ?? [])
    .filter((l) => Number.isFinite(l.value) && l.value > 0)
    .map((l, i) => (
      <ReferenceLine
        key={`${l.label}-${i}`}
        y={l.value}
        stroke={WARN}
        strokeDasharray="6 4"
        strokeWidth={1.5}
        ifOverflow="extendDomain"
        label={{ value: l.label, position: 'insideTopLeft', fill: AXIS, fontSize: 11 }}
      />
    ));
}

export function Empty({ text = 'Sem dados suficientes ainda.' }: { text?: string }) {
  return <div className="flex h-40 items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">{text}</div>;
}

export function TrendChart<T extends object>({
  data,
  x,
  y,
  fmt,
  xFmt,
  height = 200,
  goals,
}: {
  data: T[];
  x: keyof T & string;
  y: keyof T & string;
  fmt: (v: number) => string;
  xFmt: (v: string | number) => string;
  height?: number;
  goals?: GoalLine[];
}) {
  if (data.length < 2) return <Empty text={data.length === 1 ? 'Registre mais uma sessão para ver a linha de evolução.' : undefined} />;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id={`g-${y}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.3} />
              <stop offset="100%" stopColor={PRIMARY} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={x} tickFormatter={xFmt} stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} width={48} domain={['auto', 'auto']} tickFormatter={compact} />
          <Tooltip content={<Tip fmt={fmt} labelFmt={xFmt} />} cursor={{ stroke: AXIS, strokeDasharray: '3 3' }} />
          <Area type="monotone" dataKey={y} stroke={PRIMARY} strokeWidth={2} fill={`url(#g-${y})`} dot={{ r: 3, fill: PRIMARY, strokeWidth: 0 }} activeDot={{ r: 5, stroke: 'hsl(var(--card))', strokeWidth: 2 }} isAnimationActive={false} />
          {goalLines(goals)}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function BarsChart<T extends object>({
  data,
  x,
  y,
  fmt,
  xFmt,
  height = 200,
  horizontal,
  goals,
}: {
  data: T[];
  x: keyof T & string;
  y: keyof T & string;
  fmt: (v: number) => string;
  xFmt?: (v: string | number) => string;
  height?: number;
  horizontal?: boolean;
  /** Só no gráfico vertical. */
  goals?: GoalLine[];
}) {
  if (!data.length || data.every((d) => !Number((d as Record<string, unknown>)[y]))) return <Empty />;
  if (horizontal) {
    return (
      <div style={{ height: Math.max(120, data.length * 34) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }} barCategoryGap={6}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey={x} stroke={AXIS} fontSize={12} tickLine={false} axisLine={false} width={110} />
            <Tooltip content={<Tip fmt={fmt} />} cursor={{ fill: 'hsl(var(--accent))' }} />
            <Bar dataKey={y} fill={PRIMARY} radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false} label={{ position: 'right', fill: AXIS, fontSize: 11 }} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} barCategoryGap="20%">
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={x} tickFormatter={xFmt} stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} minTickGap={16} />
          <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} width={48} allowDecimals={false} tickFormatter={compact} />
          <Tooltip content={<Tip fmt={fmt} labelFmt={xFmt} />} cursor={{ fill: 'hsl(var(--accent))' }} />
          <Bar dataKey={y} fill={PRIMARY} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          {goalLines(goals)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface StackDatum {
  t: string;
  a: number;
  b: number;
}

/** Barras empilhadas de duas partes (ex.: massa magra + massa gorda = peso). */
export function StackChart({
  data,
  aLabel,
  bLabel,
  fmt,
  xFmt,
  height = 220,
}: {
  data: StackDatum[];
  aLabel: string;
  bLabel: string;
  fmt: (v: number) => string;
  xFmt: (v: string | number) => string;
  height?: number;
}) {
  if (data.length < 2) return <Empty text="Precisa de pelo menos 2 avaliações com composição corporal." />;
  return (
    <div>
      <div className="mb-2 flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: PRIMARY }} /> {aLabel}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: WARN }} /> {bLabel}
        </span>
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} barCategoryGap="22%">
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="t" tickFormatter={xFmt} stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} />
            <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} width={48} tickFormatter={compact} />
            <Tooltip
              cursor={{ fill: 'hsl(var(--accent))' }}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <div className="rounded-xl border bg-popover px-3 py-2 text-sm shadow-xl">
                    <p className="text-xs text-muted-foreground">{xFmt(label)}</p>
                    <p className="tabular">
                      <span className="text-primary">●</span> {aLabel}: <b>{fmt(Number(payload[0]?.payload.a))}</b>
                    </p>
                    <p className="tabular">
                      <span style={{ color: WARN }}>●</span> {bLabel}: <b>{fmt(Number(payload[0]?.payload.b))}</b>
                    </p>
                  </div>
                ) : null
              }
            />
            <Bar dataKey="a" stackId="s" fill={PRIMARY} maxBarSize={36} isAnimationActive={false}>
              <LabelList dataKey="a" position="center" fontSize={10} fill="hsl(var(--primary-foreground))" formatter={(v: number) => compact(v)} />
            </Bar>
            <Bar dataKey="b" stackId="s" fill={WARN} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false}>
              <LabelList dataKey="b" position="center" fontSize={10} fill="hsl(var(--primary-foreground))" formatter={(v: number) => compact(v)} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Barras horizontais pelo tamanho da variação: verde quando ela é boa, laranja quando não é. */
export function DeltaBars({ data, fmt, goodWhenNegative = true }: { data: { name: string; v: number }[]; fmt: (v: number) => string; goodWhenNegative?: boolean }) {
  if (!data.length) return <Empty />;
  const rows = data.map((d) => ({ ...d, size: Math.abs(d.v) }));
  return (
    <div style={{ height: Math.max(120, rows.length * 32) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 48, left: 0, bottom: 0 }} barCategoryGap={6}>
          <XAxis type="number" hide domain={[0, 'dataMax']} />
          <YAxis type="category" dataKey="name" stroke={AXIS} fontSize={12} tickLine={false} axisLine={false} width={96} />
          <Tooltip cursor={{ fill: 'hsl(var(--accent))' }} content={({ active, payload }) => (active && payload?.length ? <div className="rounded-xl border bg-popover px-3 py-2 text-sm shadow-xl tabular">{fmt(Number(payload[0].payload.v))}</div> : null)} />
          <Bar dataKey="size" radius={4} maxBarSize={20} isAnimationActive={false}>
            {rows.map((d) => (
              <Cell key={d.name} fill={(d.v < 0) === goodWhenNegative ? PRIMARY : WARN} />
            ))}
            <LabelList dataKey="v" position="right" fontSize={11} fill={AXIS} formatter={fmt} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
