import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { Camera, FileUp, Info, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { db } from '@/db/db';
import { addPhoto, deleteBodyEntry, deletePhoto, saveBodyEntry } from '@/db/repo';
import type { BodyEntry } from '@/lib/types';
import { parseBodyJson } from '@/lib/bodySchema';
import { fmtNum, parseNum, readFileText, uid } from '@/lib/utils';
import { fmtDateShort, fromISODate, todayISO } from '@/lib/dates';
import { useUnits } from '@/hooks/useUnits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm';
import { ChartCard, TrendChart } from '@/features/progress/charts';

type MetricKey = 'weightKg' | 'bodyFatPct' | 'waistCm' | 'abdomenCm' | 'armCm' | 'thighCm';
const METRICS: { key: MetricKey; label: string; unit: string }[] = [
  { key: 'weightKg', label: 'Peso corporal', unit: 'kg' },
  { key: 'bodyFatPct', label: '% gordura (estimado)', unit: '%' },
  { key: 'waistCm', label: 'Cintura', unit: 'cm' },
  { key: 'abdomenCm', label: 'Abdômen', unit: 'cm' },
  { key: 'armCm', label: 'Braço', unit: 'cm' },
  { key: 'thighCm', label: 'Coxa', unit: 'cm' },
];

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
              notes: f.notes?.trim() || undefined,
              createdAt: Date.now(),
            };
            await saveBodyEntry(entry);
            for (const p of photos) await addPhoto({ id: uid(), entryId: entry.id, dataUrl: p, createdAt: Date.now() });
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

export function BodySection() {
  const entries = useLiveQuery(() => db.bodyEntries.orderBy('date').toArray(), []);
  const photos = useLiveQuery(() => db.photos.toArray(), []);
  const { unit, show } = useUnits();
  const [metric, setMetric] = useState<MetricKey>('weightKg');
  const [open, setOpen] = useState(false);
  const [toDelete, setToDelete] = useState<BodyEntry | null>(null);
  const [viewPhoto, setViewPhoto] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const m = METRICS.find((x) => x.key === metric)!;
  const mUnit = metric === 'weightKg' ? unit : m.unit;
  const data = (entries ?? [])
    .filter((e) => e[metric] != null)
    .map((e) => ({ t: fromISODate(e.date).getTime(), v: metric === 'weightKg' ? (show(e.weightKg) ?? 0) : (e[metric] as number) }));

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button className="flex-1" onClick={() => setOpen(true)}>
          <Plus /> Nova avaliação
        </Button>
        <Button variant="outline" onClick={() => fileRef.current?.click()}>
          <FileUp /> Importar JSON
        </Button>
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
            const existing = new Set((entries ?? []).map((x) => `${x.date}|${x.weightKg ?? ''}`));
            let added = 0;
            for (const x of r.value) {
              if (existing.has(`${x.date}|${x.weightKg ?? ''}`)) continue;
              await saveBodyEntry(x);
              added++;
            }
            toast.success(`${added} avaliação(ões) importada(s)`, { description: added < r.value.length ? 'Duplicadas foram ignoradas.' : undefined });
          }}
        />
      </div>

      <Card className="flex gap-2 p-3 text-xs text-muted-foreground">
        <Info className="h-4 w-4 shrink-0" />
        <p>
          Percentual de gordura e medidas são <strong>estimativas</strong> e variam com o método e o horário. Massa magra inclui água, ossos e órgãos: não é sinônimo de massa
          muscular.
        </p>
      </Card>

      <ChartCard
        title={m.label}
        description={data.length ? `${data.length} registros` : undefined}
        action={
          <select
            aria-label="Medida"
            className="h-9 rounded-lg border bg-background px-2 text-sm"
            value={metric}
            onChange={(e) => setMetric(e.target.value as MetricKey)}
          >
            {METRICS.map((x) => (
              <option key={x.key} value={x.key}>
                {x.label}
              </option>
            ))}
          </select>
        }
      >
        <TrendChart data={data} x="t" y="v" fmt={(v) => `${fmtNum(v, 1)} ${mUnit}`} xFmt={(t) => fmtDateShort(Number(t))} />
      </ChartCard>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Registros</h3>
        {entries?.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma avaliação registrada.</p>}
        {[...(entries ?? [])].reverse().map((e) => {
          const ph = (photos ?? []).filter((p) => p.entryId === e.id);
          const parts = [
            e.weightKg != null && `${fmtNum(show(e.weightKg), 1)} ${unit}`,
            e.bodyFatPct != null && `${fmtNum(e.bodyFatPct, 1)}% gord.`,
            e.waistCm != null && `cintura ${fmtNum(e.waistCm, 1)}`,
            e.abdomenCm != null && `abd. ${fmtNum(e.abdomenCm, 1)}`,
            e.armCm != null && `braço ${fmtNum(e.armCm, 1)}`,
            e.thighCm != null && `coxa ${fmtNum(e.thighCm, 1)}`,
          ].filter(Boolean);
          return (
            <Card key={e.id} className="flex items-center gap-3 p-3">
              <div className="w-14 shrink-0 text-center">
                <p className="font-display font-bold">{fmtDateShort(e.date)}</p>
                <p className="text-[10px] text-muted-foreground">{e.date.slice(0, 4)}</p>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm tabular">{parts.join(' · ') || '—'}</p>
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
