// "Analisar refeição com IA" (Fase 03): Fotografar → Analisar → Revisar → Registrar, numa folha só.
// A foto é preparada no aparelho (redução, orientação, sem metadados), enviada ao irontrack-api SÓ quando a pessoa toca
// em Analisar, e nunca é guardada. O resultado é um rascunho: nada vai para o diário sem "Confirmar e registrar", que
// usa a mesma rota do registro manual (com clientId fixo: tocar duas vezes ou reenviar não duplica).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, Camera, Check, ChevronDown, Droplets, ImagePlus, Info, Loader2, Minus, PenLine, Plus, RefreshCcw, ScanLine, Search, ShieldCheck, Sparkles, X } from 'lucide-react';
import { MEAL_KINDS, MEAL_KIND_LABEL, itemMacros, type FoodView, type MealKind, type MealStatus } from '@shared/nutrition/protocol.ts';
import { PHOTO_NOTICE_VERSION, type PhotoAnalysisView } from '@shared/nutrition/vision.ts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { ApiClientError } from '../../api';
import { useLifeQuery } from '../../life/api';
import { lifeError } from '../../life/forms';
import { newClientId, nutritionApi } from '../api';
import { FoodPicker } from '../MealEditor';
import { KIND_ICON, MacroLine, StateChip, grams, kcal, nowHHMM } from '../ui';
import { canConfirm, fromAnalysis, isComplete, kindByHour, manualItem, replaceFood, reviewTotals, setQuantity, toMealItems, type ReviewItem } from './draft';
import { PhotoPrepError, preparePhoto, type PreparedPhoto } from './image';

type Step = 'pick' | 'preview' | 'analyzing' | 'review';

export interface MealPhotoFlowProps {
  open: boolean;
  date: string;
  today: string;
  onClose: () => void;
  /** Abre o registro manual (sempre disponível, inclusive quando a IA falha). */
  onManual: (o: { date: string; kind?: MealKind }) => void;
}

export function MealPhotoFlow(p: MealPhotoFlowProps) {
  return (
    <Dialog open={p.open} onOpenChange={(o) => !o && p.onClose()}>
      <DialogContent className="gap-3 sm:max-w-xl" data-testid="photo-flow">
        {p.open && <FlowBody {...p} />}
      </DialogContent>
    </Dialog>
  );
}

const errText = (e: unknown) => (e instanceof PhotoPrepError ? e.message : lifeError(e));
const errCode = (e: unknown) => (e instanceof ApiClientError ? e.code : e instanceof PhotoPrepError ? e.code : 'unknown');

function FlowBody({ date, today, onClose, onManual }: MealPhotoFlowProps) {
  const status = useLifeQuery(() => nutritionApi.visionStatus().then((r) => r.vision));
  const [noticeOk, setNoticeOk] = useState(false);
  const [step, setStep] = useState<Step>('pick');
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [analysis, setAnalysis] = useState<PhotoAnalysisView | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const kind0 = useMemo(() => kindByHour(new Date().getHours()), []);

  useEffect(() => () => ctrl.current?.abort(), []);

  const s = status.data;
  const accepted = noticeOk || !!s?.notice.accepted;

  const onFile = async (f: File | undefined | null) => {
    if (!f) return;
    setError(null);
    setPreparing(true);
    try {
      const prepared = await preparePhoto(f);
      setPhoto(prepared);
      setStep('preview');
    } catch (e) {
      setError({ code: errCode(e), message: errText(e) });
    } finally {
      setPreparing(false);
    }
  };

  const analyze = async () => {
    if (!photo) return;
    setError(null);
    setStep('analyzing');
    const c = new AbortController();
    ctrl.current = c;
    try {
      const r = await nutritionApi.analyzePhoto(photo.dataUrl, { note: note.trim() || null, kind: kind0, signal: c.signal });
      setAnalysis(r.analysis);
      setStep('review');
      navigator.vibrate?.(8);
    } catch (e) {
      if (c.signal.aborted) {
        setStep('preview');
        return;
      }
      setError({ code: errCode(e), message: errText(e) });
      setStep('preview');
      if (errCode(e) === 'photo_notice_required') {
        setNoticeOk(false);
        status.reload();
      }
    }
  };

  if (!s) {
    return (
      <>
        <Header />
        {status.error ? (
          <Unavailable message={lifeError(status.error)} onManual={() => onManual({ date })} />
        ) : (
          <div className="flex h-40 items-center justify-center text-muted-foreground">
            <Loader2 className="animate-spin" aria-label="Carregando" />
          </div>
        )}
      </>
    );
  }
  if (!s.available) {
    return (
      <>
        <Header />
        <Unavailable message={s.reason ?? 'A análise de fotos não está disponível agora.'} onManual={() => onManual({ date })} />
      </>
    );
  }
  if (!accepted) return <PhotoNotice onAccept={() => nutritionApi.acceptPhotoNotice(PHOTO_NOTICE_VERSION).then(() => setNoticeOk(true))} onCancel={onClose} />;

  if (step === 'review' && analysis && photo) {
    return <Review analysis={analysis} photo={photo} date={date} today={today} kind0={kind0} onManual={() => onManual({ date, kind: analysis.suggestedKind ?? kind0 })} onRetake={() => { setAnalysis(null); setStep('pick'); setPhoto(null); }} onDone={onClose} />;
  }

  const left = s.limits.photosPerDay - s.usage.photos;
  return (
    <>
      <Header />
      <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} data-testid="photo-camera-input" />
      <input ref={gallery} type="file" accept="image/*,.heic,.heif" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} data-testid="photo-gallery-input" />

      {photo && step !== 'pick' ? (
        <div className="relative overflow-hidden rounded-2xl border bg-black">
          <img src={photo.dataUrl} alt="Foto da refeição" className={cn('mx-auto max-h-[46dvh] w-full object-contain transition-opacity', step === 'analyzing' && 'opacity-80')} data-testid="photo-preview" />
          {step === 'analyzing' && <Scanning />}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          <button type="button" onClick={() => camera.current?.click()} disabled={preparing} className="group flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/15 via-primary/5 to-transparent text-sm font-semibold active:scale-[0.98] disabled:opacity-60" data-testid="photo-take">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30">
              <Camera className="h-6 w-6" />
            </span>
            Tirar foto
          </button>
          <button type="button" onClick={() => gallery.current?.click()} disabled={preparing} className="flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-2xl border bg-card text-sm font-semibold active:scale-[0.98] disabled:opacity-60" data-testid="photo-pick">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
              <ImagePlus className="h-6 w-6" />
            </span>
            Galeria
          </button>
        </div>
      )}

      {preparing && (
        <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Preparando a foto…
        </p>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert" data-testid="photo-error" data-code={error.code}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p className="min-w-0 flex-1">{error.message}</p>
        </div>
      )}

      {step === 'preview' && photo && (
        <>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Algo que a foto não mostra? (opcional: ex. frito no azeite)" className="h-10 text-sm" aria-label="Observação para a análise" />
          <div className="grid grid-cols-[auto_1fr] gap-2">
            <Button variant="outline" onClick={() => { setPhoto(null); setStep('pick'); }} aria-label="Trocar foto">
              <RefreshCcw /> Trocar
            </Button>
            <Button onClick={() => void analyze()} data-testid="photo-analyze">
              <Sparkles /> Analisar
            </Button>
          </div>
        </>
      )}
      {step === 'analyzing' && (
        <Button variant="ghost" onClick={() => ctrl.current?.abort()} data-testid="photo-cancel">
          Cancelar análise
        </Button>
      )}
      {step !== 'analyzing' && (
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <button type="button" onClick={() => onManual({ date })} className="flex items-center gap-1 font-medium text-primary" data-testid="photo-manual">
            <PenLine className="h-3.5 w-3.5" /> Registrar manualmente
          </button>
          <span className="tabular-nums">{left > 0 ? `${left} análise(s) hoje` : 'Limite de hoje atingido'}</span>
        </div>
      )}
    </>
  );
}

function Header() {
  return (
    <DialogHeader>
      <DialogTitle className="flex items-center gap-2">
        <ScanLine className="h-5 w-5 text-primary" /> Analisar refeição
      </DialogTitle>
      <DialogDescription className="text-xs">Fotografe o prato inteiro, de cima, com boa luz.</DialogDescription>
    </DialogHeader>
  );
}

const STAGES = ['Identificando os alimentos…', 'Estimando as porções…', 'Consultando a tabela TACO…', 'Calculando calorias e macros…'];
function Scanning() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => Math.min(x + 1, STAGES.length - 1)), 2200);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="pointer-events-none absolute inset-0" aria-live="polite" data-testid="photo-analyzing">
      <div className="absolute inset-x-0 h-16 animate-scan bg-gradient-to-b from-transparent via-primary/40 to-transparent motion-reduce:animate-none" />
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-3 pb-3 pt-8 text-sm font-medium text-white">
        <Loader2 className="h-4 w-4 animate-spin text-primary" /> {STAGES[i]}
      </div>
    </div>
  );
}

function Unavailable({ message, onManual }: { message: string; onManual: () => void }) {
  return (
    <div className="space-y-3" data-testid="photo-unavailable">
      <p className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" /> {message}
      </p>
      <Button className="w-full" onClick={onManual}>
        <PenLine /> Registrar manualmente
      </Button>
    </div>
  );
}

export function PhotoNotice({ onAccept, onCancel }: { onAccept: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4" data-testid="photo-notice">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" /> Antes da primeira análise
        </DialogTitle>
      </DialogHeader>
      <ul className="space-y-2 text-sm text-muted-foreground">
        <li>• A foto é enviada pelo servidor do IronTrack à <strong className="text-foreground">OpenAI</strong> só quando você toca em <em>Analisar</em>.</li>
        <li>• A foto <strong className="text-foreground">não é guardada</strong> e não vai para o histórico. Localização e dados do aparelho são removidos antes do envio.</li>
        <li>• Só a foto (e a observação que você escrever) é enviada: nada do seu histórico.</li>
        <li>• O resultado é uma estimativa: você revisa tudo antes de registrar.</li>
      </ul>
      <p className="text-xs text-muted-foreground">
        Detalhes em{' '}
        <Link to="/assistente/privacidade" className="text-primary underline underline-offset-2">
          Privacidade
        </Link>
        .
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={onCancel}>
          Agora não
        </Button>
        <Button
          disabled={busy}
          data-testid="photo-notice-accept"
          onClick={async () => {
            setBusy(true);
            try {
              await onAccept();
            } catch (e) {
              toast.error(lifeError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 className="animate-spin" />}
          Entendi, continuar
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ revisão

const CONF_DOT = { alta: 'bg-primary', media: 'bg-amber-400', baixa: 'bg-rose-500' } as const;
const CONF_LABEL = { alta: 'confiança alta', media: 'confiança média', baixa: 'confiança baixa' } as const;

function Review({ analysis, photo, date, today, kind0, onRetake, onDone, onManual }: { analysis: PhotoAnalysisView; photo: PreparedPhoto; date: string; today: string; kind0: MealKind; onRetake: () => void; onDone: () => void; onManual: () => void }) {
  const future = date > today;
  const [items, setItems] = useState<ReviewItem[]>(() => fromAnalysis(analysis));
  const [kind, setKind] = useState<MealKind>(analysis.suggestedKind ?? kind0);
  const [time, setTime] = useState(date === today ? nowHHMM() : '');
  const [status, setStatus] = useState<MealStatus>(future ? 'planned' : 'consumed');
  const [notes, setNotes] = useState('');
  const [picker, setPicker] = useState<{ mode: 'add' } | { mode: 'replace'; key: string; query: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPhoto, setShowPhoto] = useState(false);
  // Um clientId por rascunho: duplo toque, reenvio ou nova tentativa após erro de rede devolvem a MESMA refeição.
  const clientId = useRef(newClientId());
  const t = useMemo(() => reviewTotals(items), [items]);
  const check = canConfirm(items);
  const update = (key: string, fn: (i: ReviewItem) => ReviewItem) => setItems((cur) => cur.map((i) => (i.key === key ? fn(i) : i)));

  if (analysis.status !== 'ok') {
    return (
      <div className="space-y-3" data-testid="photo-result-empty" data-status={analysis.status}>
        <Header />
        <img src={photo.dataUrl} alt="Foto analisada" className="mx-auto max-h-48 rounded-2xl object-contain" />
        <p className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          {analysis.status === 'no_food' ? 'Não encontrei comida nesta foto.' : 'Não consegui identificar os alimentos com segurança (foto desfocada, escura ou cortada).'} Tente outra foto ou registre manualmente.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={onRetake}>
            <Camera /> Outra foto
          </Button>
          <Button onClick={onManual}>
            <PenLine /> Manual
          </Button>
        </div>
      </div>
    );
  }

  const confirm = async () => {
    if (busy || !check.ok) return;
    setBusy(true);
    try {
      await nutritionApi.createMeal({ clientId: clientId.current, date, kind, name: null, time: time || null, status, notes: notes.trim() || null, items: toMealItems(items), origin: 'photo' });
      toast.success(status === 'planned' ? 'Refeição planejada.' : 'Refeição registrada no diário.');
      onDone();
    } catch (e) {
      // O clientId continua o mesmo: tentar de novo não duplica.
      toast.error(`${lifeError(e)} Nada foi duplicado; tente de novo.`);
    } finally {
      setBusy(false);
    }
  };

  const reviewCount = items.filter((i) => i.needsReview || !isComplete(i)).length;
  return (
    <div className="space-y-3" data-testid="photo-review">
      <div className="flex items-center gap-3 pr-8">
        <button type="button" onClick={() => setShowPhoto((v) => !v)} className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl border" aria-label={showPhoto ? 'Ocultar foto' : 'Ver foto'}>
          <img src={photo.dataUrl} alt="" className="h-full w-full object-cover" />
        </button>
        <div className="min-w-0">
          <DialogTitle className="text-base">Revise a refeição</DialogTitle>
          <DialogDescription className="line-clamp-2 text-xs">{analysis.summary}</DialogDescription>
        </div>
      </div>
      {showPhoto && <img src={photo.dataUrl} alt="Foto analisada" className="mx-auto max-h-64 rounded-2xl object-contain" />}

      <div className="rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/[0.12] via-card to-card p-4" data-testid="photo-totals">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">Estimativa da refeição</p>
        <p className="font-display text-3xl font-bold tabular-nums">
          {kcal(t.totals.kcal)} <span className="text-sm font-medium text-muted-foreground">kcal</span>
        </p>
        <div className="mt-2 grid grid-cols-4 gap-1.5 text-center">
          {(
            [
              ['Proteínas', t.totals.protein, 'protein', 'text-sky-400'],
              ['Carbo', t.totals.carbs, 'carbs', 'text-amber-400'],
              ['Gorduras', t.totals.fat, 'fat', 'text-rose-400'],
              ['Fibras', t.totals.fiber, 'fiber', 'text-primary'],
            ] as const
          ).map(([label, v, k, tone]) => (
            <div key={k} className="rounded-xl bg-background/60 px-1 py-1.5">
              <p className={cn('text-sm font-semibold tabular-nums', tone)}>
                {grams(v)}
                <span className="text-[10px] text-muted-foreground"> g</span>
              </p>
              <p className="text-[10px] text-muted-foreground">
                {label}
                {t.missing[k] ? '*' : ''}
              </p>
            </div>
          ))}
        </div>
        <p className="mt-2 flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
          <Info className="mt-px h-3 w-3 shrink-0" />
          <span>
            Estimativa pela foto, calculada com a tabela TACO.
            {Object.keys(t.missing).length > 0 && ' * Algum item não tem este dado na tabela: esse total pode estar subestimado.'}
            {t.pending > 0 && <span className="text-amber-600 dark:text-amber-300"> {t.pending === 1 ? '1 item fora do total.' : `${t.pending} itens fora do total.`}</span>}
          </span>
        </p>
      </div>

      {analysis.calorieNotes.length > 0 && (
        <div className="rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200" data-testid="photo-calorie-notes">
          <p className="flex items-center gap-1 font-semibold">
            <Droplets className="h-3.5 w-3.5" /> Pode mudar as calorias
          </p>
          <ul className="mt-1 space-y-0.5">
            {analysis.calorieNotes.map((n) => (
              <li key={n}>• {n}</li>
            ))}
          </ul>
          <button type="button" onClick={() => setPicker({ mode: 'add' })} className="mt-1 font-semibold text-primary">
            + Adicionar óleo, molho ou outro item
          </button>
        </div>
      )}

      <div className="flex items-center justify-between px-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{items.length} alimento(s)</p>
        {reviewCount > 0 && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">{reviewCount} para revisar</span>}
      </div>
      <ul className="space-y-2" aria-label="Alimentos identificados">
        {items.map((i) => (
          <ReviewRow
            key={i.key}
            item={i}
            onQty={(q) => update(i.key, (x) => setQuantity(x, q))}
            onSwap={(f) => update(i.key, (x) => replaceFood(x, f))}
            onSearch={() => setPicker({ mode: 'replace', key: i.key, query: i.label.replace(/\s*\(.*\)$/, '') })}
            onRemove={() => setItems((c) => c.filter((x) => x.key !== i.key))}
          />
        ))}
      </ul>
      {analysis.uncertain.length > 0 && <p className="px-1 text-[11px] text-muted-foreground">Não identificado com segurança: {analysis.uncertain.join('; ')}.</p>}
      <Button variant="outline" className="w-full" onClick={() => setPicker({ mode: 'add' })} data-testid="photo-add-food">
        <Plus /> Adicionar alimento
      </Button>

      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="radiogroup" aria-label="Tipo de refeição">
        {MEAL_KINDS.filter((k) => k !== 'custom').map((k) => {
          const Icon = KIND_ICON[k];
          return (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors', kind === k ? 'border-primary bg-primary text-primary-foreground' : 'bg-background text-muted-foreground')}>
              <Icon className="h-3.5 w-3.5" />
              {MEAL_KIND_LABEL[k]}
            </button>
          );
        })}
      </div>
      <div className="flex gap-2">
        <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-10 w-32" aria-label="Horário" />
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
      </div>
      <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} placeholder="Observação (opcional: ex. sem sal, frito no azeite)" className="h-10 text-sm" aria-label="Observação da refeição" />

      {!check.ok && <p className="text-center text-xs text-amber-700 dark:text-amber-300" data-testid="photo-confirm-blocked">{check.reason}</p>}
      <div className="sticky bottom-0 -mx-5 -mb-5 grid grid-cols-[auto_1fr] gap-2 border-t bg-popover/95 px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:-mb-5 sm:pb-5">
        <Button variant="outline" onClick={onRetake} disabled={busy} aria-label="Nova foto">
          <Camera />
        </Button>
        <Button onClick={() => void confirm()} disabled={!check.ok || busy} data-testid="photo-confirm">
          {busy ? <Loader2 className="animate-spin" /> : <Check />}
          {status === 'planned' ? 'Confirmar e planejar' : 'Confirmar e registrar'}
        </Button>
      </div>

      {picker && (
        <PickerSheet
          picker={picker}
          onClose={() => setPicker(null)}
          onPick={(f, q) => {
            if (picker.mode === 'replace') update(picker.key, (x) => replaceFood(x, f));
            else setItems((c) => [...c, manualItem(f, q ?? f.portions[0]?.amount ?? 100)]);
            setPicker(null);
          }}
        />
      )}
    </div>
  );
}

function ReviewRow({ item: i, onQty, onSwap, onSearch, onRemove }: { item: ReviewItem; onQty: (q: number) => void; onSwap: (f: FoodView) => void; onSearch: () => void; onRemove: () => void }) {
  const [more, setMore] = useState(false);
  const m = i.food && i.quantity ? itemMacros(i.food.per100, i.quantity) : null;
  const step = i.food?.baseUnit === 'ml' ? 50 : (i.quantity ?? 0) >= 100 ? 10 : 5;
  const flagged = i.needsReview || !isComplete(i);
  return (
    <li className={cn('rounded-xl border bg-background/60 p-2.5', flagged && 'border-amber-500/50')} data-testid="photo-item" data-review={flagged ? '1' : '0'}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            {i.confidence && <span className={cn('h-2 w-2 shrink-0 rounded-full', CONF_DOT[i.confidence])} title={CONF_LABEL[i.confidence]} aria-label={CONF_LABEL[i.confidence]} />}
            <span className="truncate">{i.food ? i.food.name : i.label}</span>
            {i.food && <StateChip food={i.food} />}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {i.fromPhoto && i.food ? `Visto: ${i.label} · ` : ''}
            {m ? (
              <>
                {kcal(m.kcal)} kcal · <MacroLine m={m} />
              </>
            ) : i.food ? (
              'Informe a quantidade'
            ) : (
              'Sem alimento do catálogo'
            )}
          </p>
        </div>
        <button type="button" aria-label={`Remover ${i.food?.name ?? i.label}`} onClick={onRemove} className="rounded-full p-1.5 text-muted-foreground active:bg-accent">
          <X className="h-4 w-4" />
        </button>
      </div>
      {i.warning && (
        <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          {i.warning}
        </p>
      )}
      {i.food ? (
        <div className="mt-2 flex items-center gap-1.5">
          <button type="button" aria-label="Menos" onClick={() => onQty(Math.max(step, (i.quantity ?? step) - step))} className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary">
            <Minus className="h-4 w-4" />
          </button>
          <div className="relative">
            <Input type="number" inputMode="decimal" min={1} step="any" value={i.quantity ?? ''} placeholder="—" onChange={(e) => onQty(Number(e.target.value))} className="h-9 w-24 pr-8 text-right tabular-nums" aria-label={`Quantidade de ${i.food.name} em ${i.food.baseUnit}`} data-testid="photo-qty" />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{i.food.baseUnit}</span>
          </div>
          <button type="button" aria-label="Mais" onClick={() => onQty((i.quantity ?? 0) + step)} className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary">
            <Plus className="h-4 w-4" />
          </button>
          {i.range && <span className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">≈ {i.range.min}–{i.range.max}</span>}
          <button type="button" onClick={() => setMore((v) => !v)} className="ml-auto flex items-center gap-0.5 text-[11px] font-medium text-primary" aria-expanded={more}>
            Trocar <ChevronDown className={cn('h-3 w-3 transition-transform', more && 'rotate-180')} />
          </button>
        </div>
      ) : (
        <Button size="sm" variant="secondary" className="mt-2 w-full" onClick={onSearch}>
          <Search /> Buscar alimento
        </Button>
      )}
      {more && i.food && (
        <div className="mt-2 flex flex-wrap gap-1">
          {i.candidates.map((c) => (
            <button key={c.ref} type="button" onClick={() => { onSwap(c); setMore(false); }} className="max-w-full truncate rounded-full border px-2 py-1 text-[11px] text-muted-foreground active:bg-accent">
              {c.name}
            </button>
          ))}
          <button type="button" onClick={onSearch} className="flex items-center gap-1 rounded-full border border-primary/40 px-2 py-1 text-[11px] font-medium text-primary">
            <Search className="h-3 w-3" /> Buscar outro
          </button>
        </div>
      )}
    </li>
  );
}

function PickerSheet({ picker, onClose, onPick }: { picker: { mode: 'add' } | { mode: 'replace'; query: string }; onClose: () => void; onPick: (f: FoodView, q?: number) => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-3 sm:max-w-lg" data-testid="photo-picker">
        <DialogHeader>
          <DialogTitle>{picker.mode === 'replace' ? 'Trocar alimento' : 'Adicionar alimento'}</DialogTitle>
          <DialogDescription className="text-xs">Não achou? Cadastre pelo rótulo em Alimentação › Alimentos.</DialogDescription>
        </DialogHeader>
        <FoodPicker onPick={onPick} onDone={onClose} count={0} initialQuery={picker.mode === 'replace' ? picker.query : ''} />
      </DialogContent>
    </Dialog>
  );
}
