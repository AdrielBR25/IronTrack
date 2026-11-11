// Registro rápido de refeição (Fase 02): uma folha só, pensada para o celular. Busca com recentes, favoritos,
// mais usados e refeições salvas; tocar adiciona com a quantidade de costume; o total aparece na hora (mesmo cálculo
// do servidor). Serve para registrar, planejar, corrigir e — na Fase 03 — revisar os alimentos sugeridos pela foto
// (itens com `warning`/`confidence` chegam como rascunho e só são salvos depois de conferidos).
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, BookmarkPlus, Check, Copy, Heart, Loader2, Minus, Plus, Search, Star, Trash2, Undo2, X } from 'lucide-react';
import { MEAL_KINDS, MEAL_KIND_LABEL, itemMacros, roundMacros, sumMacros, type FoodView, type MealDraftItem, type MealKind, type MealStatus, type MealView, type Per100, type PortionView, type SavedMealView } from '@shared/nutrition/protocol.ts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { lifeError } from '../life/forms';
import { useLifeQuery } from '../life/api';
import { newClientId, nutritionApi } from './api';
import { KIND_ICON, MacroLine, StateChip, grams, kcal, nowHHMM } from './ui';

interface EditorItem {
  key: string;
  foodRef: string;
  name: string;
  state: FoodView['state'];
  source: FoodView['source'] | null;
  unit: 'g' | 'ml';
  quantity: number;
  per100: Per100;
  portions: PortionView[];
  portionLabel: string | null;
  portionCount: number | null;
  warning: string | null;
}

let seq = 0;
const fromFood = (f: FoodView, quantity: number, warning: string | null = null): EditorItem => {
  const p = f.portions[0];
  const useP = p && quantity === p.amount;
  return { key: `i${++seq}`, foodRef: f.ref, name: f.brand ? `${f.name} (${f.brand})` : f.name, state: f.state, source: f.source, unit: f.baseUnit, quantity, per100: f.per100, portions: f.portions, portionLabel: useP ? p.label : null, portionCount: useP ? 1 : null, warning: warning ?? f.hint };
};

export interface MealEditorTarget {
  date: string;
  /** Refeição existente (editar) ou valores iniciais (nova). */
  meal?: MealView;
  kind?: MealKind;
  status?: MealStatus;
  time?: string | null;
  /** Rascunho para revisão (texto/IA hoje; foto na Fase 03). */
  draft?: MealDraftItem[];
}

export function MealEditor({ target, today, onClose }: { target: MealEditorTarget | null; today: string; onClose: () => void }) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-3 sm:max-w-xl" data-testid="meal-editor">
        {target && <EditorBody key={target.meal?.id ?? `${target.date}-${target.kind}`} target={target} today={today} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function EditorBody({ target, today, onClose }: { target: MealEditorTarget; today: string; onClose: () => void }) {
  const m = target.meal;
  const [kind, setKind] = useState<MealKind>(m?.kind ?? target.kind ?? guessKind());
  const [name, setName] = useState(m?.name ?? '');
  const [time, setTime] = useState(m?.time ?? target.time ?? (target.date === today ? nowHHMM() : ''));
  const [status, setStatus] = useState<MealStatus>(m?.status ?? target.status ?? (target.date > today ? 'planned' : 'consumed'));
  const [items, setItems] = useState<EditorItem[]>(() =>
    m
      ? m.items.map((i) => ({ key: `i${++seq}`, foodRef: i.foodRef, name: i.name, state: i.state, source: null, unit: i.unit, quantity: i.quantity, per100: i.per100, portions: [], portionLabel: i.portionLabel, portionCount: i.portionCount, warning: null }))
      : (target.draft ?? []).filter((d) => d.match).map((d) => fromFood(d.match!, d.quantity ?? d.match!.portions[0]?.amount ?? 100, d.warning)),
  );
  const [picking, setPicking] = useState(!m && !target.draft?.length);
  const [busy, setBusy] = useState<string | null>(null);
  const clientId = useRef(newClientId());
  const totals = useMemo(() => roundMacros(sumMacros(items.map((i) => itemMacros(i.per100, i.quantity)))), [items]);
  const future = target.date > today;

  const add = (f: FoodView, q?: number) => {
    setItems((cur) => [...cur, fromFood(f, q ?? f.portions[0]?.amount ?? 100)]);
    navigator.vibrate?.(6);
  };
  const addSaved = (s: SavedMealView) => {
    setItems((cur) => [...cur, ...s.items.map((i) => ({ key: `i${++seq}`, foodRef: i.foodRef, name: i.name, state: 'other' as const, source: null, unit: i.unit, quantity: i.quantity, per100: i.per100, portions: [], portionLabel: i.portionLabel, portionCount: i.portionCount, warning: null }))]);
    if (kind !== s.kind && !items.length) setKind(s.kind);
    setPicking(false);
  };
  const setQty = (key: string, q: number, portion?: { label: string; count: number }) => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, quantity: Math.max(0, Math.round(q * 10) / 10), portionLabel: portion?.label ?? null, portionCount: portion?.count ?? null, warning: i.warning && !i.warning.startsWith('Confira') ? i.warning : null } : i)));

  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    if (busy) return;
    setBusy(label);
    try {
      await fn();
      if (ok) toast.success(ok);
      onClose();
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(null);
    }
  };

  const valid = items.every((i) => i.quantity > 0) && (items.length > 0 || status === 'planned');
  const payloadItems = items.map((i) => ({ foodRef: i.foodRef, quantity: i.quantity, portionLabel: i.portionLabel, portionCount: i.portionCount }));
  const save = () =>
    run(
      'save',
      () =>
        m
          ? nutritionApi.updateMeal(m.id, m.version, { kind, name: kind === 'custom' ? name.trim() || null : null, time: time || null, items: payloadItems })
          : nutritionApi.createMeal({ clientId: clientId.current, date: target.date, kind, name: kind === 'custom' ? name.trim() || null : null, time: time || null, status, notes: null, items: payloadItems }),
      m ? 'Refeição atualizada.' : status === 'planned' ? 'Refeição planejada.' : 'Refeição registrada.',
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{m ? m.title : status === 'planned' ? 'Planejar refeição' : 'Registrar refeição'}</DialogTitle>
        <DialogDescription className="text-xs">
          {target.date === today ? 'Hoje' : target.date.split('-').reverse().join('/')}
          {m && m.status === 'planned' ? ' · planejada (ainda não conta no consumo)' : ''}
        </DialogDescription>
      </DialogHeader>

      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="radiogroup" aria-label="Tipo de refeição">
        {MEAL_KINDS.map((k) => {
          const Icon = KIND_ICON[k];
          return (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors', kind === k ? 'border-primary bg-primary text-primary-foreground' : 'bg-background text-muted-foreground')}>
              <Icon className="h-3.5 w-3.5" />
              {k === 'custom' ? 'Outra' : MEAL_KIND_LABEL[k]}
            </button>
          );
        })}
      </div>
      <div className="flex gap-2">
        {kind === 'custom' && <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome (ex.: Pré-treino)" maxLength={60} className="h-10 flex-1" aria-label="Nome da refeição" />}
        <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={cn('h-10', kind === 'custom' ? 'w-28' : 'w-32')} aria-label="Horário" />
        {!m && (
          <Segmented<MealStatus>
            size="sm"
            className="flex-1"
            value={status}
            onChange={(v) => (future && v === 'consumed' ? toast.message('Datas futuras só podem ser planejadas.') : setStatus(v))}
            options={[
              { value: 'consumed', label: 'Comi' },
              { value: 'planned', label: 'Planejar' },
            ]}
            aria-label="Consumida ou planejada"
          />
        )}
      </div>

      {picking ? (
        <FoodPicker onPick={add} onSaved={addSaved} onDone={() => setPicking(false)} count={items.length} />
      ) : (
        <div className="space-y-2">
          {items.length === 0 && <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">Nenhum alimento ainda.</p>}
          <ul className="space-y-2" aria-label="Alimentos da refeição">
            {items.map((i) => {
              const t = itemMacros(i.per100, i.quantity);
              const step = i.unit === 'ml' ? 50 : i.quantity >= 100 ? 10 : 5;
              return (
                <li key={i.key} className="rounded-xl border bg-background/60 p-2.5" data-testid="editor-item">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-sm font-medium">
                        <span className="truncate">{i.name}</span>
                        <StateChip food={{ state: i.state, source: i.source ?? { kind: 'taco', label: '' } }} />
                      </p>
                      <p className="text-xs tabular-nums text-muted-foreground">
                        {kcal(t.kcal)} kcal · <MacroLine m={t} />
                      </p>
                    </div>
                    <button type="button" aria-label={`Remover ${i.name}`} onClick={() => setItems((cur) => cur.filter((x) => x.key !== i.key))} className="rounded-full p-1.5 text-muted-foreground active:bg-accent">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  {i.warning && (
                    <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
                      <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                      {i.warning}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-1.5">
                    <button type="button" aria-label="Menos" onClick={() => setQty(i.key, Math.max(step, i.quantity - step))} className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary">
                      <Minus className="h-4 w-4" />
                    </button>
                    <div className="relative">
                      <Input type="number" inputMode="decimal" min={0.1} step="any" value={Number.isFinite(i.quantity) ? i.quantity : ''} onChange={(e) => setQty(i.key, Number(e.target.value))} className="h-9 w-24 pr-8 text-right tabular-nums" aria-label={`Quantidade de ${i.name} em ${i.unit}`} />
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{i.unit}</span>
                    </div>
                    <button type="button" aria-label="Mais" onClick={() => setQty(i.key, i.quantity + step)} className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary">
                      <Plus className="h-4 w-4" />
                    </button>
                    <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
                      {i.portions.map((p) =>
                        [1, 2].map((n) => (
                          <button key={`${p.label}${n}`} type="button" onClick={() => setQty(i.key, p.amount * n, { label: p.label, count: n })} className={cn('shrink-0 rounded-full border px-2 py-1 text-[11px]', i.portionLabel === p.label && i.portionCount === n ? 'border-primary text-primary' : 'text-muted-foreground')} title={p.approximate ? 'Medida caseira aproximada' : 'Porção do rótulo'}>
                            {n} {p.label}
                            {p.approximate ? '≈' : ''}
                          </button>
                        )),
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <Button variant="outline" className="w-full" onClick={() => setPicking(true)} data-testid="add-food">
            <Plus />
            Adicionar alimento
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between rounded-2xl bg-primary/10 px-4 py-3" data-testid="editor-total">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">Total</p>
          <MacroLine m={totals} />
        </div>
        <p className="font-display text-2xl font-bold tabular-nums">
          {kcal(totals.kcal)} <span className="text-sm font-medium text-muted-foreground">kcal</span>
        </p>
      </div>

      {m && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {m.status === 'planned' ? (
            <Button variant="secondary" size="sm" disabled={!!busy || !m.items.length} onClick={() => run('consume', () => nutritionApi.consume(m.id, m.version, time || nowHHMM()), 'Marcada como consumida.')}>
              <Check />
              Comi
            </Button>
          ) : (
            <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => run('unconsume', () => nutritionApi.unconsume(m.id, m.version), 'Voltou para planejada.')}>
              <Undo2 />
              Planejada
            </Button>
          )}
          <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => run('dup', () => nutritionApi.duplicate(m.id, m.date > today ? {} : { date: today, status: 'consumed' }), 'Refeição repetida.')}>
            <Copy />
            Repetir
          </Button>
          <Button variant="secondary" size="sm" disabled={!!busy || !m.items.length} onClick={() => run('fav', () => nutritionApi.saveMeal(m.name ?? `${MEAL_KIND_LABEL[m.kind]} favorito`, m.kind, m.id), 'Salva nas refeições favoritas.')}>
            <BookmarkPlus />
            Favoritar
          </Button>
          <Button variant="secondary" size="sm" className="text-destructive" disabled={!!busy} onClick={() => run('del', () => nutritionApi.deleteMeal(m.id), 'Refeição excluída.')}>
            <Trash2 />
            Excluir
          </Button>
        </div>
      )}

      <DialogFooter>
        {picking && items.length > 0 ? (
          <Button onClick={() => setPicking(false)}>Revisar {items.length} alimento(s)</Button>
        ) : (
          <Button onClick={save} disabled={!valid || !!busy} data-testid="save-meal">
            {busy === 'save' && <Loader2 className="animate-spin" />}
            {m ? 'Salvar alterações' : status === 'planned' ? 'Planejar' : 'Registrar'}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function guessKind(): MealKind {
  const h = new Date().getHours();
  return h < 10 ? 'breakfast' : h < 15 ? 'lunch' : h < 18 ? 'snack' : h < 22 ? 'dinner' : 'supper';
}

type Tab = 'recent' | 'fav' | 'saved';

/** Busca de alimentos (exportada para a revisão da foto, Fase 03: sem a aba de refeições salvas quando `onSaved` falta). */
export function FoodPicker({ onPick, onSaved, onDone, count, initialQuery = '', doneLabel }: { onPick: (f: FoodView, q?: number) => void; onSaved?: (s: SavedMealView) => void; onDone: () => void; count: number; initialQuery?: string; doneLabel?: string }) {
  const [q, setQ] = useState(initialQuery);
  const [tab, setTab] = useState<Tab>('recent');
  const [results, setResults] = useState<FoodView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const quick = useLifeQuery(() => nutritionApi.quick().then((r) => r.quick));
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      return;
    }
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      nutritionApi
        .search(term)
        .then((r) => alive && setResults(r.foods))
        .catch(() => alive && setResults([]))
        .finally(() => alive && setLoading(false));
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);
  const qd = quick.data;
  const lastQ = new Map((qd?.frequentFoods ?? []).map((f) => [f.ref, f.lastQuantity]));
  const list: FoodView[] = results ?? (tab === 'recent' ? [...(qd?.frequentFoods ?? []), ...(qd?.recentFoods ?? [])].filter((f, i, a) => a.findIndex((x) => x.ref === f.ref) === i) : tab === 'fav' ? (qd?.favoriteFoods ?? []) : []);
  return (
    <div className="space-y-2" data-testid="food-picker">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar alimento (ex.: arroz cozido)" className="h-11 pl-9" aria-label="Buscar alimento" />
        {loading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
      </div>
      {!results && (
        <Segmented<Tab>
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'recent', label: 'Recentes' },
            { value: 'fav', label: 'Favoritos' },
            ...(onSaved ? [{ value: 'saved' as const, label: 'Refeições' }] : []),
          ]}
          aria-label="Atalhos"
        />
      )}
      <div className="max-h-[42dvh] space-y-1 overflow-y-auto">
        {!results && tab === 'saved' ? (
          qd?.savedMeals.length ? (
            qd.savedMeals.map((s) => (
              <button key={s.id} type="button" onClick={() => onSaved?.(s)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left active:bg-accent">
                <Star className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{s.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{s.items.map((i) => i.name.split(',')[0]).join(', ')}</span>
                </span>
                <span className="text-xs font-semibold tabular-nums">{kcal(s.totals.kcal)} kcal</span>
              </button>
            ))
          ) : (
            <p className="p-4 text-center text-xs text-muted-foreground">Abra uma refeição registrada e toque em “Favoritar” para reutilizá-la aqui.</p>
          )
        ) : list.length ? (
          list.map((f) => <FoodRow key={f.ref} f={f} onPick={() => onPick(f, lastQ.get(f.ref))} />)
        ) : (
          <p className="p-4 text-center text-xs text-muted-foreground">{results ? 'Nada encontrado. Tente outro nome ou cadastre pelo rótulo em Alimentação → Alimentos.' : tab === 'fav' ? 'Toque no coração de um alimento para favoritá-lo.' : 'Busque um alimento: os que você registrar aparecem aqui.'}</p>
        )}
      </div>
      {count > 0 && (
        <button type="button" onClick={onDone} className="w-full text-center text-xs font-medium text-primary">
          {doneLabel ?? `${count} alimento(s) na refeição · revisar`}
        </button>
      )}
    </div>
  );
}

function FoodRow({ f, onPick }: { f: FoodView; onPick: () => void }) {
  const [fav, setFav] = useState(f.favorite);
  return (
    <div className="flex items-center gap-1 rounded-xl active:bg-accent" data-testid="food-result">
      <button type="button" onClick={onPick} className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2.5 text-left">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{f.brand ? `${f.name} (${f.brand})` : f.name}</span>
            <StateChip food={f} />
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {kcal(f.per100.kcal)} kcal · P {grams(f.per100.protein ?? 0)} · C {grams(f.per100.carbs ?? 0)} · G {grams(f.per100.fat ?? 0)} por 100 {f.baseUnit} · {f.source.kind === 'taco' ? 'TACO' : f.source.kind === 'custom' ? 'meu' : 'genérico'}
          </span>
        </span>
        <Plus className="h-5 w-5 shrink-0 text-primary" />
      </button>
      <button
        type="button"
        aria-label={fav ? 'Remover dos favoritos' : 'Favoritar'}
        aria-pressed={fav}
        onClick={() => {
          setFav(!fav);
          nutritionApi.favorite(f.ref, !fav).catch(() => setFav(fav));
        }}
        className="rounded-full p-2"
      >
        <Heart className={cn('h-4 w-4', fav ? 'fill-rose-500 text-rose-500' : 'text-muted-foreground')} />
      </button>
    </div>
  );
}
