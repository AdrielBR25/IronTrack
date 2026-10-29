import { useMemo, useState } from 'react';
import { BookmarkCheck, CalendarDays, CircleSlash, Eye, Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fmtDayLong } from '@/features/planner/plannerFormat';
import { fmtDateTime } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { CONFLICT_KIND_LABEL, DECISION_LABEL, DECISION_STATUS_LABEL, evaluateDecisionsFor, isObsolete, type CalendarInput, type DecisionStatus } from '@/modules/calendar';
import { removeInvalidDecisions } from './decisionActions';
import { cleanupFromScreen, removeFromScreen, showAgainFromScreen } from './decisionUi';

// "Decisões lembradas" (IronTrack 2.0 F01/P16, docs/DECISOES_CALENDARIO.md §7). Lista as decisões do perfil com a
// SITUAÇÃO ATUAL calculada agora (valendo, invalidada por mudança, resolvida, vencida): uma decisão sem efeito nunca
// aparece como ativa. Ações: voltar a mostrar o aviso, remover a decisão, abrir o dia, limpar as sem efeito (reavaliadas
// dentro da transação). Nada aqui altera treinos, planejamento, rotação ou agenda anterior.

const STATUS_ICON: Record<DecisionStatus, typeof BookmarkCheck> = {
  active: BookmarkCheck,
  showing: Eye,
  invalidated: TriangleAlert,
  resolved: CircleSlash,
  expired: CircleSlash,
};

export function RememberedDecisions({ input, invalidCount, onOpenDay }: { input: CalendarInput; invalidCount: number; onOpenDay: (date: string) => void }) {
  const [busy, setBusy] = useState(false);
  // Calculado só quando a lista está aberta e quando as fontes ou as decisões mudam (um único intervalo de datas).
  const views = useMemo(() => evaluateDecisionsFor(input, input.decisions ?? []), [input]);
  const obsolete = views.filter((v) => isObsolete(v.status));
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3 p-4" data-testid="remembered-decisions" aria-label="Decisões lembradas">
      <div>
        <h2 className="font-display font-semibold">Decisões lembradas</h2>
        <p className="text-xs text-muted-foreground">
          Escolhas de exibição sobre divergências. Não alteram treinos, planejamento, rotação nem a agenda antiga. Cada uma vale só para aquela divergência, naquele dia, enquanto nada
          relevante mudar.
        </p>
      </div>

      {invalidCount > 0 && (
        <div className="space-y-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-xs" role="status" data-testid="decisions-invalid">
          <p>
            {invalidCount === 1 ? '1 registro de decisão está ilegível' : `${invalidCount} registros de decisão estão ilegíveis`} (dados corrompidos) e foi ignorado: nenhum aviso fica escondido por
            ele.
          </p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => removeInvalidDecisions())} data-testid="decisions-remove-invalid">
            <Trash2 /> Remover registros ilegíveis
          </Button>
        </div>
      )}

      {views.length === 0 ? (
        <p className="rounded-xl bg-secondary/50 p-3 text-sm text-muted-foreground" data-testid="decisions-empty">
          Nenhuma decisão lembrada. Em "Revisar divergências", use "Manter planejamento e lembrar" para não ver de novo um aviso que você já conferiu.
        </p>
      ) : (
        <ul className="space-y-2">
          {views.map((v) => {
            const Icon = STATUS_ICON[v.status];
            const d = v.decision;
            return (
              <li key={d.id} className={cn('space-y-1.5 rounded-xl border p-3 text-sm', v.status === 'active' ? 'border-primary/40' : 'border-dashed')} data-testid="decision-item" data-status={v.status} data-date={d.date}>
                <p className="font-semibold first-letter:uppercase">{fmtDayLong(d.date)}</p>
                <dl className="grid gap-0.5 text-xs">
                  <div>
                    <dt className="inline font-medium">Divergência: </dt>
                    <dd className="inline text-muted-foreground">{CONFLICT_KIND_LABEL[d.conflictType]}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Decisão: </dt>
                    <dd className="inline text-muted-foreground">{DECISION_LABEL[d.decision]}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Decidida em: </dt>
                    <dd className="inline text-muted-foreground">{fmtDateTime(d.updatedAt)}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Situação: </dt>
                    <dd className="inline-flex items-center gap-1" data-testid="decision-status">
                      <Icon className={cn('h-3.5 w-3.5', v.status === 'active' ? 'text-primary' : v.status === 'invalidated' ? 'text-warn' : 'text-muted-foreground')} aria-hidden />
                      {DECISION_STATUS_LABEL[v.status]}
                    </dd>
                  </div>
                </dl>
                <p className="break-words text-xs text-muted-foreground">Aviso: {v.current?.message ?? d.summary}</p>
                <div className="grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap">
                  <Button size="sm" variant="outline" className="h-auto min-h-11 whitespace-normal py-2 sm:min-h-9" onClick={() => onOpenDay(d.date)} data-testid="decision-open-day">
                    <CalendarDays /> Abrir o dia
                  </Button>
                  {v.status === 'active' && (
                    <Button size="sm" variant="outline" className="h-auto min-h-11 whitespace-normal py-2 sm:min-h-9" disabled={busy} onClick={() => void run(() => showAgainFromScreen(d.id, d.revision))} data-testid="decision-show-again">
                      <Eye /> Voltar a mostrar aviso
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-auto min-h-11 whitespace-normal py-2 sm:min-h-9" disabled={busy} onClick={() => void run(() => removeFromScreen(d.id, d.revision))} data-testid="decision-remove">
                    <Trash2 /> Remover decisão
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {obsolete.length > 0 && (
        <div className="space-y-1">
          <Button variant="secondary" className="w-full sm:w-auto" disabled={busy} onClick={() => void run(() => cleanupFromScreen(obsolete.map((v) => v.decision.id)))} data-testid="decisions-cleanup">
            <Trash2 /> Limpar {obsolete.length === 1 ? '1 decisão sem efeito' : `${obsolete.length} decisões sem efeito`}
          </Button>
          <p className="text-xs text-muted-foreground">Seguro: só sai o que hoje não esconde nenhum aviso (conferido de novo na hora de gravar).</p>
        </div>
      )}
    </Card>
  );
}
