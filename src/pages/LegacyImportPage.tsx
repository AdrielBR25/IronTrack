import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeft, CalendarPlus, Check, Eye, Info, ListChecks, Minus, RotateCcw, ShieldCheck, Undo2 } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { LegacyImportError, applyImport, checkUndoImport, undoLastImport } from '@/db/legacyImport';
import { useImportSource, useLastImport } from '@/hooks/useLegacyImport';
import { useToday } from '@/hooks/data';
import { fmtDayLong } from '@/features/planner/plannerFormat';
import { fmtDateTime, weekdayShort } from '@/lib/dates';
import { cn, uid } from '@/lib/utils';
import { importWeekdayName, previewLegacyImport, type ConflictDecision, type ImportItem, type ImportMode, type ImportOutcome, type ImportPreview, type UndoPlan } from '@/modules/planner';

// Importar agenda antiga para o planejamento (IronTrack 2.0 F01/P15, #/planejamento/importar,
// docs/CONSOLIDACAO_AGENDAS.md). Iniciada só pela pessoa; prévia obrigatória; confirmação explícita; nada da agenda
// antiga, das sessões, da rotação ou das fichas é alterado. A prévia é a mesma nos três modos e é recalculada ao vivo
// (outra aba atualiza); a confirmação usa a prévia congelada no momento em que a pessoa abriu a confirmação.

const OUTCOME_LABEL: Record<ImportOutcome, string> = {
  create: 'Será criada',
  replace: 'Substitui (decisão sua)',
  keep: 'Mantém o atual',
  skip: 'Não importar',
  preserve: 'Sem alteração',
  ignore: 'Ignorada',
  manual: 'Decisão manual',
};

const OUTCOME_TONE: Record<ImportOutcome, string> = {
  create: 'bg-primary/15 text-primary',
  replace: 'bg-warn/15 text-warn',
  keep: 'bg-secondary text-foreground',
  skip: 'bg-secondary text-muted-foreground',
  preserve: 'bg-secondary text-muted-foreground',
  ignore: 'bg-secondary text-muted-foreground',
  manual: 'bg-warn/15 text-warn',
};

const DECISIONS: { value: ConflictDecision; label: string }[] = [
  { value: 'keep', label: 'Manter planejamento atual' },
  { value: 'legacy', label: 'Usar a agenda antiga' },
  { value: 'skip', label: 'Não importar este dia' },
];

const itemTitle = (it: ImportItem) => (it.kind === 'weekday' ? importWeekdayName(it.weekday!).replace(/^./, (c) => c.toUpperCase()) : it.kind === 'date' ? fmtDayLong(it.date!) : 'Outros registros');

export default function LegacyImportPage() {
  const today = useToday();
  const navigate = useNavigate();
  const source = useImportSource(today);
  const last = useLastImport();
  const [mode, setMode] = useState<ImportMode>('empty_only');
  const [decisions, setDecisions] = useState<Record<string, ConflictDecision>>({});
  const [confirm, setConfirm] = useState<{ preview: ImportPreview; operationId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [seenFingerprint, setSeenFingerprint] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ plan: UndoPlan; recordId: string } | null>(null);

  // O mesmo motor nos três modos (IDs provisórios: a gravação recalcula tudo dentro da transação).
  const preview = useMemo(() => (source ? previewLegacyImport(source, { mode, decisions }, { today, now: 0, newId: () => 'prévia' }) : null), [source, mode, decisions, today]);
  if (preview && seenFingerprint === null) setSeenFingerprint(preview.fingerprint);
  const refreshed = !!preview && seenFingerprint !== null && seenFingerprint !== preview.fingerprint;

  const header = (
    <>
      <Link to="/planejamento" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Planejamento
      </Link>
      <PageHeader title="Importar agenda antiga" subtitle="Converter a agenda anterior em planejamento, com prévia e sua confirmação" />
    </>
  );
  if (!preview || last === undefined) return <div className="space-y-4">{header}<div className="h-40 animate-pulse rounded-2xl bg-card" /></div>;

  const { overview: o, counts: c } = preview;
  const writes = preview.put.length + preview.delete.length;
  const weekdays = preview.items.filter((i) => i.kind === 'weekday');
  const dates = preview.items.filter((i) => i.kind === 'date');
  const others = preview.items.filter((i) => i.kind === 'summary');

  async function runImport() {
    if (!confirm || confirm.preview.mode === 'view') return;
    setBusy(true);
    try {
      const r = await applyImport({ operationId: confirm.operationId, mode: confirm.preview.mode, decisions, expectedFingerprint: confirm.preview.fingerprint });
      toast.success(r.repeated ? 'Esta importação já tinha sido aplicada; nada foi duplicado.' : `Importado: ${r.record.counts.create + r.record.counts.replace} ${r.record.counts.create + r.record.counts.replace === 1 ? 'entrada' : 'entradas'} no planejamento`);
      setConfirm(null);
      setSeenFingerprint(null);
      setDecisions({});
    } catch (e) {
      toast.error(e instanceof LegacyImportError ? e.message : 'Não foi possível importar (falha ao gravar). Nada foi alterado.');
      // Mantém a referência da prévia confirmada: se os dados mudaram, o aviso "prévia atualizada" aparece.
      setSeenFingerprint(confirm.preview.fingerprint);
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  async function askUndo() {
    const r = await checkUndoImport();
    if (!r.record || !r.plan) return void toast.error('Não há importação para desfazer.');
    setUndo({ plan: r.plan, recordId: r.record.id });
  }

  async function runUndo() {
    if (!undo) return;
    setBusy(true);
    try {
      await undoLastImport({ recordId: undo.recordId });
      toast.success('Importação desfeita. A agenda antiga, as sessões e a rotação não mudaram.');
    } catch (e) {
      toast.error(e instanceof LegacyImportError ? e.message : 'Não foi possível desfazer. Nada foi revertido.', { description: e instanceof LegacyImportError ? e.details.join('\n') : undefined });
    } finally {
      setBusy(false);
      setUndo(null);
    }
  }

  return (
    <div className="space-y-4" data-testid="import-page">
      {header}

      <Card className="space-y-2 p-4 text-sm">
        <p className="flex gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>
            Nada é importado sem a sua confirmação. A agenda antiga continua guardada como está; sessões, rotação e fichas não mudam. O treino de cada dia
            continua sendo o próximo da rotação (previsão), como antes.
          </span>
        </p>
      </Card>

      <section aria-label="Modo de importação" className="space-y-2">
        <Segmented<ImportMode>
          aria-label="Modo de importação"
          value={mode}
          onChange={(m) => setMode(m)}
          options={[
            { value: 'empty_only', label: <span data-testid="mode-empty">Só dias vazios</span> },
            { value: 'review', label: <span data-testid="mode-review">Revisar conflitos</span> },
            { value: 'view', label: <span data-testid="mode-view">Só visualizar</span> },
          ]}
        />
        <p className="text-xs text-muted-foreground" data-testid="mode-hint">
          {mode === 'empty_only'
            ? 'Padrão e mais seguro: adiciona só onde o planejamento está vazio. Conflitos ficam como estão.'
            : mode === 'review'
              ? 'Para cada conflito, escolha: manter o planejamento atual, usar a agenda antiga ou não importar o dia. Nada é substituído em lote.'
              : 'Mostra a conversão sem gravar nada.'}
        </p>
      </section>

      {refreshed && (
        <p role="status" className="flex gap-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm" data-testid="import-refreshed">
          <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
          <span>A prévia foi atualizada porque o planejamento ou a agenda antiga mudaram (talvez em outra aba). Confira antes de confirmar.</span>
        </p>
      )}

      {!o.routineId ? (
        <Card className="p-4 text-sm text-muted-foreground" data-testid="import-empty">
          Não há agenda antiga para importar: escolha uma rotina ativa com treinos em Treinos.
        </Card>
      ) : (
        <>
          <Card className="p-4" data-testid="import-overview">
            <h2 className="mb-3 flex items-center gap-2 font-display font-semibold">
              <ListChecks className="h-5 w-5 text-primary" /> Prévia
            </h2>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm sm:grid-cols-3">
              <Row label="Rotina da agenda antiga" value={o.routineName} id="ov-routine" />
              <Row label="Treinos (rotação)" value={o.workouts.map((w) => w.label).join(' → ')} id="ov-workouts" />
              <Row label="Dias de treino encontrados" value={o.trainingDays.length ? o.trainingDays.map((w) => weekdayShort(w)).join(', ') : 'nenhum'} id="ov-days" />
              <Row label="Reagendamentos (de hoje em diante)" value={o.futureWorkoutOverrides} id="ov-overrides" />
              <Row label="Descansos explícitos" value={o.futureRestOverrides} id="ov-rest" />
              <Row label="Planejamento já existente" value={`${o.plannedWeekdays} ${o.plannedWeekdays === 1 ? 'dia da semana' : 'dias da semana'} · ${o.plannedExceptionDates} ${o.plannedExceptionDates === 1 ? 'data' : 'datas'}`} id="ov-plan" />
              <Row label="Conflitos" value={c.conflicts} id="ov-conflicts" />
              <Row label="Serão criadas" value={c.create + c.replace} id="ov-create" />
              <Row label="Serão preservadas" value={c.preserve + c.keep} id="ov-preserve" />
              <Row label="Ignoradas" value={c.ignore + c.skip} id="ov-ignore" />
              <Row label="Exigem decisão manual" value={c.manual} id="ov-manual" />
            </dl>
          </Card>

          <ItemList title="Dias da semana (dias de treino das Configurações)" items={weekdays} mode={mode} decisions={decisions} setDecisions={setDecisions} />
          {dates.length > 0 && <ItemList title="Datas reagendadas na tela Treinos" items={dates} mode={mode} decisions={decisions} setDecisions={setDecisions} />}
          {others.length > 0 && <ItemList title="Não importados" items={others} mode={mode} decisions={decisions} setDecisions={setDecisions} />}
        </>
      )}

      <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-10 grid grid-cols-[1fr_auto] gap-2 rounded-2xl border bg-background/95 p-3 backdrop-blur md:static md:bottom-auto md:flex md:justify-end md:border-0 md:bg-transparent md:p-0">
        {mode === 'view' ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="import-view-only">
            <Eye className="h-4 w-4" aria-hidden /> Apenas visualizando: nada será gravado.
          </p>
        ) : (
          <Button size="lg" disabled={!writes || busy} onClick={() => setConfirm({ preview, operationId: uid() })} data-testid="import-confirm">
            <CalendarPlus /> {writes ? `Importar ${c.create + c.replace} ${c.create + c.replace === 1 ? 'entrada' : 'entradas'}` : 'Nada para importar'}
          </Button>
        )}
        <Button variant="secondary" size="lg" onClick={() => navigate('/planejamento')} data-testid="import-cancel">
          {mode === 'view' || !writes ? 'Voltar' : 'Cancelar'}
        </Button>
      </div>

      {last && (
        <Card className="space-y-2 p-4 text-sm" data-testid="import-last" data-status={last.status}>
          <h2 className="font-display font-semibold">Última importação</h2>
          <p className="text-muted-foreground">
            {fmtDateTime(last.createdAt)} · {last.counts.create + last.counts.replace} {last.counts.create + last.counts.replace === 1 ? 'entrada criada' : 'entradas criadas'} ·{' '}
            {last.mode === 'review' ? 'revisando conflitos' : 'só dias vazios'}
            {last.status === 'undone' && last.undoneAt ? ` · desfeita em ${fmtDateTime(last.undoneAt)}` : ''}
          </p>
          {last.status === 'applied' && (
            <>
              <p className="text-xs text-muted-foreground">
                Desfazer remove só o que esta importação criou ou alterou. Se você mexeu nesses dias depois, o desfazer é bloqueado e nada é revertido. Fica disponível
                mesmo depois de fechar o app, até a próxima importação ou uma restauração por substituição.
              </p>
              <Button variant="outline" className="w-full sm:w-auto" disabled={busy} onClick={() => void askUndo()} data-testid="import-undo">
                <Undo2 /> Desfazer importação
              </Button>
            </>
          )}
        </Card>
      )}

      <Dialog open={!!confirm} onOpenChange={(v) => !v && !busy && setConfirm(null)}>
        <DialogContent data-testid="import-confirm-dialog">
          <DialogHeader>
            <DialogTitle>Importar para o planejamento?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm">
                {confirm && (
                  <ul className="list-disc space-y-1 pl-5">
                    <li>
                      {confirm.preview.counts.create} {confirm.preview.counts.create === 1 ? 'entrada nova' : 'entradas novas'} onde o planejamento está vazio.
                    </li>
                    {confirm.preview.counts.replace > 0 && (
                      <li className="text-warn">
                        {confirm.preview.counts.replace} {confirm.preview.counts.replace === 1 ? 'dia em que você escolheu' : 'dias em que você escolheu'} usar a agenda antiga no lugar do planejamento atual.
                      </li>
                    )}
                    <li>{confirm.preview.counts.keep + confirm.preview.counts.preserve} preservadas sem alteração; {confirm.preview.counts.ignore + confirm.preview.counts.skip} ignoradas.</li>
                  </ul>
                )}
                <p>A agenda antiga, as sessões, a rotação e as fichas não mudam. Você pode desfazer depois.</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirm(null)}>
              Cancelar
            </Button>
            <Button disabled={busy} onClick={() => void runImport()} data-testid="import-apply">
              <Check /> Importar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!undo} onOpenChange={(v) => !v && !busy && setUndo(null)}>
        <DialogContent data-testid="import-undo-dialog" data-ok={undo?.plan.ok ? 'true' : 'false'}>
          <DialogHeader>
            <DialogTitle>{undo?.plan.ok ? 'Desfazer a última importação?' : 'Não é possível desfazer agora'}</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm">
                {undo?.plan.ok ? (
                  <>
                    <p>
                      Saem do planejamento só as entradas criadas pela importação
                      {undo.plan.put.length ? ', e o que ela substituiu volta como estava' : ''}. Sessões, rotação e a agenda antiga não mudam.
                    </p>
                    {undo.plan.keptPast > 0 && <p className="text-muted-foreground">Dias que já passaram continuam como estavam ({undo.plan.keptPast}).</p>}
                  </>
                ) : (
                  <>
                    <p>Houve alterações depois da importação. Para não apagar mudanças suas, nada será revertido:</p>
                    <ul className="list-disc space-y-1 pl-5" data-testid="import-undo-problems">
                      {undo?.plan.problems.map((p) => <li key={p}>{p}</li>)}
                    </ul>
                    <p>Ajuste esses dias diretamente no Planejamento, se quiser.</p>
                  </>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" disabled={busy} onClick={() => setUndo(null)}>
              {undo?.plan.ok ? 'Cancelar' : 'Fechar'}
            </Button>
            {undo?.plan.ok && (
              <Button variant="destructive" disabled={busy} onClick={() => void runUndo()} data-testid="import-undo-apply">
                <Undo2 /> Desfazer
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ label, value, id }: { label: string; value: React.ReactNode; id: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words font-semibold tabular" data-testid={id}>
        {value}
      </dd>
    </div>
  );
}

function ItemList({
  title,
  items,
  mode,
  decisions,
  setDecisions,
}: {
  title: string;
  items: ImportItem[];
  mode: ImportMode;
  decisions: Record<string, ConflictDecision>;
  setDecisions: (fn: (d: Record<string, ConflictDecision>) => Record<string, ConflictDecision>) => void;
}) {
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      <ul className="space-y-2">
        {items.map((it) => {
          const Icon = it.action === 'conflict' || it.action === 'manual' ? AlertTriangle : it.action === 'create' ? CalendarPlus : it.action === 'preserve' ? Check : it.action === 'ignore' ? Minus : Info;
          return (
            <li key={it.key} className="rounded-xl border p-3 text-sm" data-testid="import-item" data-key={it.key} data-action={it.action} data-outcome={it.outcome}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="flex min-w-0 items-center gap-1.5 font-semibold first-letter:uppercase">
                  <Icon className={cn('h-4 w-4 shrink-0', it.action === 'conflict' || it.action === 'manual' ? 'text-warn' : 'text-muted-foreground')} aria-hidden />
                  <span className="min-w-0 break-words">{itemTitle(it)}</span>
                </h3>
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', OUTCOME_TONE[it.outcome])} data-testid="import-item-outcome">
                  {OUTCOME_LABEL[it.outcome]}
                </span>
              </div>
              <dl className="mt-1.5 grid gap-0.5 text-xs">
                <div className="flex flex-wrap gap-x-1">
                  <dt className="text-muted-foreground">Agenda antiga:</dt>
                  <dd className="min-w-0 break-words">{it.legacyText}.</dd>
                </div>
                <div className="flex flex-wrap gap-x-1">
                  <dt className="text-muted-foreground">Planejamento atual:</dt>
                  <dd className="min-w-0 break-words">{it.currentText}.</dd>
                </div>
                <div className="flex flex-wrap gap-x-1">
                  <dt className="text-muted-foreground">Resultado proposto:</dt>
                  <dd className="min-w-0 break-words font-medium" data-testid="import-item-proposal">
                    {it.proposal}.
                  </dd>
                </div>
              </dl>
              <p className="mt-1 text-xs text-muted-foreground">{it.reason}</p>
              {it.action === 'manual' && it.date && (
                <Link to={`/planejamento?data=${it.date}`} className="mt-1 inline-flex min-h-11 items-center text-xs font-medium text-primary underline-offset-4 hover:underline">
                  Ajustar este dia no planejamento
                </Link>
              )}
              {it.action === 'conflict' && mode === 'review' && (
                <fieldset className="mt-2" data-testid="import-decision">
                  <legend className="sr-only">Decisão para {itemTitle(it)}</legend>
                  <div className="grid gap-1.5 sm:grid-cols-3">
                    {DECISIONS.map((d) => {
                      const checked = (decisions[it.key] ?? 'keep') === d.value;
                      return (
                        <label
                          key={d.value}
                          className={cn(
                            'flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-ring',
                            checked ? 'border-primary bg-primary/10 font-medium' : 'hover:bg-accent',
                          )}
                        >
                          <input
                            type="radio"
                            className="h-4 w-4 accent-[hsl(var(--primary))]"
                            name={`decision-${it.key}`}
                            value={d.value}
                            checked={checked}
                            onChange={() => setDecisions((prev) => ({ ...prev, [it.key]: d.value }))}
                            data-testid={`decision-${d.value}`}
                          />
                          {d.label}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
