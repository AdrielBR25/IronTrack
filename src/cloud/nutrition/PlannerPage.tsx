// Planejamento alimentar (Fase 02): semana de refeições planejadas, sem registrar nada como consumido. Reaproveita
// um dia inteiro, marca "Comi" quando a refeição acontece e compara o planejado com o que foi consumido.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, ChevronLeft, ChevronRight, Copy, Plus } from 'lucide-react';
import type { MealView } from '@shared/nutrition/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { nutritionApi } from './api';
import { MealEditor, type MealEditorTarget } from './MealEditor';
import { CopyDayDialog } from './NutritionPage';
import { KIND_ORDER, MealCard, addDays, dayLabel, kcal, localToday, mondayOf, nowHHMM, shortDate } from './ui';

export default function PlannerPage() {
  const [week, setWeek] = useState(() => mondayOf(localToday()));
  const end = addDays(week, 6);
  const meals = useLifeQuery(() => nutritionApi.meals(week, end), [week]);
  const sums = useLifeQuery(() => nutritionApi.days(week, end), [week]);
  const today = sums.data?.today ?? localToday();
  const [editor, setEditor] = useState<MealEditorTarget | null>(null);
  const [copyFrom, setCopyFrom] = useState<{ date: string; has: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(week, i)), [week]);
  const byDay = useMemo(() => {
    const map = new Map<string, MealView[]>();
    for (const m of meals.data?.meals ?? []) map.set(m.date, [...(map.get(m.date) ?? []), m]);
    for (const list of map.values()) list.sort((a, b) => (a.time ?? '99').localeCompare(b.time ?? '99') || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    return map;
  }, [meals.data]);
  const sumOf = (d: string) => sums.data?.days.find((s) => s.date === d);

  const consume = async (m: MealView) => {
    if (busy) return;
    setBusy(m.id);
    try {
      await nutritionApi.consume(m.id, m.version, m.date === today ? nowHHMM() : m.time);
      toast.success(`${m.title} marcada como consumida.`);
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 pb-10" data-testid="meal-planner">
      <PageHeader
        title="Planejamento"
        subtitle="Planejado não conta como consumido"
        action={
          <Link to="/alimentacao" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar para Alimentação">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      <div className="flex items-center justify-between rounded-2xl border bg-card px-2 py-1.5">
        <button type="button" aria-label="Semana anterior" onClick={() => setWeek(addDays(week, -7))} className="rounded-lg p-2 active:bg-accent">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium tabular-nums">
          {shortDate(week)} – {shortDate(end)}
        </span>
        <button type="button" aria-label="Próxima semana" onClick={() => setWeek(addDays(week, 7))} className="rounded-lg p-2 active:bg-accent">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {days.map((d) => {
        const list = byDay.get(d) ?? [];
        const s = sumOf(d);
        const past = d < today;
        return (
          <section key={d} className={cn('space-y-2', past && 'opacity-80')} data-testid="planner-day">
            <div className="flex items-center justify-between px-1">
              <h2 className={cn('text-sm font-semibold', d === today && 'text-primary')}>{dayLabel(d, today)}</h2>
              <div className="flex items-center gap-3">
                {s?.planned && (
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    Plano {kcal(s.planned.kcal)} · comido {kcal(s.consumed.kcal)} kcal
                  </span>
                )}
                <button type="button" onClick={() => setCopyFrom({ date: d, has: list.length > 0 })} aria-label={`Copiar ${dayLabel(d, today)}`} className="text-muted-foreground">
                  <Copy className="h-4 w-4" />
                </button>
              </div>
            </div>
            {list.map((m) => (
              <MealCard key={m.id} meal={m} busy={busy === m.id} onOpen={() => setEditor({ date: d, meal: m })} onConsume={d <= today ? () => consume(m) : undefined} />
            ))}
            {list.length === 0 && !past && (
              <Card className="border-dashed bg-transparent">
                <CardContent className="p-3 text-center text-xs text-muted-foreground">Sem refeições planejadas.</CardContent>
              </Card>
            )}
            {!past && (
              <button type="button" onClick={() => setEditor({ date: d, status: 'planned' })} className="flex w-full items-center justify-center gap-1 rounded-xl py-2 text-xs font-medium text-primary active:bg-accent">
                <Plus className="h-3.5 w-3.5" />
                Planejar refeição
              </button>
            )}
          </section>
        );
      })}

      <MealEditor target={editor} today={today} onClose={() => setEditor(null)} />
      <CopyDayDialog open={!!copyFrom} onClose={() => setCopyFrom(null)} date={copyFrom?.date ?? today} today={today} hasMeals={!!copyFrom?.has} />
    </div>
  );
}
