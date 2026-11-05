// Privacidade do Assistente IA central: o que é enviado à OpenAI, o que fica salvo na conta e como apagar
// conversas e memórias. Acesso permanente pelo ícone de escudo do chat.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, Plus, Stethoscope, Trash2, XCircle } from 'lucide-react';
import { MAX_MEMORY_CHARS, type AssistantStatusView, type MemoryView } from '@shared/assistant/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { ApiClientError, assistantApi } from '../api';
import { errorMessage } from './useAssistantChat';

// Fase 01: diagnóstico da OpenAI pelo endpoint já existente (POST /api/v1/assistant/test). Cada teste é uma consulta
// GRÁTIS à API oficial (GET /v1/models/{id}): confirma a chave e se o modelo existe para ela, sem gerar resposta paga.
const DIAG_TEXT: Record<string, string> = {
  ok: 'Disponível para a chave do servidor',
  model_unavailable: 'Modelo não encontrado para esta chave (confira o ID na configuração)',
  provider_auth_failed: 'A OpenAI recusou a chave',
  provider_forbidden: 'A chave não tem permissão para este modelo',
  provider_billing: 'Problema de faturamento/créditos na conta da OpenAI',
  provider_rate_limited: 'Limite de solicitações da OpenAI; tente em instantes',
  provider_unreachable: 'Sem conexão com a OpenAI a partir do servidor',
  provider_unavailable: 'Sem chave da OpenAI no servidor (OPENAI_API_KEY no irontrack-api)',
  timeout: 'A OpenAI demorou demais',
  rate_limited: 'Muitos testes seguidos; aguarde um minuto',
};

function OpenAiDiagnostics() {
  const [status, setStatus] = useState<AssistantStatusView | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    assistantApi.status().then(setStatus).catch(() => setStatus(null));
  }, []);
  const run = async () => {
    setRunning(true);
    setResults({});
    try {
      const s = await assistantApi.status();
      setStatus(s);
      const out: Record<string, string> = {};
      for (const m of s.models) {
        try {
          const r = await assistantApi.test(m.id);
          out[m.id] = r.result;
        } catch (e) {
          out[m.id] = e instanceof ApiClientError ? e.code : 'internal_error';
        }
        setResults({ ...out });
      }
      if (!s.models.length) out['—'] = s.availability === 'missing_key' ? 'provider_unavailable' : s.availability;
      setResults(out);
      setAt(new Date().toLocaleTimeString('pt-BR'));
    } catch (e) {
      toast.error(errorMessage(e).message);
    } finally {
      setRunning(false);
    }
  };
  return (
    <Card data-testid="openai-diagnostics">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-primary" /> Diagnóstico da OpenAI
        </CardTitle>
        <CardDescription>Confere no servidor, pela API oficial, se a chave é aceita e se cada modelo configurado existe. Sem custo: nenhuma resposta é gerada.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {status && (
          <p className="text-muted-foreground">
            Provedor: <strong className="text-foreground">{status.provider?.displayName ?? 'não configurado'}</strong> · estado: {status.provider?.health ?? status.availability}
            {status.provider?.checkedAt ? ` (verificado ${new Date(status.provider.checkedAt).toLocaleString('pt-BR')})` : ''}
          </p>
        )}
        <Button onClick={run} disabled={running} variant="outline" data-testid="openai-diagnostics-run">
          {running ? <Loader2 className="animate-spin" /> : <Stethoscope />} Testar conexão e modelos
        </Button>
        {Object.keys(results).length > 0 && (
          <ul className="space-y-1.5" data-testid="openai-diagnostics-results">
            {Object.entries(results).map(([model, r]) => (
              <li key={model} className="flex items-start gap-2 rounded-lg bg-secondary/60 px-3 py-2">
                {r === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
                <span className="min-w-0">
                  <span className="block font-mono text-xs">{model}</span>
                  <span className="text-xs text-muted-foreground">{DIAG_TEXT[r] ?? r}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {at && <p className="text-xs text-muted-foreground">Último teste às {at}. Créditos só se confirmam numa resposta real.</p>}
      </CardContent>
    </Card>
  );
}

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

      <OpenAiDiagnostics />

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
            O assistente nunca altera seus registros sozinho: criar ou mudar uma ficha, um hábito, uma rotina ou uma missão só acontece depois que você aprova a proposta, e a maioria das alterações aplicadas pode ser desfeita pelo cartão da proposta por 7 dias. A IA nunca concede XP. Os registros do servidor guardam só metadados
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
