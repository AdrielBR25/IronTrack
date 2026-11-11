// Alimentos (Fase 02): busca no catálogo (TACO 4ª ed. + modelos genéricos marcados como não oficiais), favoritos,
// alimentos próprios cadastrados a partir do rótulo e refeições salvas. Cru, cozido e preparado aparecem separados.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Archive, ArrowLeft, Plus, Search, Star, Trash2 } from 'lucide-react';
import { FOOD_STATES, FOOD_STATE_LABEL, MEAL_KIND_LABEL, itemMacros, type FoodState, type FoodView } from '@shared/nutrition/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { nutritionApi } from './api';
import { MacroLine, StateChip, kcal } from './ui';

type Tab = 'search' | 'mine' | 'saved';

export default function FoodsPage() {
  const [tab, setTab] = useState<Tab>('search');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [form, setForm] = useState<FoodView | 'new' | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const results = useLifeQuery(() => (debounced.length >= 2 ? nutritionApi.search(debounced, 40).then((r) => r.foods) : nutritionApi.quick().then((r) => r.quick.favoriteFoods)), [debounced]);
  const mine = useLifeQuery(() => (tab === 'mine' ? nutritionApi.myFoods().then((r) => r.foods) : Promise.resolve([] as FoodView[])), [tab]);
  const saved = useLifeQuery(() => (tab === 'saved' ? nutritionApi.savedMeals().then((r) => r.savedMeals) : Promise.resolve([])), [tab]);

  const fav = async (f: FoodView) => {
    try {
      await nutritionApi.favorite(f.ref, !f.favorite);
    } catch (e) {
      toast.error(lifeError(e));
    }
  };

  return (
    <div className="space-y-4 pb-10" data-testid="nutrition-foods">
      <PageHeader
        title="Alimentos"
        action={
          <Link to="/alimentacao" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar para Alimentação">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      <div className="flex gap-1 rounded-xl bg-secondary p-1">
        {(
          [
            ['search', 'Catálogo'],
            ['mine', 'Meus alimentos'],
            ['saved', 'Refeições salvas'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={cn('flex-1 rounded-lg py-1.5 text-xs font-medium', tab === k ? 'bg-background shadow' : 'text-muted-foreground')}>
            {l}
          </button>
        ))}
      </div>

      {tab === 'search' && (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar: arroz cozido, frango grelhado, banana…" className="pl-9" aria-label="Buscar alimento" />
          </div>
          {debounced.length < 2 && <p className="px-1 text-xs text-muted-foreground">Favoritos aparecem aqui. Digite para buscar no catálogo.</p>}
          <FoodList foods={results.data ?? []} onFav={fav} empty={debounced.length >= 2 ? 'Nada encontrado. Cadastre o alimento a partir do rótulo.' : 'Nenhum favorito ainda.'} />
          <p className="px-1 text-[11px] text-muted-foreground">Fonte principal: Tabela Brasileira de Composição de Alimentos (TACO 4ª ed., NEPA/UNICAMP). Itens “modelo genérico” não são oficiais: confira o rótulo do produto.</p>
        </>
      )}

      {tab === 'mine' && (
        <>
          <Button className="w-full" onClick={() => setForm('new')} data-testid="new-food">
            <Plus className="mr-1 h-4 w-4" />
            Cadastrar alimento do rótulo
          </Button>
          <FoodList foods={mine.data ?? []} onFav={fav} onEdit={(f) => setForm(f)} empty="Você ainda não cadastrou alimentos." />
        </>
      )}

      {tab === 'saved' && (
        <Card className="divide-y divide-border/60">
          {(saved.data ?? []).length === 0 && <CardContent className="p-4 text-sm text-muted-foreground">Salve uma refeição pelo editor (botão Favoritar) para repetir com um toque.</CardContent>}
          {(saved.data ?? []).map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{s.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {MEAL_KIND_LABEL[s.kind]} · {kcal(s.totals.kcal)} kcal · usada {s.useCount}×
                </p>
              </div>
              <button
                type="button"
                aria-label={`Excluir ${s.name}`}
                onClick={async () => {
                  try {
                    await nutritionApi.deleteSaved(s.id);
                    toast.success('Refeição salva excluída.');
                  } catch (e) {
                    toast.error(lifeError(e));
                  }
                }}
                className="rounded-lg p-2 text-muted-foreground active:bg-accent"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </Card>
      )}

      <FoodForm target={form} onClose={() => setForm(null)} />
    </div>
  );
}

function FoodList({ foods, onFav, onEdit, empty }: { foods: FoodView[]; onFav: (f: FoodView) => void; onEdit?: (f: FoodView) => void; empty: string }) {
  if (!foods.length) return <p className="px-1 py-6 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <Card className="divide-y divide-border/60">
      {foods.map((f) => (
        <div key={f.ref} className="flex items-start gap-2 px-3 py-2.5" data-testid="food-row">
          <button type="button" onClick={() => onEdit?.(f)} className={cn('min-w-0 flex-1 text-left', !onEdit && 'cursor-default')}>
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">
                {f.name}
                {f.brand ? <span className="text-muted-foreground"> · {f.brand}</span> : null}
              </span>
              <StateChip food={f} />
            </span>
            <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
              {kcal(f.per100.kcal)} kcal / 100 {f.baseUnit} · <MacroLine m={itemMacros(f.per100, 100)} />
            </span>
            <span className="block truncate text-[11px] text-muted-foreground/80">{f.source.label}</span>
            {f.hint && <span className="block text-[11px] text-amber-600 dark:text-amber-400">{f.hint}</span>}
          </button>
          <button type="button" onClick={() => onFav(f)} aria-label={f.favorite ? 'Remover dos favoritos' : 'Favoritar'} className="rounded-lg p-2 active:bg-accent">
            <Star className={cn('h-4 w-4', f.favorite ? 'fill-primary text-primary' : 'text-muted-foreground')} />
          </button>
        </div>
      ))}
    </Card>
  );
}

const EMPTY = { name: '', brand: '', state: 'packaged' as FoodState, baseUnit: 'g' as 'g' | 'ml', kcal: '', protein: '', carbs: '', fat: '', fiber: '', portionLabel: '', portionAmount: '', sourceNote: '' };
const dec = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));

/** Cadastro a partir do rótulo: valores por 100 g/ml. A pessoa informa; o app não inventa números. */
function FoodForm({ target, onClose }: { target: FoodView | 'new' | null; onClose: () => void }) {
  const [f, setF] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const editing = target && target !== 'new' ? target : null;
  useEffect(() => {
    if (!target) return;
    if (target === 'new') setF(EMPTY);
    else {
      const p = target.portions[0];
      setF({ name: target.name, brand: target.brand ?? '', state: target.state, baseUnit: target.baseUnit, kcal: String(target.per100.kcal), protein: target.per100.protein == null ? '' : String(target.per100.protein), carbs: target.per100.carbs == null ? '' : String(target.per100.carbs), fat: target.per100.fat == null ? '' : String(target.per100.fat), fiber: target.per100.fiber == null ? '' : String(target.per100.fiber), portionLabel: p?.label ?? '', portionAmount: p ? String(p.amount) : '', sourceNote: target.custom?.sourceNote ?? '' });
    }
  }, [target]);
  const body = {
    name: f.name.trim(),
    brand: f.brand.trim() || null,
    state: f.state,
    kcal: dec(f.kcal) ?? 0,
    protein: dec(f.protein) ?? 0,
    carbs: dec(f.carbs) ?? 0,
    fat: dec(f.fat) ?? 0,
    fiber: dec(f.fiber),
    portionLabel: f.portionLabel.trim() || null,
    portionAmount: dec(f.portionAmount),
    sourceNote: f.sourceNote.trim() || null,
  };
  const valid = body.name && f.kcal.trim() !== '' && f.protein.trim() !== '' && f.carbs.trim() !== '' && f.fat.trim() !== '';
  const save = async () => {
    setBusy(true);
    try {
      if (editing?.custom) await nutritionApi.updateFood(editing.custom.id, editing.custom.version, body);
      else await nutritionApi.createFood({ ...body, baseUnit: f.baseUnit });
      toast.success(editing ? 'Alimento atualizado.' : 'Alimento cadastrado.');
      onClose();
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    if (!editing?.custom) return;
    setBusy(true);
    try {
      await nutritionApi.updateFood(editing.custom.id, editing.custom.version, { archived: true });
      toast.success('Alimento arquivado. Refeições antigas continuam com os valores salvos.');
      onClose();
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  const num = (k: 'kcal' | 'protein' | 'carbs' | 'fat' | 'fiber', label: string) => (
    <label className="space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Input inputMode="decimal" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} aria-label={label} />
    </label>
  );
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto" data-testid="food-form">
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar alimento' : 'Alimento do rótulo'}</DialogTitle>
        </DialogHeader>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Nome</span>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Nome" />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Marca (opcional)</span>
          <Input value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} />
        </label>
        <div className="flex flex-wrap gap-1.5">
          {FOOD_STATES.map((s) => (
            <button key={s} type="button" onClick={() => setF({ ...f, state: s })} className={cn('rounded-full border px-3 py-1 text-xs', f.state === s ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground')}>
              {FOOD_STATE_LABEL[s] || 'Outro'}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {(['g', 'ml'] as const).map((u) => (
            <button key={u} type="button" disabled={!!editing} onClick={() => setF({ ...f, baseUnit: u })} className={cn('flex-1 rounded-xl border py-2 text-sm disabled:opacity-60', f.baseUnit === u ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground')}>
              Valores por 100 {u}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {num('kcal', 'Energia (kcal)')}
          {num('protein', 'Proteínas (g)')}
          {num('carbs', 'Carboidratos (g)')}
          {num('fat', 'Gorduras totais (g)')}
          {num('fiber', 'Fibras (g, opcional)')}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Porção (ex.: 1 scoop)</span>
            <Input value={f.portionLabel} onChange={(e) => setF({ ...f, portionLabel: e.target.value })} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Porção em {f.baseUnit}</span>
            <Input inputMode="decimal" value={f.portionAmount} onChange={(e) => setF({ ...f, portionAmount: e.target.value })} />
          </label>
        </div>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Fonte (ex.: rótulo, lote)</span>
          <Input value={f.sourceNote} onChange={(e) => setF({ ...f, sourceNote: e.target.value })} />
        </label>
        <p className="text-[11px] text-muted-foreground">Rótulos costumam trazer valores por porção: converta para 100 {f.baseUnit} (valor ÷ porção × 100).</p>
        <DialogFooter className="gap-2">
          {editing?.custom && (
            <Button variant="outline" onClick={archive} disabled={busy}>
              <Archive className="mr-1 h-4 w-4" />
              Arquivar
            </Button>
          )}
          <Button onClick={save} disabled={busy || !valid} data-testid="save-food">
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
