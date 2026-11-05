// Metas nutricionais (Fase 02): calorias, macros, água, horários e preferências. A estimativa inicial é só um ponto de
// partida com as premissas à mostra; não é prescrição, e o app não aceita metas de restrição extrema.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Calculator, Info } from 'lucide-react';
import { ACTIVITY_LABEL, ACTIVITY_LEVELS, MEAL_KIND_LABEL, OBJECTIVES, OBJECTIVE_LABEL, type ActivityLevel, type EstimateView, type MealKind, type Objective } from '@shared/nutrition/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { nutritionApi } from './api';
import { kcal } from './ui';

const TIME_KINDS: MealKind[] = ['breakfast', 'lunch', 'snack', 'dinner', 'supper'];
const num = (v: string) => (v.trim() === '' ? null : Math.round(Number(v.replace(',', '.'))));

export default function GoalsPage() {
  const q = useLifeQuery(() => nutritionApi.goals().then((r) => r.goals));
  const g = q.data;
  const [objective, setObjective] = useState<Objective>('organization');
  const [f, setF] = useState({ kcal: '', protein: '', carbs: '', fat: '', waterMl: '' });
  const [times, setTimes] = useState<Partial<Record<MealKind, string>>>({});
  const [prefs, setPrefs] = useState('');
  const [est, setEst] = useState({ sex: 'male' as 'male' | 'female', age: '', weightKg: '', heightCm: '', activity: 'light' as ActivityLevel });
  const [estimate, setEstimate] = useState<EstimateView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!g) return;
    setObjective(g.objective);
    setF({ kcal: g.kcal?.toString() ?? '', protein: g.protein?.toString() ?? '', carbs: g.carbs?.toString() ?? '', fat: g.fat?.toString() ?? '', waterMl: g.waterMl?.toString() ?? '' });
    setTimes(g.mealTimes);
    setPrefs(g.preferences ?? '');
    if (g.estimate) {
      setEstimate(g.estimate);
      const i = g.estimate.input;
      setEst({ sex: i.sex, age: String(i.age), weightKg: String(i.weightKg), heightCm: String(i.heightCm), activity: i.activity });
    }
  }, [g]);

  const calc = async () => {
    try {
      const r = await nutritionApi.estimate({ objective, sex: est.sex, age: Number(est.age), weightKg: Number(est.weightKg.replace(',', '.')), heightCm: Number(est.heightCm), activity: est.activity });
      setEstimate(r.estimate);
    } catch (e) {
      toast.error(lifeError(e));
    }
  };
  const useEstimate = () => {
    if (!estimate) return;
    setF({ kcal: String(estimate.kcal), protein: String(estimate.protein), carbs: String(estimate.carbs), fat: String(estimate.fat), waterMl: String(estimate.waterMl) });
    toast.message('Estimativa aplicada ao formulário. Ajuste se quiser e salve.');
  };
  const save = async () => {
    setBusy(true);
    try {
      const mealTimes = Object.fromEntries(Object.entries(times).filter(([, v]) => v)) as Partial<Record<MealKind, string>>;
      await nutritionApi.saveGoals(
        { objective, kcal: num(f.kcal), protein: num(f.protein), carbs: num(f.carbs), fat: num(f.fat), waterMl: num(f.waterMl), mealTimes, preferences: prefs.trim() || null, estimate: estimate?.input ?? null },
        g?.version,
      );
      toast.success('Metas salvas.');
      q.reload();
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  const field = (k: keyof typeof f, label: string, unit: string) => (
    <label className="space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="relative">
        <Input inputMode="numeric" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} className="pr-12 tabular-nums" aria-label={label} data-testid={`goal-${k}`} />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{unit}</span>
      </div>
    </label>
  );

  return (
    <div className="space-y-4 pb-10" data-testid="nutrition-goals">
      <PageHeader
        title="Metas nutricionais"
        action={
          <Link to="/alimentacao" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar para Alimentação">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      <Card>
        <CardContent className="space-y-3 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Objetivo</p>
          <div className="grid grid-cols-2 gap-2">
            {OBJECTIVES.map((o) => (
              <button key={o} type="button" onClick={() => setObjective(o)} className={cn('rounded-xl border px-3 py-2 text-left text-sm', objective === o ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground')}>
                {OBJECTIVE_LABEL[o]}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Metas do dia</p>
          <div className="grid grid-cols-2 gap-3">
            {field('kcal', 'Calorias', 'kcal')}
            {field('waterMl', 'Água', 'ml')}
            {field('protein', 'Proteínas', 'g')}
            {field('carbs', 'Carboidratos', 'g')}
            {field('fat', 'Gorduras', 'g')}
          </div>
          <p className="text-[11px] text-muted-foreground">Todos os campos são opcionais. Sem meta, o app mostra só o que foi consumido.</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Calculator className="h-3.5 w-3.5" />
            Estimativa inicial
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 flex gap-2">
              {(['male', 'female'] as const).map((s) => (
                <button key={s} type="button" onClick={() => setEst({ ...est, sex: s })} className={cn('flex-1 rounded-xl border py-2 text-sm', est.sex === s ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground')}>
                  {s === 'male' ? 'Masculino' : 'Feminino'}
                </button>
              ))}
            </div>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Idade</span>
              <Input inputMode="numeric" value={est.age} onChange={(e) => setEst({ ...est, age: e.target.value })} />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Peso (kg)</span>
              <Input inputMode="decimal" value={est.weightKg} onChange={(e) => setEst({ ...est, weightKg: e.target.value })} />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Altura (cm)</span>
              <Input inputMode="numeric" value={est.heightCm} onChange={(e) => setEst({ ...est, heightCm: e.target.value })} />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Atividade</span>
              <select value={est.activity} onChange={(e) => setEst({ ...est, activity: e.target.value as ActivityLevel })} className="h-10 w-full rounded-md border bg-background px-2 text-sm">
                {ACTIVITY_LEVELS.map((a) => (
                  <option key={a} value={a}>
                    {ACTIVITY_LABEL[a]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Button variant="secondary" className="w-full" onClick={calc} disabled={!est.age || !est.weightKg || !est.heightCm}>
            Calcular estimativa
          </Button>
          {estimate && (
            <div className="space-y-3 rounded-xl border bg-background/50 p-3" data-testid="goal-estimate">
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <span>
                  <b className="block text-base tabular-nums">{kcal(estimate.kcal)}</b>kcal
                </span>
                <span>
                  <b className="block text-base tabular-nums">{estimate.protein} g</b>proteínas
                </span>
                <span>
                  <b className="block text-base tabular-nums">{(estimate.waterMl / 1000).toLocaleString('pt-BR')} L</b>água
                </span>
              </div>
              <ul className="space-y-1 text-[11px] text-muted-foreground">
                {estimate.assumptions.map((a) => (
                  <li key={a} className="flex gap-1.5">
                    <Info className="mt-0.5 h-3 w-3 shrink-0" />
                    {a}
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="outline" className="w-full" onClick={useEstimate}>
                Usar como ponto de partida
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Horários preferidos</p>
          <div className="grid grid-cols-2 gap-3">
            {TIME_KINDS.map((k) => (
              <label key={k} className="space-y-1 text-xs">
                <span className="text-muted-foreground">{MEAL_KIND_LABEL[k]}</span>
                <Input type="time" value={times[k] ?? ''} onChange={(e) => setTimes({ ...times, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">Preferências e restrições (a IA respeita)</span>
            <textarea value={prefs} maxLength={500} onChange={(e) => setPrefs(e.target.value)} rows={3} placeholder="Ex.: não como carne de porco, intolerância à lactose" className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
          </label>
        </CardContent>
      </Card>

      <p className="px-1 text-[11px] text-muted-foreground">Estas metas são referências de organização, não uma prescrição. Para orientação individual (condições de saúde, gestação, atletas), procure um nutricionista.</p>
      <Button className="w-full" size="lg" onClick={save} disabled={busy || q.loading} data-testid="save-goals">
        Salvar metas
      </Button>
    </div>
  );
}
