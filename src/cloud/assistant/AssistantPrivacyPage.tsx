// Privacidade do Assistente IA central: o que é enviado à OpenAI, o que fica salvo na conta e como apagar
// conversas e memórias. Acesso permanente pelo ícone de escudo do chat.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, CheckCircle2, Loader2, Pencil, Plus, Stethoscope, Trash2, X, XCircle } from 'lucide-react';
import { MAX_MEMORY_CHARS, MEMORY_CATEGORIES, MEMORY_CATEGORY_LABEL, type AssistantStatusView, type MemoryCategory, type MemoryView } from '@shared/assistant/protocol.ts';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Input, NativeSelect } from '@/components/ui/input';
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
  const [category, setCategory] = useState<MemoryCategory>('other');
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const patch = async (id: string, p: Parameters<typeof assistantApi.updateMemory>[1]) => {
    try {
      setMemories((await assistantApi.updateMemory(id, p)).memories);
      setEditing(null);
    } catch (e) {
      toast.error(errorMessage(e).message);
    }
  };
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
            consultas aos seus registros (treinos, alimentação, hábitos, missões, leitura, estudos, Bíblia e agenda).
          </p>
          <p>
            Seus dados não são enviados todos de uma vez: a cada pergunta, a IA pede só as consultas de que precisa (resumos por período, não o banco inteiro), e o servidor
            responde apenas com os registros da sua conta. Reflexões espirituais privadas só são lidas quando você pede e a permissão está ligada em Bíblia → Ajustes. Fotos de progresso nunca são enviadas. Seu e-mail e sua senha não são enviados.
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
            O assistente nunca altera seus registros sozinho: criar ou mudar qualquer registro (inclusive um plano que envolve vários módulos) só acontece depois que você aprova a proposta, e se só parte de um plano for gravada o cartão mostra exatamente o que falhou; e a maioria das alterações aplicadas pode ser desfeita pelo cartão da proposta por 7 dias. A IA nunca concede XP. Os registros do servidor guardam só metadados
            de uso (quantidade de mensagens e tokens por dia), nunca o conteúdo das conversas.
          </p>
          <p>Excluir a conta apaga também as conversas, memórias e propostas.</p>
        </CardContent>
      </Card>

      <Card data-testid="privacy-photos">
        <CardHeader>
          <CardTitle>Fotos de refeições</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            A foto só sai do aparelho quando você toca em <em>Analisar</em> (em Alimentação) ou envia a mensagem com a foto anexada ao Assistente. Antes do envio, o app
            reduz a imagem e o servidor remove os metadados (localização, data, modelo do aparelho). O servidor do IronTrack envia a foto à OpenAI, que identifica os
            alimentos e estima as porções; as calorias e os macros são calculados pelo app com a tabela TACO.
          </p>
          <p>
            A foto <strong className="text-foreground">não é guardada</strong>: nem no servidor, nem no histórico das conversas, nem nos registros de uso. Junto com ela vai
            só a observação que você escrever, nunca o seu histórico. O resultado é uma estimativa: nada entra no diário sem a sua confirmação.
          </p>
          <p>Há um limite diário de análises por conta para controlar custos. O registro manual continua sempre disponível.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preferências salvas</CardTitle>
          <CardDescription>
            A IA usa estas preferências como contexto; os registros de cada módulo continuam sendo a fonte da verdade. Ela só guarda algo quando você pede ou aprova, e o que ela
            deduziu fica marcado como não confirmado até você confirmar.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {memories === null ? (
            <Loader2 className="animate-spin text-muted-foreground" aria-label="Carregando" />
          ) : memories.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma preferência salva.</p>
          ) : (
            <ul className="space-y-1.5" data-testid="assistant-memories">
              {memories.map((m) => (
                <li key={m.id} className="space-y-1.5 rounded-xl border px-3 py-2 text-sm" data-testid="assistant-memory" data-confirmed={m.confirmed}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary">{MEMORY_CATEGORY_LABEL[m.category] ?? 'Outro'}</Badge>
                    {!m.confirmed && <Badge variant="warn">Inferida pela IA, não confirmada</Badge>}
                    {m.expiresOn && <span className="text-[11px] text-muted-foreground">vale até {m.expiresOn.split('-').reverse().join('/')}</span>}
                  </div>
                  {editing?.id === m.id ? (
                    <form
                      className="flex gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (editing.content.trim()) void patch(m.id, { content: editing.content.trim() });
                      }}
                    >
                      <Input value={editing.content} maxLength={MAX_MEMORY_CHARS} onChange={(e) => setEditing({ id: m.id, content: e.target.value })} aria-label="Editar preferência" autoFocus />
                      <Button type="submit" size="icon-sm" aria-label="Salvar edição">
                        <Check />
                      </Button>
                      <Button type="button" size="icon-sm" variant="ghost" aria-label="Cancelar edição" onClick={() => setEditing(null)}>
                        <X />
                      </Button>
                    </form>
                  ) : (
                    <div className="flex items-start gap-1">
                      <span className="min-w-0 flex-1 break-words">{m.content}</span>
                      {!m.confirmed && (
                        <Button size="sm" variant="outline" onClick={() => void patch(m.id, { confirmed: true })} data-testid="assistant-memory-confirm">
                          Confirmar
                        </Button>
                      )}
                      <Button size="icon-sm" variant="ghost" aria-label={`Editar a preferência ${m.content}`} onClick={() => setEditing({ id: m.id, content: m.content })}>
                        <Pencil />
                      </Button>
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
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!draft.trim()) return;
              setBusy(true);
              try {
                setMemories((await assistantApi.addMemory(draft, category)).memories);
                setDraft('');
              } catch (err) {
                toast.error(errorMessage(err).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <NativeSelect className="w-full sm:w-44" value={category} onChange={(e) => setCategory(e.target.value as MemoryCategory)} aria-label="Categoria da preferência">
              {MEMORY_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {MEMORY_CATEGORY_LABEL[c]}
                </option>
              ))}
            </NativeSelect>
            <Input className="min-w-0 flex-1" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={MAX_MEMORY_CHARS} placeholder="Ex.: prefiro treinos de até 50 minutos" aria-label="Nova preferência" />
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
