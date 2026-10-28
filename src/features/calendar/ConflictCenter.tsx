import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, BookmarkCheck, CalendarDays, EyeOff, History, Info, ListRestart, Pencil, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fmtDayLong } from '@/features/planner/plannerFormat';
import { cn } from '@/lib/utils';
import { groupConflicts, rememberOption, type CalendarConflict, type ConflictGroupDay, type ResolvedDay } from '@/modules/calendar';
import { rememberFromScreen } from './decisionUi';

// Central "Revisar divergências" (IronTrack 2.0 F01/P15, docs/CONSOLIDACAO_AGENDAS.md §9). Agrupa as divergências da
// semana exibida, diz a origem e o impacto e oferece ações contextuais. Regras:
//  - nada é marcado como resolvido por fechar ou recolher: "Manter planejamento atual" e "ocultar" são SÓ VISUAIS
//    (rotulados assim, valem enquanto a tela está aberta) e a divergência volta ao reabrir;
//  - a única decisão gravada é "Usar a agenda anterior só neste dia", que cria a exceção da data no planejamento
//    (com confirmação) — e então a divergência deixa de existir de fato;
//  - avisos relevantes nunca são escondidos pelas preferências; só as observações informativas.
// P16 (docs/DECISOES_CALENDARIO.md §6): as ações de cada dia vêm em dois blocos rotulados — "Decisão de exibição"
// (lembrar "manter planejamento" ou ocultar uma observação; NÃO altera treinos) e "Alteração de planejamento" (usar a
// agenda antiga só neste dia; cria a exceção da data, com confirmação). "Continuar exibindo" é o recolher só visual do
// P15. Conflitos com decisão lembrada valendo saem da lista e são contados à parte, com acesso a "Rever decisões".

export interface ConflictCenterProps {
  days: ResolvedDay[];
  showInfo: boolean;
  onShowInfo: (v: boolean) => void;
  onOpenDay: (date: string) => void;
  onEditDay: (date: string) => void;
  onUseLegacy: (date: string, choice: NonNullable<ConflictGroupDay['legacyChoice']>) => void;
  rangeLabel: string;
  /** Abre "Decisões lembradas" (rever decisões anteriores). */
  onReviewDecisions?: () => void;
  reviewOpen?: boolean;
}

export function ConflictCenter({ days, showInfo, onShowInfo, onOpenDay, onEditDay, onUseLegacy, rangeLabel, onReviewDecisions, reviewOpen = false }: ConflictCenterProps) {
  const [kept, setKept] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const groups = groupConflicts(days, { includeInfo: showInfo });
  const rememberedHere = groupConflicts(days, { includeInfo: true, remembered: true }).reduce((a, g) => a + g.days.length, 0);
  const remember = async (date: string, c: CalendarConflict, decision: 'keep_plan' | 'hide_info') => {
    setBusy(true);
    try {
      await rememberFromScreen(date, c, decision);
    } finally {
      setBusy(false);
    }
  };
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
                  {visible.map((d) => {
                    // Um conflito por tipo e dia: o primeiro é o que a decisão lembrada identifica.
                    const conflict = d.conflicts[0];
                    const option = rememberOption(d, conflict);
                    return (
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
                      </div>
                      <div className="mt-2 space-y-1.5 rounded-lg border border-dashed p-2" role="group" aria-label="Decisão de exibição: não altera treinos" data-testid="cc-display-actions">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Decisão de exibição · não altera treinos</p>
                        <div className="grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap">
                          {option === 'keep_plan' && (
                            <ActionButton onClick={() => void remember(d.date, conflict, 'keep_plan')} testId="cc-remember" variant="default" disabled={busy}>
                              <BookmarkCheck /> Manter planejamento e lembrar
                            </ActionButton>
                          )}
                          {option === 'hide_info' && (
                            <ActionButton onClick={() => void remember(d.date, conflict, 'hide_info')} testId="cc-hide-remember" variant="default" disabled={busy}>
                              <EyeOff /> Ocultar esta observação e lembrar
                            </ActionButton>
                          )}
                          {g.kind.startsWith('plan_') && g.severity === 'warning' ? (
                            <ActionButton onClick={() => setKept((s) => new Set(s).add(`${g.id}|${d.date}`))} testId="cc-keep" variant="secondary">
                              Continuar exibindo (recolher só agora)
                            </ActionButton>
                          ) : (
                            <ActionButton onClick={() => setKept((s) => new Set(s).add(`${g.id}|${d.date}`))} testId="cc-hide" variant="secondary">
                              Continuar exibindo (recolher só agora)
                            </ActionButton>
                          )}
                        </div>
                        {option && <p className="text-[11px] text-muted-foreground">Lembrar vale só para esta divergência, neste dia, enquanto nada mudar. Se o planejamento ou a agenda mudarem, o aviso volta.</p>}
                      </div>
                      {d.legacyChoice && (
                        <div className="mt-2 space-y-1.5 rounded-lg border border-warn/40 p-2" role="group" aria-label="Alteração de planejamento: modifica a exceção do dia" data-testid="cc-plan-actions">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-warn">Alteração de planejamento · modifica a exceção do dia</p>
                          <ActionButton onClick={() => onUseLegacy(d.date, d.legacyChoice!)} testId="cc-use-legacy">
                            Usar a agenda antiga só neste dia ({d.legacyChoice.label})
                          </ActionButton>
                          <p className="text-[11px] text-muted-foreground">Pede confirmação antes de gravar. O planejamento semanal, a agenda antiga e a rotação não mudam.</p>
                        </div>
                      )}
                    </li>
                    );
                  })}
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

      {rememberedHere > 0 && (
        <p className="flex items-start gap-2 rounded-xl bg-secondary/50 p-3 text-xs" data-testid="cc-remembered-count">
          <BookmarkCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>
            {rememberedHere === 1 ? '1 aviso deste período tem decisão lembrada' : `${rememberedHere} avisos deste período têm decisão lembrada`} e não aparece como novo. Nenhum treino foi alterado.
          </span>
        </p>
      )}

      <div className="flex flex-wrap gap-2 text-xs">
        {onReviewDecisions && (
          <Button size="sm" variant="outline" onClick={onReviewDecisions} aria-expanded={reviewOpen} data-testid="cc-review-decisions">
            <ListRestart /> {reviewOpen ? 'Fechar decisões lembradas' : 'Rever decisões anteriores'}
          </Button>
        )}
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

function ActionButton({ children, onClick, testId, variant = 'outline', disabled = false }: { children: React.ReactNode; onClick: () => void; testId: string; variant?: 'outline' | 'secondary' | 'default'; disabled?: boolean }) {
  return (
    <Button size="sm" variant={variant} className="h-auto min-h-11 whitespace-normal py-2 text-center leading-tight sm:min-h-9" onClick={onClick} disabled={disabled} data-testid={testId}>
      {children}
    </Button>
  );
}
