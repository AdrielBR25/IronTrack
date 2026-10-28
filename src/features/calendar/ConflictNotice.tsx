import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, BookmarkCheck, EyeOff, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fmtDateTime } from '@/lib/dates';
import { legacyText, pendingWarnings, rememberOption, rememberedConflicts, type ResolvedDay } from '@/modules/calendar';
import { CERTAINTY_HINT, ORIGIN_LABEL, entryLine } from './calendarFormat';
import { rememberFromScreen, showAgainFromScreen } from './decisionUi';

// Aviso de divergência entre as agendas (IronTrack 2.0 F01/P14, docs/CALENDARIO_UNIFICADO.md §5). Nunca resolve nada
// sozinho. P16 (docs/DECISOES_CALENDARIO.md §6): "Manter planejamento e lembrar" grava uma DECISÃO DE EXIBIÇÃO (não
// altera treinos): o aviso idêntico não volta como novo, mas volta se algo relevante mudar; "Recolher só agora" é o
// comportamento antigo (nada gravado). Um aviso reconhecido continua consultável ("Decisão lembrada" + detalhes) e
// pode voltar a ser mostrado. Com a preferência "observações informativas" desligada, dias só com informações mostram
// uma linha discreta (consultável); avisos relevantes aparecem sempre.

export function ConflictNotice({
  day,
  onEditPlan,
  legacyHref = '/treinos',
  planHref,
  showInfo = true,
}: {
  day: ResolvedDay;
  onEditPlan?: () => void;
  legacyHref?: string | null;
  planHref?: string;
  showInfo?: boolean;
}) {
  const [kept, setKept] = useState(false);
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setKept(false);
    setDetails(false);
  }, [day.date]);
  if (!day.conflicts.length) return null;
  const warnings = pendingWarnings(day);
  const remembered = rememberedConflicts(day);
  const showAlert = warnings.length > 0 && !kept;
  const rememberable = warnings.find((c) => rememberOption(day, c) === 'keep_plan');
  const act = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2" data-testid="conflict-notice" data-warning={warnings.length > 0 ? 'true' : 'false'} data-remembered={remembered.length}>
      {showAlert && (
        <div role="status" className="space-y-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">
          {warnings.map((c, i) => (
            <p key={i} className="flex gap-2" data-testid="conflict-message">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
              <span className="min-w-0 break-words">{c.message}</span>
            </p>
          ))}
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {rememberable && (
              <Button
                size="sm"
                className="col-span-2 h-auto min-h-11 whitespace-normal py-2 text-center leading-tight sm:min-h-9"
                disabled={busy}
                onClick={() => void act(() => rememberFromScreen(day.date, rememberable, 'keep_plan'))}
                data-testid="conflict-remember"
              >
                <BookmarkCheck /> Manter planejamento e lembrar
                <span className="block text-[10px] font-normal opacity-80">decisão de exibição: não altera treinos; volta a avisar se algo mudar</span>
              </Button>
            )}
            <Button size="sm" variant="secondary" className="h-auto min-h-11 whitespace-normal py-2 text-center leading-tight sm:min-h-9" onClick={() => setKept(true)} data-testid="conflict-keep">
              Recolher só agora
              <span className="block text-[10px] font-normal opacity-80">nada é gravado; volta ao reabrir</span>
            </Button>
            <Button size="sm" variant="outline" className="h-auto min-h-11 whitespace-normal py-2 text-center leading-tight sm:min-h-9" aria-expanded={details} onClick={() => setDetails((v) => !v)} data-testid="conflict-details">
              {details ? 'Ocultar detalhes' : 'Ver detalhes'}
            </Button>
            {onEditPlan ? (
              <Button size="sm" variant="outline" className="h-auto min-h-11 whitespace-normal py-2 text-center leading-tight sm:min-h-9" onClick={onEditPlan} data-testid="conflict-edit">
                Editar o planejamento
              </Button>
            ) : planHref ? (
              <Button size="sm" variant="outline" className="h-auto min-h-11 whitespace-normal py-2 text-center leading-tight sm:min-h-9" asChild>
                <Link to={planHref} data-testid="conflict-edit">
                  Editar o planejamento
                </Link>
              </Button>
            ) : null}
            {legacyHref && (
              <Button size="sm" variant="outline" className="h-auto min-h-11 whitespace-normal py-2 text-center leading-tight sm:min-h-9" asChild>
                <Link to={legacyHref} data-testid="conflict-legacy">
                  Consultar a agenda antiga
                </Link>
              </Button>
            )}
          </div>
        </div>
      )}
      {remembered.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed p-2.5 text-xs" data-testid="conflict-remembered">
          <BookmarkCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1 break-words">
            <span className="font-medium text-foreground">Decisão lembrada</span>
            {' · '}
            {remembered.some((c) => c.remembered!.decision === 'keep_plan') ? 'você manteve o planejamento' : 'observação ocultada'} em {fmtDateTime(remembered[0].remembered!.decidedAt)}. Nenhum treino foi alterado; o aviso volta se algo mudar.
          </span>
          {remembered.map((c) => (
            <Button
              key={c.id}
              size="sm"
              variant="outline"
              className="h-auto min-h-11 whitespace-normal py-2 sm:min-h-9"
              disabled={busy}
              onClick={() => void act(() => showAgainFromScreen(c.remembered!.decisionId, c.remembered!.revision))}
              data-testid="conflict-show-again"
            >
              Voltar a mostrar
            </Button>
          ))}
        </div>
      )}
      {!showAlert && (
        <button
          type="button"
          className="flex min-h-11 w-full items-center gap-2 rounded-xl bg-secondary/60 px-3 py-2 text-left text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={details}
          onClick={() => setDetails((v) => !v)}
          data-testid="conflict-details"
        >
          <Info className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {kept ? 'Aviso recolhido só agora; nada foi alterado (volta ao reabrir). ' : ''}
            {day.conflicts.length === 1 ? '1 observação sobre as agendas deste dia' : `${day.conflicts.length} observações sobre as agendas deste dia`}
            {!showInfo && !warnings.length && day.conflicts.length > remembered.length ? ' (informativas, ocultas pelas preferências)' : ''}
          </span>
          <span className="font-medium text-foreground">{details ? 'Ocultar' : 'Ver'}</span>
        </button>
      )}
      {details && <ConflictDetails day={day} busy={busy} onHide={(c) => void act(() => rememberFromScreen(day.date, c, 'hide_info'))} />}
    </div>
  );
}

/**
 * Comparação lado a lado das fontes do dia e todas as observações (avisos e informações). P16: as reconhecidas
 * aparecem marcadas como "decisão lembrada"; observações informativas podem ser ocultadas (decisão de exibição).
 */
export function ConflictDetails({ day, onHide, busy = false }: { day: ResolvedDay; onHide?: (c: ResolvedDay['conflicts'][number]) => void; busy?: boolean }) {
  const plan = day.entries.filter((e) => e.origin === 'plan_exception' || e.origin === 'plan_recurring');
  return (
    <div className="space-y-2 rounded-xl border p-3 text-xs" data-testid="conflict-detail-list">
      <dl className="grid gap-1.5">
        <div>
          <dt className="font-medium text-foreground">Planejamento</dt>
          <dd className="text-muted-foreground">{plan.length ? plan.map((e) => `${entryLine(e)} · ${ORIGIN_LABEL[e.origin]}`).join('; ') : 'Nada planejado'}</dd>
        </div>
        <div>
          <dt className="font-medium text-foreground">Agenda anterior</dt>
          <dd className="text-muted-foreground">
            {day.legacy ? `${legacyText(day.legacy)}${day.legacy.source === 'override' ? ' (reagendado)' : ''}${day.plan.source !== 'none' ? ' · não define o dia (o planejamento tem prioridade)' : ''}` : 'Sem rotina ativa'}
          </dd>
        </div>
        {plan.some((e) => e.followsRotation) && (
          <div>
            <dt className="font-medium text-foreground">Rotação</dt>
            <dd className="text-muted-foreground">{plan.filter((e) => e.followsRotation).map((e) => CERTAINTY_HINT[e.certainty] ?? '').join(' ')}</dd>
          </div>
        )}
      </dl>
      <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
        {day.conflicts.map((c, i) => (
          <li key={i} data-testid="conflict-item" data-kind={c.kind} data-severity={c.severity} data-remembered={c.remembered ? 'true' : 'false'}>
            {c.message}
            {c.remembered && <span className="font-medium text-foreground"> · decisão lembrada ({c.remembered.decision === 'keep_plan' ? 'manter planejamento' : 'observação ocultada'})</span>}
            {!c.remembered && onHide && rememberOption(day, c) === 'hide_info' && (
              <button
                type="button"
                className="ml-1 inline-flex min-h-11 items-center gap-1 rounded-md px-1.5 align-middle font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:min-h-0"
                disabled={busy}
                onClick={() => onHide(c)}
                data-testid="conflict-hide-remember"
              >
                <EyeOff className="h-3 w-3" aria-hidden /> Ocultar esta observação (não altera treinos)
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">O que vale é o planejamento (quando existe). Nada foi alterado automaticamente: escolha o que mudar, se quiser.</p>
    </div>
  );
}
