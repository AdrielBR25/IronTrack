import { useState } from 'react';
import { toast } from 'sonner';
import { applyLinks, type LinkBatchResult } from '@/db/library';
import { instanceFingerprint, linkComparison, refOfItem, type LibraryItem, type MatchCandidate, type SheetEntry } from '@/modules/exercises';
import { planSummary } from '@/features/workout/modelFormat';
import { useModelCapability } from '@/features/compat/CompatGuard';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** Configuração da instância em texto ("3 × 8–12 · descanso 90 s · 40 kg"), só para conferência. */
export function configText(t: SheetEntry['exercise'], fmtW?: (kg: number) => string): string {
  const parts = [planSummary(t)];
  if (t.restSec > 0) parts.push(`descanso ${t.restSec} s`);
  if (t.targetWeight != null) parts.push(fmtW ? fmtW(t.targetWeight) : `${t.targetWeight} kg`);
  if (t.warmupSets > 0) parts.push(`+${t.warmupSets} aquec.`);
  return parts.join(' · ');
}

/**
 * Comparação "exercício atual × exercício da biblioteca" (P18 §5): o que muda (só a referência de origem) e o que
 * continua igual. Avisos de divergência ficam destacados. Usada na confirmação individual e na revisão em lote.
 */
export function LinkComparisonView({ entry, item, candidate }: { entry: SheetEntry; item: LibraryItem; candidate?: MatchCandidate | null }) {
  const c = linkComparison(entry.exercise, item, configText(entry.exercise));
  return (
    <div className="space-y-3 text-sm" data-testid="link-comparison">
      <div className="grid gap-2 min-[420px]:grid-cols-2">
        <section className="min-w-0 rounded-xl border p-2" aria-label="Exercício atual">
          <h3 className="text-xs text-muted-foreground">Exercício atual (ficha)</h3>
          <p className="break-words font-semibold">{c.current.name}</p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs">
            <dt className="text-muted-foreground">Grupo</dt>
            <dd className="break-words">{c.current.muscleGroup}</dd>
            <dt className="text-muted-foreground">Modalidade</dt>
            <dd>{c.current.modality}</dd>
            <dt className="text-muted-foreground">Equipamento</dt>
            <dd>{c.current.equipment}</dd>
            {c.current.laterality && (
              <>
                <dt className="text-muted-foreground">Execução</dt>
                <dd>{c.current.laterality}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Séries</dt>
            <dd className="tabular">{c.current.config}</dd>
          </dl>
        </section>
        <section className="min-w-0 rounded-xl border border-primary/50 p-2" aria-label="Exercício da biblioteca">
          <h3 className="text-xs text-muted-foreground">Exercício da biblioteca</h3>
          <p className="break-words font-semibold">{c.library.name}</p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs">
            <dt className="text-muted-foreground">Grupo</dt>
            <dd>{c.library.muscles}</dd>
            <dt className="text-muted-foreground">Modalidade</dt>
            <dd>{c.library.modality}</dd>
            <dt className="text-muted-foreground">Equipamento</dt>
            <dd>{c.library.equipment}</dd>
            <dt className="text-muted-foreground">Execução</dt>
            <dd>{c.library.laterality}</dd>
            <dt className="text-muted-foreground">Carga</dt>
            <dd>{c.library.loadMode}</dd>
          </dl>
        </section>
      </div>
      {candidate && <p className="text-xs text-muted-foreground">Motivo da sugestão: {candidate.explanation}</p>}
      {candidate && candidate.warnings.length > 0 && (
        <ul className="list-disc space-y-0.5 rounded-xl border border-warn/40 bg-warn/10 p-3 pl-7 text-xs" data-testid="link-warnings">
          {candidate.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <section aria-label="O que será alterado">
        <h3 className="font-semibold">O que será alterado</h3>
        <ul className="list-disc pl-5">
          {c.changes.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </section>
      <section aria-label="O que permanece igual">
        <h3 className="font-semibold">O que permanece igual</h3>
        <p className="text-muted-foreground">{c.unchanged.join(' · ')}.</p>
      </section>
    </div>
  );
}

/** Texto do resultado de uma gravação em lote (para o aviso e para a tela). */
export function linkResultSummary(r: LinkBatchResult): string {
  if (!r.applied) {
    const bad = r.results.filter((x) => x.status !== 'linked' && x.status !== 'already');
    return `Nada foi gravado: ${bad.length} ${bad.length === 1 ? 'associação foi recusada' : 'associações foram recusadas'} (${bad.map((b) => `${b.request.name}: ${b.message}`).join(' ')})`;
  }
  const n = r.results.filter((x) => x.status === 'linked').length;
  const a = r.results.length - n;
  return `${n} ${n === 1 ? 'exercício associado' : 'exercícios associados'}${a ? `; ${a} já estava${a === 1 ? '' : 'm'} associado${a === 1 ? '' : 's'}` : ''}.`;
}

/**
 * Confirmação de UMA associação (P18 §5). `entry` é a CÓPIA que a pessoa viu ao abrir a prévia (quem chama guarda o
 * instantâneo); a impressão digital vem dela. Se a instância gravada mudar até a confirmação (outra aba, restauração),
 * nada é gravado e a pessoa revisa de novo.
 */
export function LinkConfirmDialog({ entry, item, candidate, onClose, onDone }: { entry: SheetEntry | null; item: LibraryItem | null; candidate?: MatchCandidate | null; onClose: () => void; onDone?: () => void }) {
  const outdated = useModelCapability().newer;
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!entry || !item || busy) return;
    if (outdated) {
      toast.error('Atualize o IronTrack antes de editar: estes dados já foram usados por uma versão mais nova.');
      return;
    }
    setBusy(true);
    try {
      const r = await applyLinks([{ routineId: entry.routineId, workoutId: entry.workoutId, id: entry.exercise.id, expected: instanceFingerprint(entry.exercise), ref: refOfItem(item), name: entry.exercise.name }]);
      if (r.applied) {
        toast.success(linkResultSummary(r));
        onDone?.();
        onClose();
      } else toast.error(linkResultSummary(r));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!entry && !!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="link-confirm">
        <DialogHeader>
          <DialogTitle>Associar à biblioteca?</DialogTitle>
          <DialogDescription>Confira antes de confirmar. Nada foi gravado ainda.</DialogDescription>
        </DialogHeader>
        {entry && item && <LinkComparisonView entry={entry} item={item} candidate={candidate} />}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button size="lg" disabled={busy} onClick={() => void confirm()} data-testid="link-confirm-button">
            Confirmar associação
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
