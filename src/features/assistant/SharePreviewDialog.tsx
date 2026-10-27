// Prévia de compartilhamento: mostra o conteúdo EFETIVO preparado pelo AIService (destino,
// finalidade, pergunta, categorias e os dados exatos) antes de qualquer execução.
// Todo texto é renderizado como texto (React escapa): nada de HTML vindo dos dados.
import { useRef } from 'react';
import { AlertTriangle, FlaskConical, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fmtNum } from '@/lib/utils';
import type { AIContextCategory, AIContextData, AIProviderDescriptor } from '@/modules/ai';
import { ASSISTANT_CATEGORIES } from '@/integrations/ai/contextSources';
import { CATEGORY_LABEL, NO_DATA_TEXT, PURPOSE_LABEL } from './assistantModel';
import type { AssistantPreview } from './useAssistant';

const n = (v: number | undefined, d: 0 | 1 | 2 = 1) => (v === undefined ? '—' : fmtNum(v, d));

const BODY_FIELD_LABEL: Record<string, [string, string]> = {
  weightKg: ['Peso', 'kg'],
  bodyFatPct: ['% gordura', '%'],
  fatMassKg: ['Massa gorda', 'kg'],
  leanMassKg: ['Massa magra', 'kg'],
  leanPct: ['% massa magra', '%'],
  waistCm: ['Cintura', 'cm'],
  abdomenCm: ['Abdômen', 'cm'],
  hipCm: ['Quadril', 'cm'],
  armCm: ['Braço', 'cm'],
  thighCm: ['Coxa', 'cm'],
  waistHipRatio: ['Cintura/quadril', ''],
  bmi: ['IMC', ''],
  skinfoldSumMm: ['Soma de dobras', 'mm'],
};

const VERDICT_LABEL: Record<string, string> = { better: 'melhorou', worse: 'piorou', same: 'estável', neutral: 'variou' };

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="space-y-1.5" data-testid={testId}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** Dados incluídos, por categoria, em forma legível (o JSON exato fica logo abaixo). */
function IncludedData({ category, data }: { category: AIContextCategory; data: AIContextData }) {
  const box = 'rounded-xl border bg-background/50 p-3 text-sm';
  if (category === 'training_summary' && data.training_summary) {
    const s = data.training_summary;
    return (
      <div className={box}>
        <p>
          Últimos {n(s.periodDays, 0)} dias: {n(s.sessions, 0)} treinos, {n(s.totalSets, 0)} séries válidas, volume {n(s.totalVolumeKg, 0)} kg, consistência {n(s.consistencyPct, 0)}%.
        </p>
        {s.muscleGroups && <p className="mt-1 text-muted-foreground">Séries por grupo: {s.muscleGroups.map((g) => `${g.name} ${g.sets}`).join(', ')}.</p>}
      </div>
    );
  }
  if (category === 'training_history' && data.training_history) {
    return (
      <ul className="space-y-2">
        {data.training_history.map((s, i) => (
          <li key={i} className={box}>
            <p className="font-medium">
              {s.date}
              {s.workout ? ` · ${s.workout}` : ''}
              {s.durationMin !== undefined ? ` · ${s.durationMin} min` : ''}
            </p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {s.exercises.map((e, j) => (
                <li key={j} className="break-words">
                  {e.name}
                  {e.muscleGroup ? ` (${e.muscleGroup})` : ''}: {e.sets.length ? e.sets.map((x) => `${x.type === 'warmup' ? 'aq. ' : ''}${n(x.weightKg)} kg × ${n(x.reps, 0)}`).join(', ') : 'sem séries feitas'}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    );
  }
  if (category === 'body_measurements' && data.body_measurements) {
    return (
      <ul className="space-y-2">
        {data.body_measurements.map((e, i) => (
          <li key={i} className={box}>
            <p className="font-medium">{e.date}</p>
            <p className="mt-0.5 break-words text-muted-foreground">
              {Object.entries(e)
                .filter(([k]) => k !== 'date')
                .map(([k, v]) => `${BODY_FIELD_LABEL[k]?.[0] ?? k} ${n(v as number, k === 'waistHipRatio' ? 2 : 1)}${BODY_FIELD_LABEL[k]?.[1] ? ` ${BODY_FIELD_LABEL[k][1]}` : ''}`)
                .join(' · ')}
            </p>
          </li>
        ))}
      </ul>
    );
  }
  if (category === 'body_evolution' && data.body_evolution) {
    return (
      <ul className={`${box} space-y-0.5`}>
        {data.body_evolution.map((c, i) => (
          <li key={i} className="break-words">
            {c.metric}: {n(c.first, 2)} → {n(c.last, 2)} {c.unit} ({c.delta > 0 ? '+' : ''}
            {n(c.delta, 2)}){c.verdict ? `, ${VERDICT_LABEL[c.verdict] ?? c.verdict}` : ''}
          </li>
        ))}
      </ul>
    );
  }
  if (category === 'profile_preferences' && data.profile_preferences) {
    const p = data.profile_preferences;
    return (
      <div className={box}>
        Unidade {p.weightUnit ?? '—'} · {p.trainingDaysPerWeek ?? '—'} dias de treino por semana · objetivo: {p.goal ?? '—'}
      </div>
    );
  }
  return null;
}

export function SharePreviewDialog({
  preview,
  provider,
  onCancel,
  onAuthorize,
  onReprepare,
  onClosed,
}: {
  preview: AssistantPreview | null;
  provider: AIProviderDescriptor | undefined;
  onCancel: () => void;
  onAuthorize: () => void;
  onReprepare: () => void;
  /** Para onde o foco volta ao fechar. */
  onClosed: () => void;
}) {
  const topRef = useRef<HTMLDivElement>(null);
  const p = preview?.prepared;
  const model = provider?.models.find((m) => m.id === p?.modelId);
  const included = p?.context.included ?? [];
  const noData = p?.context.excluded.filter((x) => x.reason === 'no_data').map((x) => x.category) ?? [];
  const notSelected = ASSISTANT_CATEGORIES.filter((c) => !preview?.selected.includes(c));
  const busy = !!preview?.verifying;

  return (
    <Dialog open={!!preview} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent
        data-testid="share-preview"
        aria-describedby="share-preview-desc"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          topRef.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onClosed();
        }}
        className="pb-0 sm:pb-0"
      >
        {preview && p && (
          <>
            <div ref={topRef} tabIndex={-1} className="space-y-4 outline-none">
              <DialogHeader>
                <DialogTitle>Revise o que será compartilhado</DialogTitle>
                <DialogDescription id="share-preview-desc">
                  Nada é executado até você autorizar. A autorização vale só para esta pergunta, com estes dados.
                </DialogDescription>
              </DialogHeader>

              <div className="flex gap-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm" role="note" data-testid="preview-simulated-note">
                <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
                <p>
                  <strong>Modo de demonstração — respostas simuladas.</strong> A execução usa um provedor simulado no próprio aparelho: nada sai do aparelho e a resposta é
                  fictícia.
                </p>
              </div>

              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Provedor</dt>
                <dd className="min-w-0 break-words" data-testid="preview-provider">
                  {provider?.displayName ?? p.providerId} {provider?.kind === 'simulated' && <Badge variant="warn">simulado</Badge>}
                </dd>
                <dt className="text-muted-foreground">Modelo</dt>
                <dd className="min-w-0 break-words" data-testid="preview-model">
                  {model?.displayName ?? p.modelId}
                </dd>
                <dt className="text-muted-foreground">Finalidade</dt>
                <dd className="min-w-0 break-words" data-testid="preview-purpose">
                  {PURPOSE_LABEL[p.purpose]}
                </dd>
              </dl>

              <Section title="Pergunta enviada">
                <p className="whitespace-pre-wrap break-words rounded-xl border bg-background/50 p-3 text-sm" data-testid="preview-question">
                  {preview.question}
                </p>
              </Section>

              <Section title="Categorias autorizadas" testId="preview-categories">
                {p.categories.length ? (
                  <ul className="flex flex-wrap gap-1.5">
                    {p.categories.map((c) => (
                      <li key={c}>
                        <Badge>{CATEGORY_LABEL[c]}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">Nenhuma. Só a pergunta será usada, sem dados pessoais.</p>
                )}
              </Section>

              {included.length > 0 && (
                <Section title="Dados efetivamente incluídos" testId="preview-included">
                  <div className="space-y-3">
                    {included.map((c) => (
                      <div key={c} className="space-y-1.5" data-testid={`preview-data-${c}`}>
                        <p className="text-sm font-medium">{CATEGORY_LABEL[c]}</p>
                        <IncludedData category={c} data={p.context.data} />
                      </div>
                    ))}
                    {p.context.truncated && <p className="text-xs text-muted-foreground">Para caber no limite, os registros mais antigos ficaram de fora.</p>}
                  </div>
                </Section>
              )}

              {noData.length > 0 && (
                <Section title="Categorias sem dados" testId="preview-no-data">
                  <ul className="space-y-1 text-sm">
                    {noData.map((c) => (
                      <li key={c}>
                        <span className="font-medium">{CATEGORY_LABEL[c]}:</span> <span className="text-muted-foreground">{NO_DATA_TEXT[c]} Nada foi preenchido no lugar.</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              <Section title="Categorias excluídas" testId="preview-excluded">
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {notSelected.map((c) => (
                    <li key={c}>{CATEGORY_LABEL[c]}: não selecionada</li>
                  ))}
                  <li>{CATEGORY_LABEL.progress_photos}: bloqueada (fotos nunca são compartilhadas)</li>
                  <li>IDs internos, perfil, nome, observações livres e fotos: nunca incluídos</li>
                </ul>
              </Section>

              <details className="rounded-xl border p-3 text-sm" data-testid="preview-raw">
                <summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Ver o conteúdo exato da solicitação</summary>
                <div className="mt-2 space-y-2">
                  {p.request.messages.map((m, i) => (
                    <div key={i}>
                      <p className="text-xs font-semibold uppercase text-muted-foreground">{m.role === 'system' ? 'Instrução fixa do app' : p.request.messages.length === 1 ? 'Mensagem única: instrução do app, pergunta e dados' : 'Mensagem com a pergunta e os dados'}</p>
                      <pre className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-background/60 p-2 font-mono text-xs">{m.content}</pre>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    Limite de resposta: {p.request.maxOutputTokens} tokens · {p.context.chars.toLocaleString('pt-BR')} caracteres de dados.
                  </p>
                </div>
              </details>

              {preview.stale && (
                <div className="flex gap-2 rounded-xl border border-destructive/50 bg-destructive/10 p-3 text-sm" role="alert" data-testid="preview-stale">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                  <p>
                    {preview.stale === 'data_changed'
                      ? 'Seus registros mudaram depois desta prévia (talvez em outra aba). Para não usar dados desatualizados nem acrescentar dados sem a sua revisão, prepare a prévia de novo.'
                      : 'Esta prévia expirou. Prepare de novo para revisar e autorizar.'}
                  </p>
                </div>
              )}
            </div>

            <DialogFooter className="sticky bottom-0 -mx-5 mt-auto border-t bg-popover px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 sm:pb-5">
              <Button variant="outline" onClick={onCancel} data-testid="preview-cancel">
                Cancelar
              </Button>
              {preview.stale ? (
                <Button onClick={onReprepare} data-testid="preview-reprepare">
                  <RefreshCw /> Preparar novamente
                </Button>
              ) : (
                <Button onClick={onAuthorize} aria-disabled={busy} data-testid="preview-authorize">
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />} {busy ? 'Conferindo dados…' : 'Autorizar e executar'}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
