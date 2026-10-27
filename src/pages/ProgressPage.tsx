import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Dumbbell, LineChart, Ruler, Trophy } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { NativeSelect } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Card } from '@/components/ui/card';
import { useCompletedSessions, useToday } from '@/hooks/data';
import { useUnits } from '@/hooks/useUnits';
import { exerciseCatalog, exerciseSeries, setsByMuscle, weeklySeries, computeRecords } from '@/modules/training';
import { addDays, fmtDateShort, startOfWeek } from '@/lib/dates';
import { fmtNum } from '@/lib/utils';
import { BarsChart, ChartCard, Empty, TrendChart } from '@/components/charts';
import { BodySection } from '@/features/body/BodySection';

type ExMetric = 'maxWeight' | 'best1RM' | 'bestReps' | 'volume';

function TrainingCharts() {
  const sessions = useCompletedSessions();
  const today = useToday();
  const { show, unit, fmtVol } = useUnits();
  const catalog = useMemo(() => exerciseCatalog(sessions ?? []), [sessions]);
  const [exKey, setExKey] = useState('');
  const [metric, setMetric] = useState<ExMetric>('maxWeight');
  const [range, setRange] = useState<'4' | '12' | '26'>('12');
  useEffect(() => {
    if (!exKey && catalog[0]) setExKey(catalog[0].key);
  }, [catalog, exKey]);

  if (!sessions) return null;
  if (!sessions.length) return <Empty text="Conclua treinos para ver gráficos de evolução." />;

  const series = exerciseSeries(sessions, exKey).map((p) => ({
    ...p,
    maxWeight: show(p.maxWeight) ?? 0,
    best1RM: Math.round((show(p.best1RM) ?? 0) * 10) / 10,
    volume: show(p.volume) ?? 0,
  }));
  const weeks = weeklySeries(sessions, today, Number(range));
  const muscle = setsByMuscle(sessions, addDays(startOfWeek(today), -21), addDays(today, 1));
  const records = [...computeRecords(sessions).values()].sort((a, b) => b.best1RM - a.best1RM);
  const metricFmt: Record<ExMetric, (v: number) => string> = {
    maxWeight: (v) => `${fmtNum(v, 1)} ${unit}`,
    best1RM: (v) => `${fmtNum(v, 1)} ${unit}`,
    bestReps: (v) => `${fmtNum(v, 0)} reps`,
    volume: (v) => `${fmtNum(v, 0)} ${unit}`,
  };
  const wkFmt = (w: string | number) => fmtDateShort(String(w));

  return (
    <div className="space-y-4">
      <ChartCard title="Evolução por exercício" description="Carga = maior carga em séries válidas · 1RM estimado pela fórmula de Epley">
        <div className="mb-3 space-y-2">
          <NativeSelect aria-label="Exercício" value={exKey} onChange={(e) => setExKey(e.target.value)}>
            {catalog.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name} ({c.count})
              </option>
            ))}
          </NativeSelect>
          <Segmented
            size="sm"
            aria-label="Métrica"
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'maxWeight', label: 'Carga' },
              { value: 'best1RM', label: '1RM est.' },
              { value: 'bestReps', label: 'Repetições' },
              { value: 'volume', label: 'Volume' },
            ]}
          />
        </div>
        <TrendChart data={series} x="date" y={metric} fmt={metricFmt[metric]} xFmt={(t) => fmtDateShort(Number(t))} />
      </ChartCard>

      <div className="flex justify-end">
        <Segmented
          size="sm"
          className="w-56"
          aria-label="Período"
          value={range}
          onChange={setRange}
          options={[
            { value: '4', label: '4 sem' },
            { value: '12', label: '12 sem' },
            { value: '26', label: '6 meses' },
          ]}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ChartCard title="Volume por semana" description="séries válidas × repetições × carga">
          <BarsChart data={weeks} x="week" y="volume" fmt={fmtVol} xFmt={wkFmt} />
        </ChartCard>
        <ChartCard title="Frequência de treinos" description="treinos concluídos por semana">
          <BarsChart data={weeks} x="week" y="count" fmt={(v) => `${v} treino${v === 1 ? '' : 's'}`} xFmt={wkFmt} />
        </ChartCard>
      </div>

      <ChartCard title="Séries por grupo muscular" description="séries válidas nas últimas 4 semanas">
        <BarsChart horizontal data={muscle} x="group" y="sets" fmt={(v) => `${v} séries`} />
      </ChartCard>

      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <Trophy className="h-5 w-5 text-primary" />
          <h3 className="font-display font-semibold">Recordes pessoais</h3>
        </div>
        {records.length === 0 ? (
          <Empty />
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[480px] text-sm tabular" data-testid="records-table">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="pb-2 font-medium">Exercício</th>
                  <th className="pb-2 font-medium">Maior carga</th>
                  <th className="pb-2 font-medium">1RM est.</th>
                  <th className="pb-2 font-medium">Mais reps</th>
                  <th className="pb-2 font-medium">Data</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.exerciseKey} className="border-t">
                    <td className="max-w-[160px] truncate py-2 pr-2">{r.name}</td>
                    <td className="py-2">
                      {fmtNum(show(r.maxWeight), 1)} × {r.maxWeightReps}
                    </td>
                    <td className="py-2">{fmtNum(show(r.best1RM), 1)}</td>
                    <td className="py-2">
                      {r.maxReps} @ {fmtNum(show(r.maxRepsWeight), 1)}
                    </td>
                    <td className="py-2 text-muted-foreground">{fmtDateShort(r.maxWeightDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function ProgressPage() {
  return (
    <div>
      <PageHeader title="Evolução" subtitle="Cargas, volume, frequência e medidas" />
      <Tabs defaultValue="treino">
        <TabsList>
          <TabsTrigger value="treino">
            <Dumbbell /> Treino
          </TabsTrigger>
          <TabsTrigger value="corpo">
            <Ruler /> Corpo
          </TabsTrigger>
        </TabsList>
        <TabsContent value="treino">
          <Link
            to="/evolucao/desempenho"
            data-testid="open-analytics"
            className="mb-4 flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-4 transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
              <LineChart className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">Análise de desempenho</span>
              <span className="block text-sm text-muted-foreground">Frequência, volume, tendências, recordes e insights por período</span>
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
          </Link>
          <TrainingCharts />
        </TabsContent>
        <TabsContent value="corpo">
          <BodySection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
