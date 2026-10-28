import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarDays, EyeOff, History, Info, Pencil, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fmtDayLong } from '@/features/planner/plannerFormat';
import { cn } from '@/lib/utils';
import { groupConflicts, type ConflictGroupDay, type ResolvedDay } from '@/modules/calendar';

// Central "Revisar divergências" (IronTrack 2.0 F01/P15, docs/CONSOLIDACAO_AGENDAS.md §9). Agrupa as divergências da
// semana exibida, diz a origem e o impacto e oferece ações contextuais. Regras:
//  - nada é marcado como resolvido por fechar ou recolher: "Manter planejamento atual" e "ocultar" são SÓ VISUAIS
//    (rotulados assim, valem enquanto a tela está aberta) e a divergência volta ao reabrir;
//  - a única decisão gravada é "Usar a agenda anterior só neste dia", que cria a exceção da data no planejamento
//    (com confirmação) — e então a divergência deixa de existir de fato;
//  - avisos relevantes nunca são escondidos pelas preferências; só as observações informativas.

export interface ConflictCenterProps {
  days: ResolvedDay[];
  showInfo: boolean;
  onShowInfo: (v: boolean) => void;
  onOpenDay: (date: string) => void;
  onEditDay: (date: string) => void;
  onUseLegacy: (date: string, choice: NonNullable<ConflictGroupDay['legacyChoice']>) => void;
  rangeLabel: string;
}

export function ConflictCenter({ days, showInfo, onShowInfo, onOpenDay, onEditDay, onUseLegacy, rangeLabel }: ConflictCenterProps) {
  const [kept, setKept] = useState<Set<string>>(() => new Set());
  const groups = groupConflicts(days, { includeInfo: showInfo });
  const hiddenInfo = showInfo ? 0 : groupConflicts(days, { includeInfo: true }).filter((g) => g.severity === 'info').reduce((a, g) => a + g.days.length, 0);
  const keptCount = groups.reduce((a, g) => a + g.days.filter((d) => kept.has(`${g.id}|${d.date}`)).length, 0);

  return (
    <Card className="space-y-3 p-4" data-testid="conflict-center" aria-label="Revisar divergências">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-display font-semibold">Revisar divergências</h2>
          <p className="text-xs text-muted-foreground">{rangeLabel}. Nada é resolvido sozinho: escolha o que mudar, se quiser.</p>
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-xl bg-secondary/50 p-3 text-sm text-muted-foreground" data-testid="conflict-center-empty">
          Nenhuma divergência {showInfo ? 'neste período' : 'relevante neste período'}.
        </p>
      ) : (
        <ul className="space-y-3">
          {groups.map((g) => {
            const visible = g.days.filter((d) => !kept.has(`${g.id}|${d.date}`));
            const Icon = g.severity === 'warning' ? AlertTriangle : Info;
            return (
              <li key={g.id} className={cn('rounded-xl border p-3', g.severity === 'warning' && 'border-warn/40 bg-warn/5')} data-testid="conflict-group" data-kind={g.kind} data-severity={g.severity}>
                <h3 className="flex items-start gap-2 text-sm font-semibold">
                  <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', g.severity === 'warning' ? 'text-warn' : 'text-muted-foreground')} aria-hidden />
                  <span className="min-w-0 break-words">
                    {g.title} <span className="font-normal text-muted-foreground">· {g.days.length} {g.days.length === 1 ? 'dia' : 'dias'}</span>
                    <span className="sr-only">{g.severity === 'warning' ? ', aviso relevante' : ', informação'}</span>
                  </span>
                </h3>
                <dl className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
                  <div>
                    <dt className="inline font-medium text-foreground">Origem: </dt>
                    <dd className="inline">{g.origin}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-foreground">Impacto: </dt>
                    <dd className="inline">{g.impact}</dd>
                  </div>
                </dl>
                <ul className="mt-2 space-y-2">
                  {visible.map((d) => (
                    <li key={d.date} className="rounded-lg bg-background/60 p-2" data-testid="conflict-group-day" data-date={d.date}>
                      <p className="text-xs font-semibold first-letter:uppercase">{fmtDayLong(d.date)}</p>
                      {d.messages.map((m) => (
                        <p key={m} className="break-words text-xs" data-testid="conflict-group-message">
                          {m}
                        </p>
                      ))}
                      <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap">
                        <ActionButton onClick={() => onOpenDay(d.date)} testId="cc-open">
                          <CalendarDays /> Ver o dia
                        </ActionButton>
                        {d.actions.includes('edit_plan') && (
                          <ActionButton onClick={() => onEditDay(d.date)} testId="cc-edit">
                            <Pencil /> Editar planejamento
                          </ActionButton>
                        )}
                        {d.actions.includes('see_legacy') && (
                          <Button size="sm" variant="outline" className="h-auto min-h-11 whitespace-normal py-2 leading-tight sm:min-h-9" asChild>
                            <Link to="/treinos" data-testid="cc-legacy">
                              <History /> Consultar agenda antiga
                            </Link>
                          </Button>
                        )}
                        {d.legacyChoice && (
                          <ActionButton onClick={() => onUseLegacy(d.date, d.legacyChoice!)} testId="cc-use-legacy">
                            Usar a agenda antiga só neste dia ({d.legacyChoice.label})
                          </ActionButton>
                        )}
                        {g.kind.startsWith('plan_') && g.severity === 'warning' ? (
                          <ActionButton onClick={() => setKept((s) => new Set(s).add(`${g.id}|${d.date}`))} testId="cc-keep" variant="secondary">
                            Manter planejamento atual (só nesta tela)
                          </ActionButton>
                        ) : (
                          <ActionButton onClick={() => setKept((s) => new Set(s).add(`${g.id}|${d.date}`))} testId="cc-hide" variant="secondary">
                            <EyeOff /> Ocultar (só visual)
                          </ActionButton>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                {visible.length < g.days.length && (
                  <p className="mt-2 text-xs text-muted-foreground" data-testid="conflict-kept-note">
                    {g.days.length - visible.length} {g.days.length - visible.length === 1 ? 'dia recolhido' : 'dias recolhidos'} só nesta tela. Nada foi alterado; a divergência continua e volta ao reabrir.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap gap-2 text-xs">
        {keptCount > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setKept(new Set())} data-testid="cc-restore">
            <RotateCcw /> Mostrar de novo os recolhidos
          </Button>
        )}
        {showInfo ? (
          <Button size="sm" variant="ghost" onClick={() => onShowInfo(false)} data-testid="cc-hide-info">
            <EyeOff /> Ocultar observações informativas (preferência de exibição)
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => onShowInfo(true)} data-testid="cc-show-info">
            <Info /> {hiddenInfo ? `Mostrar ${hiddenInfo} ${hiddenInfo === 1 ? 'observação informativa oculta' : 'observações informativas ocultas'}` : 'Mostrar observações informativas'}
          </Button>
        )}
      </div>
    </Card>
  );
}

function ActionButton({ children, onClick, testId, variant = 'outline' }: { children: React.ReactNode; onClick: () => void; testId: string; variant?: 'outline' | 'secondary' }) {
  return (
    <Button size="sm" variant={variant} className="h-auto min-h-11 whitespace-normal py-2 text-center leading-tight sm:min-h-9" onClick={onClick} data-testid={testId}>
      {children}
    </Button>
  );
}
