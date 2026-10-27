// Área de conversa do assistente. Respostas são texto puro (React escapa): sem HTML, sem
// Markdown interpretado, sem links ou comandos executáveis.
import { useEffect, useRef } from 'react';
import { Ban, FlaskConical, Loader2, MessageCircleQuestion, RotateCcw, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ChatMessage } from './assistantModel';

export const SIMULATED_REPLY_NOTE = 'Resposta fictícia do modo de demonstração: não é uma análise real dos seus treinos ou avaliações, nem orientação de treino, médica ou nutricional.';

export const SUGGESTIONS = ['Como foi minha consistência de treinos?', 'Resuma minha evolução corporal.', 'O que mudou nos meus últimos treinos?'];

function UserBubble({ m, onRetry }: { m: ChatMessage; onRetry: (id: string) => void }) {
  const status =
    m.status === 'sending' ? 'Enviando…' : m.status === 'sent' ? 'Enviada' : m.status === 'cancelled' ? 'Cancelada' : m.status === 'failed' ? 'Não respondida' : undefined;
  return (
    <li className="flex flex-col items-end gap-1" data-testid="chat-user" data-status={m.status}>
      <span className="sr-only">Você:</span>
      <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary/15 px-3.5 py-2.5 text-sm">{m.text}</p>
      <p className="flex flex-wrap items-center justify-end gap-x-2 text-[11px] text-muted-foreground">
        {m.categories?.length ? <span>Dados: {m.categories.join(', ')}</span> : <span>Sem dados pessoais</span>}
        {status && <span>· {status}</span>}
      </p>
      {(m.status === 'failed' || m.status === 'cancelled') && (
        <div className="flex max-w-[85%] flex-col items-end gap-1" data-testid="chat-error">
          <p className={cn('flex items-start gap-1.5 text-xs', m.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
            {m.status === 'failed' ? <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
            {m.error}
          </p>
          <Button variant="ghost" size="sm" onClick={() => onRetry(m.id)}>
            <RotateCcw /> Editar e reenviar
          </Button>
        </div>
      )}
    </li>
  );
}

function AssistantBubble({ m }: { m: ChatMessage }) {
  return (
    <li className="flex flex-col items-start gap-1" data-testid="chat-assistant">
      <span className="sr-only">{m.simulated ? 'Assistente (simulação):' : 'Assistente:'}</span>
      <div className="max-w-[90%] rounded-2xl rounded-bl-md border bg-card px-3.5 py-2.5 text-sm">
        {m.simulated && (
          <Badge variant="warn" className="mb-1.5">
            <FlaskConical aria-hidden /> Simulação
          </Badge>
        )}
        <p className="whitespace-pre-wrap break-words">{m.text}</p>
        {m.truncated && <p className="mt-1 text-xs text-muted-foreground">Resposta cortada no limite de tamanho.</p>}
        {m.simulated && <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">{SIMULATED_REPLY_NOTE}</p>}
      </div>
    </li>
  );
}

export function Conversation({ messages, running, onRetry, onSuggestion }: { messages: ChatMessage[]; running: boolean; onRetry: (id: string) => void; onSuggestion: (t: string) => void }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [messages.length, running]);

  if (!messages.length && !running)
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed px-4 py-8 text-center" data-testid="chat-empty">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
          <MessageCircleQuestion className="h-6 w-6" aria-hidden />
        </span>
        <div>
          <p className="font-display text-lg font-semibold">Faça uma pergunta</p>
          <p className="mt-1 text-sm text-muted-foreground">Você escolhe quais dados podem ser usados e revisa tudo antes de executar.</p>
        </div>
        <ul className="flex flex-wrap justify-center gap-2" aria-label="Sugestões de pergunta">
          {SUGGESTIONS.map((s) => (
            <li key={s}>
              <Button variant="outline" size="sm" className="h-auto whitespace-normal py-1.5 text-left" onClick={() => onSuggestion(s)}>
                {s}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <div>
      <ol className="space-y-4" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversa com o assistente" data-testid="chat-log">
        {messages.map((m) => (m.role === 'user' ? <UserBubble key={m.id} m={m} onRetry={onRetry} /> : <AssistantBubble key={m.id} m={m} />))}
      </ol>
      {running && (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground" role="status" data-testid="chat-running">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> Gerando resposta simulada…
        </p>
      )}
      <div ref={endRef} />
    </div>
  );
}
