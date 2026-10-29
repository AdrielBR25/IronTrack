// Assistente IA (IronTrack 2.0 F01/P05–P06): conversa em memória, seleção de dados, prévia do
// conteúdo efetivo e autorização por solicitação. Modo simulado (padrão, offline) ou remoto via
// gateway seguro, com provedor e modelo escolhidos explicitamente. Só leitura dos dados locais.
import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronDown, Cloud, FlaskConical, Loader2, Lock, Send, Square } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { NativeSelect, Textarea } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { DEMO_SCENARIOS, DEMO_SCENARIO_LABEL, type DemoScenario } from '@/integrations/ai/assistantService';
import { ASSISTANT_CATEGORIES } from '@/integrations/ai/contextSources';
import { CATEGORY_HINT, CATEGORY_LABEL, MAX_QUESTION_CHARS } from '@/features/assistant/assistantModel';
import { useAssistant, type AssistantDeps } from '@/features/assistant/useAssistant';
import { Conversation } from '@/features/assistant/Conversation';
import { SharePreviewDialog } from '@/features/assistant/SharePreviewDialog';
import { ConnectionStatus, ModeSelector, RemoteConnect } from '@/features/assistant/RemoteSetup';

export const DEMO_TITLE = 'Modo de demonstração — respostas simuladas';
export const REMOTE_TITLE = 'Modo remoto — compartilhamento externo';

function DataSelector({ a }: { a: ReturnType<typeof useAssistant> }) {
  const count = a.categories.length;
  const locked = a.phase === 'running' || a.phase === 'preparing';
  return (
    <details className="group rounded-2xl border bg-card" data-testid="data-selector">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl p-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-sm font-semibold">Dados que a IA pode usar</span>
          <span className="block truncate text-xs text-muted-foreground" data-testid="data-indicator">
            {count ? `${count} ${count === 1 ? 'categoria selecionada' : 'categorias selecionadas'}: ${a.categories.map((c) => CATEGORY_LABEL[c]).join(', ')}` : 'Nenhum dado selecionado: só a pergunta é usada'}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <fieldset className="space-y-1 border-t px-3.5 pb-3.5 pt-2" disabled={locked}>
        <legend className="sr-only">Categorias de dados</legend>
        {ASSISTANT_CATEGORIES.map((c) => (
          <label key={c} className="flex cursor-pointer items-start gap-3 rounded-xl p-2 hover:bg-accent/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
              checked={a.categories.includes(c)}
              onChange={() => a.toggleCategory(c)}
              aria-describedby={`hint-${c}`}
              data-testid={`cat-${c}`}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{CATEGORY_LABEL[c]}</span>
              <span id={`hint-${c}`} className="block text-xs text-muted-foreground">
                {CATEGORY_HINT[c]}
              </span>
            </span>
          </label>
        ))}
        <div className="flex items-start gap-3 rounded-xl p-2 opacity-60" data-testid="cat-progress_photos">
          <Lock className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{CATEGORY_LABEL.progress_photos}</span>
            <span className="block text-xs text-muted-foreground">{CATEGORY_HINT.progress_photos}</span>
          </span>
        </div>
        {count > 0 && (
          <Button variant="ghost" size="sm" onClick={a.clearCategories}>
            Desmarcar todas
          </Button>
        )}
      </fieldset>
    </details>
  );
}

export default function AIAssistantPage({ deps }: { deps?: Partial<AssistantDeps> }) {
  const a = useAssistant(deps);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const running = a.phase === 'running';
  const preparing = a.phase === 'preparing';
  const over = a.draft.trim().length > MAX_QUESTION_CHARS;
  const remote = a.mode === 'remote';
  // P20: atalhos do treino e dos detalhes do exercício chegam com o exercício na URL; a pergunta vem preenchida (nada é
  // enviado sozinho) e, se for sobre um exercício do catálogo, é respondida no aparelho.
  const [params] = useSearchParams();
  const exercise = params.get('exercicio');
  const fromWorkout = params.get('origem') === 'treino';
  const prefilled = useRef(false);
  useEffect(() => {
    if (exercise && !prefilled.current) {
      prefilled.current = true;
      a.setDraft(`Como executar ${exercise.slice(0, 80)} corretamente?`);
    }
  }, [exercise, a]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Assistente IA"
        subtitle="Pergunte sobre seus registros escolhendo o que pode ser usado."
        action={
          remote ? (
            <Badge variant="destructive" className="shrink-0" data-testid="remote-badge">
              <Cloud aria-hidden /> Remoto
            </Badge>
          ) : (
            <Badge variant="warn" className="shrink-0" data-testid="demo-badge">
              <FlaskConical aria-hidden /> Simulado
            </Badge>
          )
        }
      />

      {fromWorkout && (
        <Link to="/treino" className="inline-flex h-10 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="ai-back-workout">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Voltar ao treino (continua salvo)
        </Link>
      )}

      {remote ? (
        <Card className="flex gap-3 border-destructive/40 bg-destructive/10 p-3.5" role="note" data-testid="remote-banner">
          <Cloud className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 text-sm">
            <p className="font-semibold">{REMOTE_TITLE}</p>
            <p className="mt-0.5 text-muted-foreground">
              Ao autorizar uma pergunta, o conteúdo mostrado na prévia sai do aparelho: vai ao gateway e é repassado ao provedor escolhido, que o processa conforme as
              políticas dele. Nada é enviado sem a sua autorização, e só o que você selecionar. As respostas não são orientação médica ou nutricional. A conversa some ao
              sair ou recarregar a página.
            </p>
          </div>
        </Card>
      ) : (
        <Card className="flex gap-3 border-warn/40 bg-warn/10 p-3.5" role="note" data-testid="demo-banner">
          <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden />
          <div className="min-w-0 text-sm">
            <p className="font-semibold">{DEMO_TITLE}</p>
            <p className="mt-0.5 text-muted-foreground">
              Nenhuma IA real é usada e nada sai do aparelho. As respostas são fictícias: não analisam seus treinos nem suas avaliações e não são orientação de treino, médica
              ou nutricional. A conversa some ao sair ou recarregar a página.
            </p>
          </div>
        </Card>
      )}

      <Card className="space-y-3 p-3.5">
        <ConnectionStatus a={a} />
        <ModeSelector a={a} />
      </Card>
      {remote && <RemoteConnect a={a} onStart={() => inputRef.current?.focus()} />}

      <Conversation
        messages={a.messages}
        running={running}
        runningLabel={remote ? `Aguardando a resposta de ${a.provider?.displayName ?? 'provedor remoto'}…` : undefined}
        onRetry={a.retry}
        onSuggestion={(t) => {
          a.setDraft(t);
          inputRef.current?.focus();
        }}
        onClear={a.clearConversation}
        onAskAI={(q) => {
          a.askAIAnyway(q);
          inputRef.current?.focus();
        }}
      />

      <form
        className="space-y-3"
        aria-label="Nova pergunta"
        onSubmit={(e) => {
          e.preventDefault();
          void a.submit();
        }}
      >
        <DataSelector a={a} />

        <Card className="space-y-3 p-3.5">
          <div className="space-y-1.5">
            <label htmlFor="ai-question" className="text-sm font-semibold">
              Sua pergunta
            </label>
            <Textarea
              id="ai-question"
              ref={inputRef}
              rows={3}
              value={a.draft}
              placeholder="Ex.: como foi minha semana de treinos?"
              onChange={(e) => a.setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void a.submit();
                }
              }}
              onFocus={(e) => {
                // Teclado virtual: mantém o campo visível acima do teclado.
                const el = e.currentTarget;
                setTimeout(() => el.scrollIntoView?.({ block: 'center' }), 250);
              }}
              aria-invalid={!!a.notice || over}
              aria-describedby="ai-question-count ai-question-notice"
              className="min-h-[88px] resize-y scroll-mb-40"
              data-testid="ai-question"
            />
            <div className="flex items-start justify-between gap-3 text-xs">
              <p id="ai-question-notice" role="alert" className="min-w-0 text-destructive" data-testid="ai-notice">
                {a.notice}
              </p>
              <p id="ai-question-count" className={cn('shrink-0 tabular', over ? 'text-destructive' : 'text-muted-foreground')}>
                {a.draft.trim().length.toLocaleString('pt-BR')}/{MAX_QUESTION_CHARS.toLocaleString('pt-BR')}
              </p>
            </div>
          </div>

          {!remote && (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="ai-model" className="text-xs font-medium text-muted-foreground">
                Modelo ({a.provider?.displayName ?? 'nenhum provedor'})
              </label>
              <NativeSelect id="ai-model" value={a.modelId} onChange={(e) => a.setModel(e.target.value)} disabled={running || preparing} data-testid="ai-model">
                {a.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <label htmlFor="ai-scenario" className="text-xs font-medium text-muted-foreground">
                Cenário da demonstração
              </label>
              <NativeSelect id="ai-scenario" value={a.scenario} onChange={(e) => a.setScenario(e.target.value as DemoScenario)} disabled={running} data-testid="ai-scenario">
                {DEMO_SCENARIOS.map((s) => (
                  <option key={s} value={s}>
                    {DEMO_SCENARIO_LABEL[s]}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          )}

          <div className="flex gap-2">
            {running ? (
              <Button type="button" variant="destructive" className="flex-1" onClick={a.cancelRun} data-testid="ai-cancel-run">
                <Square aria-hidden /> Cancelar solicitação
              </Button>
            ) : (
              <Button ref={sendRef} type="submit" className="flex-1" aria-disabled={preparing} data-testid="ai-send">
                {preparing ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Send aria-hidden />}
                {preparing ? 'Preparando prévia…' : 'Revisar e enviar'}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Antes de executar, você verá exatamente o que seria compartilhado. Ctrl+Enter também envia.</p>
        </Card>
      </form>

      <SharePreviewDialog
        preview={a.preview}
        provider={a.provider}
        onCancel={a.closePreview}
        onAuthorize={() => void a.authorize()}
        onReprepare={a.reprepare}
        onClosed={() => (sendRef.current ?? inputRef.current)?.focus()}
      />
    </div>
  );
}
