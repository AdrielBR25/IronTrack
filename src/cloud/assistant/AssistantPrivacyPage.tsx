// Privacidade do Assistente IA central: o que é enviado à OpenAI, o que fica salvo na conta e como apagar
// conversas e memórias. Acesso permanente pelo ícone de escudo do chat.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { MAX_MEMORY_CHARS, type MemoryView } from '@shared/assistant/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { assistantApi } from '../api';
import { errorMessage } from './useAssistantChat';

export default function AssistantPrivacyPage() {
  const [memories, setMemories] = useState<MemoryView[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'conversations' | 'memories' | null>(null);

  const load = async () => {
    try {
      setMemories((await assistantApi.memories()).memories);
    } catch (e) {
      toast.error(errorMessage(e).message);
      setMemories([]);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="space-y-4" data-testid="assistant-privacy">
      <PageHeader title="Privacidade do assistente" subtitle="Como a IA usa seus dados e como apagar o que ela guarda." />

      <Card>
        <CardHeader>
          <CardTitle>O que é enviado e para quem</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            O assistente usa a <strong className="text-foreground">API da OpenAI</strong>. O servidor do IronTrack envia à OpenAI: as instruções do assistente, as mensagens recentes
            da conversa, um resumo das mensagens antigas (em conversas longas), as preferências que você pediu para lembrar e, quando a pergunta precisa, o resultado das
            consultas aos seus registros (fichas, treinos, séries, metas e medidas).
          </p>
          <p>
            Os dados de treino não são enviados todos de uma vez: a cada pergunta, a IA pede só as consultas de que precisa, e o servidor responde apenas com os registros da
            sua conta. Fotos de progresso nunca são enviadas. Seu e-mail e sua senha não são enviados.
          </p>
          <p>
            A chave da OpenAI fica só no servidor do IronTrack. As chamadas são feitas sem pedir que a OpenAI armazene as respostas para consulta posterior. Pela política da
            OpenAI para a API, os dados não são usados para treinar modelos por padrão e podem ficar retidos por ela por um período limitado para monitoramento de abuso.
            Consulte as políticas atuais em openai.com/policies.
          </p>
          <p>Respostas da IA podem conter erros. Elas não são orientação médica, nutricional ou de treino profissional.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>O que fica salvo na sua conta</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>O histórico das conversas, os resumos automáticos das conversas longas, as preferências salvas e as propostas de alteração (com a decisão que você tomou).</p>
          <p>
            O assistente nunca altera seus registros sozinho: criar ou mudar uma ficha só acontece depois que você aprova a proposta. Os registros do servidor guardam só metadados
            de uso (quantidade de mensagens e tokens por dia), nunca o conteúdo das conversas.
          </p>
          <p>Excluir a conta apaga também as conversas, memórias e propostas.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preferências salvas</CardTitle>
          <CardDescription>A IA usa estas preferências como contexto. Elas não são registros de treino.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {memories === null ? (
            <Loader2 className="animate-spin text-muted-foreground" aria-label="Carregando" />
          ) : memories.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma preferência salva.</p>
          ) : (
            <ul className="space-y-1.5" data-testid="assistant-memories">
              {memories.map((m) => (
                <li key={m.id} className="flex items-start gap-2 rounded-xl border px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 break-words">{m.content}</span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Apagar a preferência ${m.content}`}
                    onClick={async () => {
                      try {
                        await assistantApi.removeMemory(m.id);
                        await load();
                      } catch (e) {
                        toast.error(errorMessage(e).message);
                      }
                    }}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!draft.trim()) return;
              setBusy(true);
              try {
                setMemories((await assistantApi.addMemory(draft)).memories);
                setDraft('');
              } catch (err) {
                toast.error(errorMessage(err).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={MAX_MEMORY_CHARS} placeholder="Ex.: prefiro treinos de até 50 minutos" aria-label="Nova preferência" />
            <Button type="submit" variant="secondary" disabled={busy || !draft.trim()}>
              <Plus aria-hidden /> Salvar
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Apagar dados do assistente</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 sm:flex-row">
          <Button variant="destructive" onClick={() => setConfirm('conversations')} data-testid="assistant-delete-conversations">
            <Trash2 aria-hidden /> Apagar todas as conversas
          </Button>
          <Button variant="outline" onClick={() => setConfirm('memories')}>
            <Trash2 aria-hidden /> Apagar todas as preferências
          </Button>
        </CardContent>
      </Card>

      <p className="px-1 text-xs text-muted-foreground">
        O assistente anterior (com escolha manual dos dados enviados) continua disponível em{' '}
        <Link to="/assistente/classico" className="underline underline-offset-2">
          assistente clássico
        </Link>
        .
      </p>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === 'conversations' ? 'Apagar todas as conversas?' : 'Apagar todas as preferências?'}
        description={confirm === 'conversations' ? 'As mensagens e propostas pendentes saem da sua conta. Seus treinos e fichas não são afetados.' : 'O assistente deixa de usar essas preferências.'}
        confirmLabel="Apagar"
        destructive
        onConfirm={async () => {
          try {
            if (confirm === 'conversations') {
              const r = await assistantApi.removeAll();
              toast.success(`${r.deleted} conversa(s) apagada(s).`);
            } else {
              await assistantApi.removeAllMemories();
              await load();
              toast.success('Preferências apagadas.');
            }
          } catch (e) {
            toast.error(errorMessage(e).message);
          }
        }}
      />
    </div>
  );
}
