import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Camera, FileJson, FileText, Info, Loader2, Minus, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { db } from '@/db/db';
import { deleteBodyEntry, deletePhoto, saveBodyEntry, saveBodyEntryWithPhotos } from '@/db/repo';
import type { BodyEntry } from '@/lib/types';
import {
  parseBodyJson,
  BODY_METRICS,
  evolutionSummary,
  metricByKey,
  metricChanges,
  skinfoldChanges,
  type BodyMetricKey,
  type MetricChange,
  evaluationToEntry,
  extractPdfItems,
  newMonthsOnly,
  parseAnthropometricItems,
} from '@/modules/body';
import { fmtNum, parseNum, readFileText, uid } from '@/lib/utils';
import { fmtDateShort, fromISODate, todayISO } from '@/lib/dates';
import { useUnits } from '@/hooks/useUnits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm';
import { ChartCard, DeltaBars, StackChart, TrendChart } from '@/components/charts';
import { cn } from '@/lib/utils';
import { BodyMap } from './BodyMap';

const KG_KEYS = new Set<BodyMetricKey>(['weightKg', 'fatMassKg', 'leanMassKg']);
const monthFmt = new Intl.DateTimeFormat('pt-BR', { month: 'short', year: '2-digit' });
const monthLabel = (iso: string) => monthFmt.format(fromISODate(iso)).replace('.', '').replace(' de ', '/');

async function compressImage(file: File, max = 1080): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function EntryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { unit, parse } = useUnits();
  const [f, setF] = useState<Record<string, string>>({ date: todayISO() });
  const [photos, setPhotos] = useState<string[]>([]);
  const photoRef = useRef<HTMLInputElement>(null);
  const num = (k: string) => (f[k]?.trim() ? parseNum(f[k]) : null);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setF({ date: todayISO() });
          setPhotos([]);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova avaliação</DialogTitle>
          <DialogDescription>Preencha só o que mediu. Valores são estimativas.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const w = num('weight');
            const entry: BodyEntry = {
              id: uid(),
              date: f.date || todayISO(),
              weightKg: w === null ? null : parse(w),
              bodyFatPct: num('fat'),
              waistCm: num('waist'),
              abdomenCm: num('abdomen'),
              armCm: num('arm'),
              thighCm: num('thigh'),
              source: 'manual',
              notes: f.notes?.trim() || undefined,
              createdAt: Date.now(),
            };
            await saveBodyEntryWithPhotos(entry, photos);
            toast.success('Avaliação salva');
            setF({ date: todayISO() });
            setPhotos([]);
            onOpenChange(false);
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="b-date">Data</Label>
              <Input id="b-date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
            </div>
            {[
              ['weight', `Peso (${unit})`],
              ['fat', '% gordura'],
              ['waist', 'Cintura (cm)'],
              ['abdomen', 'Abdômen (cm)'],
              ['arm', 'Braço (cm)'],
              ['thigh', 'Coxa (cm)'],
            ].map(([k, l]) => (
              <div key={k} className="space-y-1.5">
                <Label htmlFor={`b-${k}`}>{l}</Label>
                <Input id={`b-${k}`} inputMode="decimal" value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
              </div>
            ))}
          </div>
          <Textarea placeholder="Observações (opcional)" value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          <div className="flex flex-wrap items-center gap-2">
            {photos.map((p, i) => (
              <img key={i} src={p} alt="" className="h-16 w-16 rounded-xl object-cover" />
            ))}
            <Button variant="outline" size="sm" onClick={() => photoRef.current?.click()}>
              <Camera /> Foto de progresso
            </Button>
            <input
              ref={photoRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) setPhotos([...photos, await compressImage(file)]);
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">Fotos ficam somente neste aparelho (e no backup que você exportar).</p>
          <DialogFooter>
            <Button type="submit" size="lg">
              Salvar avaliação
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${26 - ((v - min) / span) * 22}`).join(' ');
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className={cn('h-7 w-full', className)} aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function ChangeTile({ c, value }: { c: MetricChange; value: (k: BodyMetricKey, v: number) => string }) {
  const tone = c.verdict === 'better' ? 'text-primary' : c.verdict === 'worse' ? 'text-warn' : 'text-muted-foreground';
  const Icon = c.verdict === 'same' ? Minus : c.delta < 0 ? ArrowDownRight : ArrowUpRight;
  const sign = c.delta > 0 ? '+' : c.delta < 0 ? '−' : '';
  return (
    <div className="rounded-2xl border bg-background/40 p-3" data-testid={`tile-${c.metric.key}`}>
      <p className="truncate text-xs text-muted-foreground">{c.metric.short}</p>
      <p className="font-display text-lg font-bold tabular">{value(c.metric.key, c.last)}</p>
      <p className={cn('flex items-center gap-0.5 text-xs font-semibold tabular', tone)}>
        <Icon className="h-3.5 w-3.5" />
        {sign}
        {value(c.metric.key, Math.abs(c.delta))}
      </p>
      <Sparkline values={c.series.map((s) => s.v)} className={cn('mt-1', tone)} />
    </div>
  );
}

export function BodySection() {
  const entries = useLiveQuery(() => db.bodyEntries.orderBy('date').toArray(), []);
  const photos = useLiveQuery(() => db.photos.toArray(), []);
  const { unit, show } = useUnits();
  const [metric, setMetric] = useState<BodyMetricKey>('bodyFatPct');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState<BodyEntry | null>(null);
  const [viewPhoto, setViewPhoto] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  const list = entries ?? [];
  const conv = (k: BodyMetricKey, v: number) => (KG_KEYS.has(k) ? (show(v) ?? v) : v);
  const unitOf = (k: BodyMetricKey) => (KG_KEYS.has(k) ? unit : metricByKey(k).unit);
  const value = (k: BodyMetricKey, v: number) => `${fmtNum(conv(k, v), metricByKey(k).digits)}${unitOf(k) ? ` ${unitOf(k)}` : ''}`;

  const changes = metricChanges(list);
  const summary = evolutionSummary(changes);
  const folds = skinfoldChanges(list);
  const available = BODY_METRICS.filter((m) => list.some((e) => typeof e[m.key] === 'number'));
  const current = available.find((m) => m.key === metric) ?? available[0] ?? metricByKey('weightKg');
  const data = list.filter((e) => typeof e[current.key] === 'number').map((e) => ({ t: fromISODate(e.date).getTime(), v: conv(current.key, e[current.key] as number) }));
  const comp = list
    .filter((e) => typeof e.fatMassKg === 'number' && typeof e.leanMassKg === 'number')
    .map((e) => ({ t: e.date, a: conv('leanMassKg', e.leanMassKg!), b: conv('fatMassKg', e.fatMassKg!) }));
  const withData = list.filter((e) => BODY_METRICS.some((m) => typeof e[m.key] === 'number'));
  const tableCols = withData.slice(-4);
  const tableRows = available.filter((m) => tableCols.filter((e) => typeof e[m.key] === 'number').length >= 1);
  const firstDate = changes[0]?.series[0].date;
  const lastDate = changes[0]?.series[changes[0].series.length - 1].date;
  const tileKeys: BodyMetricKey[] = ['bodyFatPct', 'fatMassKg', 'leanMassKg', 'weightKg', 'waistCm', 'abdomenCm', 'armCm', 'thighCm', 'skinfoldSumMm', 'armMuscleArea'];
  const tiles = tileKeys.map((k) => changes.find((c) => c.metric.key === k)).filter((c): c is MetricChange => !!c);

  async function importPdf(file: File) {
    setBusy(true);
    const id = toast.loading('Lendo o PDF…');
    try {
      const items = await extractPdfItems(await file.arrayBuffer());
      const r = parseAnthropometricItems(items);
      if (!r.ok) {
        toast.error('Não consegui ler este PDF', { id, description: r.error, duration: 10000 });
        return;
      }
      const { fresh, skipped } = newMonthsOnly(r.evaluations, await db.bodyEntries.toArray());
      const now = Date.now();
      await db.bodyEntries.bulkPut(fresh.map((e) => evaluationToEntry(e, now)));
      const months = (xs: { date: string }[]) => xs.map((x) => monthLabel(x.date)).join(', ');
      if (!fresh.length) {
        toast.info('Nada novo neste PDF', { id, description: `Os meses ${months(skipped)} já estão no app.`, duration: 8000 });
      } else {
        toast.success(`${fresh.length} ${fresh.length === 1 ? 'avaliação importada' : 'avaliações importadas'}`, {
          id,
          description: `Novos: ${months(fresh)}.${skipped.length ? ` Já existiam: ${months(skipped)}.` : ''}`,
          duration: 8000,
        });
        setMetric('bodyFatPct');
      }
    } catch (err) {
      console.error(err);
      toast.error('Não consegui abrir o PDF', { id, description: 'Confira se o arquivo não está protegido por senha ou corrompido.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
        <Button onClick={() => pdfRef.current?.click()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <FileText />} Importar PDF
        </Button>
        <Button variant="outline" onClick={() => setOpen(true)}>
          <Plus /> Nova
        </Button>
        <Button variant="outline" size="icon" aria-label="Importar JSON" title="Importar avaliações em JSON" onClick={() => fileRef.current?.click()}>
          <FileJson />
        </Button>
        <input
          ref={pdfRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          data-testid="pdf-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void importPdf(file);
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            const r = parseBodyJson(await readFileText(file));
            if (!r.ok) {
              toast.error('Arquivo de avaliações inválido', { description: r.errors.join('\n'), duration: 10000 });
              return;
            }
            const existing = new Set(list.map((x) => `${x.date}|${x.weightKg ?? ''}`));
            let added = 0;
            for (const x of r.value) {
              if (existing.has(`${x.date}|${x.weightKg ?? ''}`)) continue;
              await saveBodyEntry({ ...x, source: 'json' });
              added++;
            }
            toast.success(`${added} avaliação(ões) importada(s)`, { description: added < r.value.length ? 'Duplicadas foram ignoradas.' : undefined });
          }}
        />
      </div>

      {list.length === 0 && (
        <Card className="space-y-1 p-4 text-sm">
          <p className="font-semibold">Acompanhe sua composição corporal</p>
          <p className="text-muted-foreground">
            Importe o PDF do <strong>relatório comparativo antropométrico</strong> da sua nutricionista. O app lê todas as datas e, nos próximos PDFs, adiciona apenas os meses que ainda
            não estão aqui.
          </p>
        </Card>
      )}

      {tiles.length > 0 && (
        <Card className="space-y-3 p-4" data-testid="body-evolution">
          <div>
            <h3 className="font-display text-lg font-bold">Sua evolução</h3>
            <p className="text-xs text-muted-foreground">
              {fmtDateShort(firstDate!)} {firstDate!.slice(0, 4) !== lastDate!.slice(0, 4) && firstDate!.slice(0, 4)} → {fmtDateShort(lastDate!)} {lastDate!.slice(0, 4)} ·{' '}
              {withData.length} avaliações
            </p>
          </div>
          {summary && <p className="text-sm leading-relaxed">{summary}</p>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {tiles.map((c) => (
              <ChangeTile key={c.metric.key} c={c} value={value} />
            ))}
          </div>
          <p className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-primary" /> melhorou
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-warn" /> piorou
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-muted-foreground" /> depende do objetivo
            </span>
          </p>
        </Card>
      )}

      <BodyMap entries={list} />

      {comp.length >= 2 && (
        <ChartCard title="Massa magra × massa gorda" description="Do que é feito o seu peso em cada avaliação">
          <StackChart data={comp} aLabel="Massa magra" bLabel="Massa gorda" fmt={(v) => `${fmtNum(v, 1)} ${unit}`} xFmt={(t) => monthLabel(String(t))} />
        </ChartCard>
      )}

      {folds.length > 0 && (
        <ChartCard title="Onde a gordura mais baixou" description={`Dobras cutâneas (mm), ${fmtDateShort(firstDate ?? list[0].date)} → ${fmtDateShort(lastDate ?? list[list.length - 1].date)}`}>
          <DeltaBars data={folds.map((f) => ({ name: f.site, v: Math.round(f.delta * 10) / 10 }))} fmt={(v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtNum(Math.abs(v), 1)}`} />
        </ChartCard>
      )}

      {available.length > 0 && (
        <ChartCard
          title={current.label}
          description={data.length ? `${data.length} registros` : undefined}
          action={
            <select
              aria-label="Medida"
              className="h-9 max-w-[9.5rem] rounded-lg border bg-background px-2 text-sm"
              value={current.key}
              onChange={(e) => setMetric(e.target.value as BodyMetricKey)}
            >
              {(['Composição', 'Circunferências', 'Índices'] as const).map((g) => {
                const opts = available.filter((m) => m.group === g);
                return opts.length ? (
                  <optgroup key={g} label={g}>
                    {opts.map((x) => (
                      <option key={x.key} value={x.key}>
                        {x.label}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          }
        >
          <TrendChart data={data} x="t" y="v" fmt={(v) => `${fmtNum(v, current.digits)}${unitOf(current.key) ? ` ${unitOf(current.key)}` : ''}`} xFmt={(t) => fmtDateShort(Number(t))} />
        </ChartCard>
      )}

      {tableCols.length >= 2 && (
        <Card className="p-0">
          <div className="px-4 pt-4">
            <h3 className="font-semibold">Comparativo</h3>
            <p className="text-xs text-muted-foreground">Últimas {tableCols.length} avaliações</p>
          </div>
          <div className="overflow-x-auto px-2 pb-3 pt-2">
            <table className="w-full text-xs tabular">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="px-2 py-1.5 text-left font-medium">Medida</th>
                  {tableCols.map((e) => (
                    <th key={e.id} className="px-1.5 py-1.5 text-right font-medium">
                      {monthLabel(e.date)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableRows.map((m) => (
                  <tr key={m.key} className="border-t border-border/60">
                    <td className="px-2 py-1.5 text-left">
                      {m.short}
                      {unitOf(m.key) && <span className="text-muted-foreground"> ({unitOf(m.key)})</span>}
                    </td>
                    {tableCols.map((e) => {
                      const v = e[m.key];
                      return (
                        <td key={e.id} className="px-1.5 py-1.5 text-right">
                          {typeof v === 'number' ? fmtNum(conv(m.key, v), m.digits) : '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="flex gap-2 p-3 text-xs text-muted-foreground">
        <Info className="h-4 w-4 shrink-0" />
        <p>
          Percentual de gordura e medidas são <strong>estimativas</strong> e variam com o método, o avaliador e o horário. Massa magra inclui água, ossos e órgãos: não é sinônimo de
          massa muscular. Verde/laranja indicam a direção geralmente desejada, não um diagnóstico.
        </p>
      </Card>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Registros</h3>
        {list.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma avaliação registrada.</p>}
        {[...list].reverse().map((e) => {
          const ph = (photos ?? []).filter((p) => p.entryId === e.id);
          const parts = [
            e.weightKg != null && `${fmtNum(show(e.weightKg), 1)} ${unit}`,
            e.bodyFatPct != null && `${fmtNum(e.bodyFatPct, 1)}% gord.`,
            e.leanMassKg != null && `magra ${fmtNum(show(e.leanMassKg), 1)}`,
            e.waistCm != null && `cintura ${fmtNum(e.waistCm, 1)}`,
            e.abdomenCm != null && `abd. ${fmtNum(e.abdomenCm, 1)}`,
            e.armCm != null && `braço ${fmtNum(e.armCm, 1)}`,
            e.thighCm != null && `coxa ${fmtNum(e.thighCm, 1)}`,
          ].filter(Boolean);
          return (
            <Card key={e.id} className="flex items-center gap-3 p-3" data-testid="body-entry">
              <div className="w-14 shrink-0 text-center">
                <p className="font-display font-bold">{fmtDateShort(e.date)}</p>
                <p className="text-[10px] text-muted-foreground">{e.date.slice(0, 4)}</p>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm tabular">{parts.join(' · ') || '—'}</p>
                {e.source === 'pdf' && <p className="text-[11px] text-muted-foreground">Importado do PDF{e.skinfolds ? ` · ${Object.keys(e.skinfolds).length} dobras` : ''}</p>}
                {e.notes && <p className="truncate text-xs text-muted-foreground">{e.notes}</p>}
                {ph.length > 0 && (
                  <div className="mt-1.5 flex gap-1.5">
                    {ph.map((p) => (
                      <button key={p.id} onClick={() => setViewPhoto(p.id)}>
                        <img src={p.dataUrl} alt="Foto de progresso" className="h-12 w-12 rounded-lg object-cover" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <Button size="icon-sm" variant="ghost" className="text-destructive" aria-label="Excluir avaliação" onClick={() => setToDelete(e)}>
                <Trash2 />
              </Button>
            </Card>
          );
        })}
      </section>

      <EntryDialog open={open} onOpenChange={setOpen} />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        destructive
        title="Excluir avaliação?"
        description="A avaliação e as fotos associadas serão removidas."
        confirmLabel="Excluir"
        onConfirm={async () => {
          if (toDelete) await deleteBodyEntry(toDelete.id);
        }}
      />
      <Dialog open={!!viewPhoto} onOpenChange={(o) => !o && setViewPhoto(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Foto de progresso</DialogTitle>
          </DialogHeader>
          {viewPhoto && <img src={photos?.find((p) => p.id === viewPhoto)?.dataUrl} alt="Foto de progresso" className="max-h-[60dvh] w-full rounded-2xl object-contain" />}
          <Button
            variant="ghost"
            className="text-destructive"
            onClick={async () => {
              if (viewPhoto) await deletePhoto(viewPhoto);
              setViewPhoto(null);
            }}
          >
            <Trash2 /> Excluir foto
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
