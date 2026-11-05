// Cartão "Alimentação" do Início (Fase 02): calorias e proteína do dia contra a meta e atalho para registrar.
// Não conta dias sem registro como zero: sem refeições, só convida a registrar.
import { Link } from 'react-router-dom';
import { Apple, ChevronRight, Plus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useLifeQuery } from '../life/api';
import { nutritionApi } from './api';
import { MacroBar, kcal } from './ui';

export function NutritionHomeCard() {
  const q = useLifeQuery(() => nutritionApi.day('hoje'));
  const d = q.data?.day;
  const planned = d?.meals.filter((m) => m.status === 'planned').length ?? 0;
  return (
    <Card data-testid="home-nutrition">
      <CardContent className="space-y-3 p-4">
        <Link to="/alimentacao" className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Apple className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Alimentação</span>
            <span className="block text-xs tabular-nums text-muted-foreground">
              {!d ? 'Carregando…' : d.diary.consumedMeals === 0 ? (planned ? `${planned} refeição(ões) planejada(s)` : 'Nada registrado hoje') : `${kcal(d.consumed.kcal)}${d.goals?.kcal ? ` / ${kcal(d.goals.kcal)}` : ''} kcal · ${d.diary.consumedMeals} refeição(ões)`}
            </span>
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Link>
        {d && d.diary.consumedMeals > 0 && <MacroBar macro="protein" value={d.consumed.protein} goal={d.goals?.protein ?? null} compact />}
        <Link to="/alimentacao?registrar=1" className="flex items-center justify-center gap-1 rounded-xl bg-secondary py-2 text-xs font-semibold active:scale-[0.99]">
          <Plus className="h-3.5 w-3.5" />
          Registrar refeição
        </Link>
      </CardContent>
    </Card>
  );
}
