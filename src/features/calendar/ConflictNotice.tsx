import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { legacyText, type ResolvedDay } from '@/modules/calendar';
import { CERTAINTY_HINT, ORIGIN_LABEL, entryLine } from './calendarFormat';

// Aviso de divergência entre as agendas (IronTrack 2.0 F01/P14, docs/CALENDARIO_UNIFICADO.md §5). Nunca resolve nada
// sozinho: "Manter planejamento atual" só recolhe o aviso nesta tela (nada é gravado; ele volta ao reabrir).

export function ConflictNotice({ day, onEditPlan, legacyHref = '/treinos', planHref }: { day: ResolvedDay; onEditPlan?: () => void; legacyHref?: string | null; planHref?: string }) {
  const [kept, setKept] = useState(false);
  const [details, setDetails] = useState(false);
  useEffect(() => {
    setKept(false);
    setDetails(false);
  }, [day.date]);
  if (!day.conflicts.length) return null;
  const warnings = day.conflicts.filter((c) => c.severity === 'warning');
  const showAlert = warnings.length > 0 && !kept;
  return (
    <div className="space-y-2" data-testid="conflict-notice" data-warning={warnings.length > 0 ? 'true' : 'false'}>
      {showAlert && (
        <div role="status" className="space-y-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">
          {warnings.map((c, i) => (
            <p key={i} className="flex gap-2" data-testid="conflict-message">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
              <span className="min-w-0 break-words">{c.message}</span>
            </p>
          ))}
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <Button size="sm" variant="secondary" className="h-auto min-h-11 whitespace-normal py-2 text-center leading-tight sm:min-h-9" onClick={() => setKept(true)} data-testid="conflict-keep">
              Manter planejamento atual
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
            {kept ? 'Você manteve o planejamento atual; nada foi alterado. ' : ''}
            {day.conflicts.length === 1 ? '1 observação sobre as agendas deste dia' : `${day.conflicts.length} observações sobre as agendas deste dia`}
          </span>
          <span className="font-medium text-foreground">{details ? 'Ocultar' : 'Ver'}</span>
        </button>
      )}
      {details && <ConflictDetails day={day} />}
    </div>
  );
}

/** Comparação lado a lado das fontes do dia e todas as observações (avisos e informações). */
export function ConflictDetails({ day }: { day: ResolvedDay }) {
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
          <li key={i} data-testid="conflict-item" data-kind={c.kind} data-severity={c.severity}>
            {c.message}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">O que vale é o planejamento (quando existe). Nada foi alterado automaticamente: escolha o que mudar, se quiser.</p>
    </div>
  );
}
