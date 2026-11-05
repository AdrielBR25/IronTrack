// Assistente IA central (Fase 00): chat com a OpenAI pelo servidor do IronTrack, histórico por conta, respostas em
// streaming com Markdown, consulta aos registros reais por ferramentas e propostas de alteração que só são aplicadas
// depois da aprovação explícita da pessoa. Detalhes de privacidade em #/assistente/privacidade.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Camera, Check, CircleAlert, History, ImageOff, Loader2, MessageSquarePlus, Pencil, SendHorizontal, Shield, Sparkles, Square, Trash2, Undo2, Wrench, X } from 'lucide-react';
import { MAX_USER_MESSAGE_CHARS, type ActionView, type MessageView } from '@shared/assistant/protocol.ts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Markdown } from './Markdown';
import { PHOTO_NOTICE_VERSION } from '@shared/nutrition/vision.ts';
import { nutritionApi } from '../nutrition/api';
import { PhotoNotice } from '../nutrition/photo/MealPhotoFlow';
import { PhotoPrepError, preparePhoto, type PreparedPhoto } from '../nutrition/photo/image';
import { errorMessage, useAssistantChat, type AssistantChat, type LiveTool } from './useAssistantChat';

export const SUGGESTIONS = [
  'Como foi minha evolução no supino nos últimos três meses?',
  'Quais missões ainda faltam hoje?',
  'Crie uma rotina matinal para mim.',
  'Qual foi meu treino mais recente?',
  'Quais metas ainda não cumpri?',
  'Com base nos meus registros, o que posso melhorar?',
];

const AVAILABILITY_TEXT: Record<string, string> = {
  disabled: 'O assistente está desativado neste servidor.',
  missing_key: 'A IA ainda não foi configurada no servidor (falta a chave da OpenAI). Quem administra o IronTrack precisa configurá-la.',
  invalid_key_format: 'A chave da OpenAI configurada no servidor não tem o formato esperado.',
  auth_failed: 'A OpenAI recusou a chave configurada no servidor.',
  email_not_verified: 'Confirme seu e-mail para usar o assistente.',
};

function NoticeDialog({ chat }: { chat: AssistantChat }) {
  const s = chat.status;
  const open = !!s && s.availability !== 'disabled' && (s.notice.acceptedVersion ?? 0) < s.notice.version;
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open}>
      <DialogContent hideClose data-testid="assistant-notice">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" aria-hidden /> Antes de começar
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                Suas mensagens e os dados de treino que o assistente consultar para responder são enviados pelo servidor do IronTrack à <strong>OpenAI</strong>, que os
                processa para gerar a resposta. O histórico das conversas fica salvo na sua conta.
              </p>
              <p>O assistente só lê o necessário para cada pergunta e nunca altera seus registros sem você aprovar. Fotos não são enviadas.</p>
              <p>
                Detalhes, retenção e como apagar tudo:{' '}
                <Link to="/assistente/privacidade" className="font-medium text-primary underline underline-offset-2">
                  Privacidade do assistente
                </Link>
                .
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button asChild variant="secondary">
            <Link to="/">Agora não</Link>
          </Button>
          <Button
            disabled={busy}
            data-testid="assistant-notice-accept"
            onClick={async () => {
              setBusy(true);
              try {
                await chat.acceptNotice();
              } catch {
                toast.error('Não foi possível confirmar agora. Tente de novo.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 className="animate-spin" aria-hidden />} Entendi, continuar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConversationsDialog({ chat, open, onOpenChange }: { chat: AssistantChat; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="assistant-conversations">
          <DialogHeader>
            <DialogTitle>Conversas</DialogTitle>
            <DialogDescription>Salvas na sua conta. Toque para abrir.</DialogDescription>
          </DialogHeader>
          <Button
            variant="secondary"
            onClick={() => {
              void chat.open(null);
              onOpenChange(false);
            }}
          >
            <MessageSquarePlus aria-hidden /> Nova conversa
          </Button>
          {chat.conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma conversa ainda.</p>
          ) : (
            <ul className="-mx-1 space-y-1">
              {chat.conversations.map((c) => (
                <li key={c.id} className={cn('flex items-center gap-1 rounded-xl px-1', c.id === chat.conversationId && 'bg-accent/60')} data-testid="assistant-conversation-item">
                  {editing?.id === c.id ? (
                    <form
                      className="flex min-w-0 flex-1 items-center gap-1 py-1"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        try {
                          await chat.rename(c.id, editing.title);
                          setEditing(null);
                        } catch {
                          toast.error('Não foi possível renomear.');
                        }
                      }}
                    >
                      <Input value={editing.title} maxLength={120} autoFocus aria-label="Novo nome da conversa" onChange={(e) => setEditing({ id: c.id, title: e.target.value })} className="h-9" />
                      <Button type="submit" size="icon-sm" variant="ghost" aria-label="Salvar nome">
                        <Check />
                      </Button>
                      <Button type="button" size="icon-sm" variant="ghost" aria-label="Cancelar" onClick={() => setEditing(null)}>
                        <X />
                      </Button>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="min-w-0 flex-1 rounded-lg px-2 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => {
                          void chat.open(c.id);
                          onOpenChange(false);
                        }}
                      >
                        <span className="block truncate text-sm font-medium">{c.title}</span>
                        <span className="block text-xs text-muted-foreground">{new Date(c.updatedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span>
                      </button>
                      <Button size="icon-sm" variant="ghost" aria-label={`Renomear ${c.title}`} onClick={() => setEditing({ id: c.id, title: c.title })}>
                        <Pencil />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={`Apagar ${c.title}`} onClick={() => setDeleting(c.id)}>
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Apagar esta conversa?"
        description="As mensagens saem da sua conta. Seus treinos e fichas não são afetados."
        confirmLabel="Apagar"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await chat.remove(deleting);
            toast.success('Conversa apagada.');
          } catch {
            toast.error('Não foi possível apagar.');
          }
        }}
      />
    </>
  );
}

const LINE_STYLE = { add: 'text-emerald-600 dark:text-emerald-400', remove: 'text-destructive', change: 'text-warn', info: 'text-muted-foreground' } as const;
const LINE_MARK = { add: '+', remove: '−', change: '~', info: '·' } as const;

const RESULT_LINK: Record<string, { to: string; label: string }> = {
  routines: { to: '/treinos', label: 'Ver fichas' },
  habits: { to: '/missoes?aba=habitos', label: 'Ver hábitos' },
  life_routines: { to: '/missoes?aba=rotinas', label: 'Ver rotinas' },
  missions: { to: '/missoes?aba=desafios', label: 'Ver missões' },
  meals: { to: '/alimentacao', label: 'Ver alimentação' },
  meal_plan: { to: '/alimentacao/planejar', label: 'Ver planejamento' },
  foods: { to: '/alimentacao/alimentos', label: 'Ver alimentos' },
  nutrition_goals: { to: '/alimentacao/metas', label: 'Ver metas' },
};

function ProposalCard({ action, onDecide, onUndo }: { action: ActionView; onDecide: (id: string, approve: boolean) => Promise<ActionView | null>; onUndo: (id: string) => Promise<ActionView | null> }) {
  const [busy, setBusy] = useState<'approve' | 'reject' | 'undo' | null>(null);
  const undo = async () => {
    setBusy('undo');
    const r = await onUndo(action.id);
    setBusy(null);
    if (r?.status === 'reverted') toast.success('Alteração desfeita.');
  };
  const decide = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'reject');
    const r = await onDecide(action.id, approve);
    setBusy(null);
    if (r?.status === 'applied') toast.success('Alteração aplicada.');
  };
  const pending = action.status === 'pending';
  return (
    <Card className={cn('w-full max-w-[92%] space-y-3 border-primary/40 p-3.5', !pending && 'opacity-90')} data-testid="assistant-proposal" data-status={action.status}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">Proposta da IA · precisa da sua aprovação</p>
          <p className="mt-0.5 text-sm font-semibold">{action.title}</p>
        </div>
        <Badge variant={action.status === 'applied' ? 'default' : action.status === 'pending' ? 'warn' : 'outline'} className="shrink-0">
          {{ pending: 'Aguardando', applied: 'Aplicada', rejected: 'Cancelada', expired: 'Expirada', failed: 'Não aplicada', reverted: 'Desfeita' }[action.status]}
        </Badge>
      </div>
      {action.rationale && (
        <p className="rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-semibold">Sugestão da IA:</span> {action.rationale}
        </p>
      )}
      <div className="space-y-2.5" data-testid="assistant-proposal-preview">
        {action.preview.map((sec, i) => (
          <div key={i}>
            <p className="text-xs font-semibold">{sec.title}</p>
            <ul className="mt-1 space-y-1">
              {sec.lines.map((l, j) => (
                <li key={j} className="flex gap-2 text-xs">
                  <span className={cn('w-3 shrink-0 text-center font-bold', LINE_STYLE[l.kind])} aria-hidden>
                    {LINE_MARK[l.kind]}
                  </span>
                  <span className="sr-only">{{ add: 'Adicionar:', remove: 'Remover:', change: 'Alterar:', info: '' }[l.kind]}</span>
                  <span className="min-w-0 whitespace-pre-wrap break-words">{l.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {action.error && <p className="text-xs text-destructive">{action.error}</p>}
      {pending ? (
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" disabled={!!busy} onClick={() => void decide(false)} data-testid="assistant-proposal-reject">
            {busy === 'reject' ? <Loader2 className="animate-spin" aria-hidden /> : <X aria-hidden />} Cancelar
          </Button>
          <Button className="flex-1" disabled={!!busy} onClick={() => void decide(true)} data-testid="assistant-proposal-approve">
            {busy === 'approve' ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />} Aprovar e aplicar
          </Button>
        </div>
      ) : action.status === 'applied' ? (
        <div className="flex flex-wrap gap-2">
          {action.result && RESULT_LINK[action.result.collection] && (
            <Button asChild variant="outline" size="sm">
              <Link to={RESULT_LINK[action.result.collection].to}>{RESULT_LINK[action.result.collection].label}</Link>
            </Button>
          )}
          {action.undoable && (
            <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void undo()} data-testid="assistant-proposal-undo">
              {busy === 'undo' ? <Loader2 className="animate-spin" aria-hidden /> : <Undo2 aria-hidden />} Desfazer
            </Button>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function ToolChips({ tools }: { tools: { label: string; ok?: boolean; state?: string }[] }) {
  if (!tools.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Consultas feitas pelo assistente">
      {tools.map((t, i) => (
        <li key={i} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground', t.ok === false && 'border-destructive/40 text-destructive')}>
          {t.state === 'start' ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden /> : <Wrench className="h-3 w-3" aria-hidden />}
          {t.label}
        </li>
      ))}
    </ul>
  );
}

function Message({ m, chat }: { m: MessageView; chat: AssistantChat }) {
  if (m.role === 'event')
    return (
      <li className="flex justify-center" data-testid="assistant-event">
        <p className="max-w-[90%] rounded-full bg-muted px-3 py-1 text-center text-[11px] text-muted-foreground">{m.content}</p>
      </li>
    );
  if (m.role === 'user')
    return (
      <li className="flex flex-col items-end gap-1" data-testid="assistant-user">
        <span className="sr-only">Você:</span>
        {(m.attachments?.length ?? 0) > 0 &&
          (chat.photoPreviews[m.id] ? (
            <img src={chat.photoPreviews[m.id]} alt="Foto enviada" className="max-h-40 max-w-[60%] rounded-2xl border object-cover" />
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground" data-testid="assistant-photo-gone">
              <ImageOff className="h-3 w-3" /> Foto enviada (não guardada)
            </span>
          ))}
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary/15 px-3.5 py-2.5 text-sm [overflow-wrap:anywhere]">{m.content}</p>
      </li>
    );
  const actions = m.actionIds.map((id) => chat.actions[id]).filter(Boolean);
  return (
    <li className="flex flex-col items-start gap-2" data-testid="assistant-reply" data-status={m.status}>
      <span className="sr-only">Assistente:</span>
      {m.tools.length > 0 && <ToolChips tools={m.tools} />}
      {(m.content || m.status !== 'complete') && (
        <div className="w-full max-w-[92%] rounded-2xl rounded-bl-md border bg-card px-3.5 py-2.5">
          {m.content ? <Markdown text={m.content} /> : null}
          {m.status !== 'complete' && <p className="mt-1 text-xs text-muted-foreground">{m.status === 'cancelled' ? 'Resposta interrompida.' : 'A resposta não foi concluída.'}</p>}
        </div>
      )}
      {actions.map((a) => (
        <ProposalCard key={a.id} action={a} onDecide={chat.decide} onUndo={chat.undo} />
      ))}
    </li>
  );
}

function Streaming({ s, chat }: { s: { text: string; tools: LiveTool[] }; chat: AssistantChat }) {
  const running = s.tools.find((t) => t.state === 'start');
  const pending = Object.values(chat.actions).filter((a) => a.status === 'pending' && !chat.messages.some((m) => m.actionIds.includes(a.id)));
  return (
    <li className="flex flex-col items-start gap-2" data-testid="assistant-streaming" aria-live="polite">
      <ToolChips tools={s.tools} />
      <div className="w-full max-w-[92%] rounded-2xl rounded-bl-md border bg-card px-3.5 py-2.5">
        {s.text ? <Markdown text={s.text} /> : null}
        <p className={cn('flex items-center gap-2 text-xs text-muted-foreground', s.text && 'mt-2')}>
          <span className="inline-flex gap-1" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary motion-reduce:animate-none" style={{ animationDelay: `${i * 150}ms` }} />
            ))}
          </span>
          {running ? `${running.label}…` : s.text ? 'Escrevendo…' : 'Pensando…'}
        </p>
      </div>
      {pending.map((a) => (
        <ProposalCard key={a.id} action={a} onDecide={chat.decide} onUndo={chat.undo} />
      ))}
    </li>
  );
}

export default function AssistantChatPage() {
  const chat = useAssistantChat();
  // Fase 01: atalhos do Início abrem o chat com a pergunta já escrita (#/assistente?q=…); nada é enviado sozinho.
  const [params] = useSearchParams();
  const [draft, setDraft] = useState(() => (params.get('q') ?? '').slice(0, MAX_USER_MESSAGE_CHARS));
  const [listOpen, setListOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const s = chat.status;
  const blocked = s && s.availability !== 'ok' ? s.availability : null;
  const busy = !!chat.streaming;
  const over = draft.trim().length > MAX_USER_MESSAGE_CHARS;

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
  }, [chat.messages.length, chat.streaming?.text.length, chat.streaming?.tools.length]);

  // Campo cresce com o texto (até um limite) e rola depois disso.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  // Fase 03: foto de refeição anexada (preparada no aparelho; enviada só com a mensagem; não é guardada).
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoNotice, setPhotoNotice] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickPhoto = async () => {
    if (photoBusy || busy) return;
    setPhotoBusy(true);
    try {
      const v = (await nutritionApi.visionStatus()).vision;
      if (!v.available) return void toast.error(v.reason ?? 'A análise de fotos não está disponível agora.');
      if (!v.notice.accepted) return void setPhotoNotice(true);
      fileInput.current?.click();
    } catch (e) {
      toast.error(errorMessage(e).message);
    } finally {
      setPhotoBusy(false);
    }
  };
  const onPhotoFile = async (f: File | undefined) => {
    if (!f) return;
    setPhotoBusy(true);
    try {
      setPhoto(await preparePhoto(f));
    } catch (e) {
      toast.error(e instanceof PhotoPrepError ? e.message : 'Não consegui abrir esta imagem.');
    } finally {
      setPhotoBusy(false);
    }
  };

  const submit = async (text = draft) => {
    if ((!text.trim() && !photo) || busy || over || blocked) return;
    const sent = photo;
    setDraft('');
    setPhoto(null);
    const ok = await chat.send(text, sent ? { dataUrl: sent.dataUrl } : null);
    if (!ok) {
      setDraft(text);
      setPhoto(sent);
    }
  };

  return (
    <div className="flex min-h-[calc(100dvh-12rem)] flex-col md:min-h-[calc(100dvh-5rem)]" data-testid="assistant-chat">
      <header className="sticky top-0 z-20 -mx-4 mb-2 flex items-center gap-2 bg-background/85 px-4 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] backdrop-blur-xl md:static md:mx-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 font-display text-2xl font-bold tracking-tight">
            <Sparkles className="h-5 w-5 text-primary" aria-hidden /> Assistente
          </h1>
          <button type="button" className="block max-w-full truncate text-left text-sm text-muted-foreground hover:text-foreground" onClick={() => setListOpen(true)} data-testid="assistant-title">
            {chat.title}
          </button>
        </div>
        <Button variant="ghost" size="icon" aria-label="Conversas" onClick={() => setListOpen(true)} data-testid="assistant-open-list">
          <History />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Nova conversa" onClick={() => void chat.open(null)} disabled={busy} data-testid="assistant-new">
          <MessageSquarePlus />
        </Button>
        <Button asChild variant="ghost" size="icon" aria-label="Privacidade do assistente">
          <Link to="/assistente/privacidade">
            <Shield />
          </Link>
        </Button>
      </header>

      {chat.statusError && (
        <Card className="mb-3 flex items-start gap-2 border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 flex-1">
            <p>{chat.statusError.message}</p>
            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void chat.refreshStatus()}>
              Tentar de novo
            </Button>
          </div>
        </Card>
      )}
      {blocked && (
        <Card className="mb-3 flex items-start gap-2 border-warn/40 bg-warn/10 p-3 text-sm" role="note" data-testid="assistant-unavailable" data-availability={blocked}>
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
          <p className="min-w-0">
            {AVAILABILITY_TEXT[blocked] ?? 'O assistente está indisponível agora.'}{' '}
            {blocked === 'email_not_verified' && (
              <Link to="/conta" className="font-medium text-primary underline underline-offset-2">
                Abrir minha conta
              </Link>
            )}
          </p>
        </Card>
      )}

      <ol className="flex-1 space-y-4 pb-4" aria-label="Mensagens" data-testid="assistant-messages">
        {chat.loadingConversation && (
          <li className="flex justify-center py-8 text-muted-foreground">
            <Loader2 className="animate-spin" aria-label="Carregando conversa" />
          </li>
        )}
        {!chat.loadingConversation && chat.messages.length === 0 && !chat.streaming && (
          <li className="space-y-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">Pergunte sobre seus treinos, fichas, metas e medidas. O assistente consulta os seus registros para responder.</p>
            <div className="mx-auto grid max-w-md gap-2">
              {SUGGESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="rounded-2xl border bg-card px-3.5 py-2.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  disabled={!!blocked}
                  onClick={() => void submit(q)}
                  data-testid="assistant-suggestion"
                >
                  {q}
                </button>
              ))}
            </div>
          </li>
        )}
        {chat.messages.map((m) => (
          <Message key={m.id} m={m} chat={chat} />
        ))}
        {chat.streaming && <Streaming s={chat.streaming} chat={chat} />}
      </ol>

      {chat.error && (
        <Card className="mb-2 flex items-start gap-2 border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert" data-testid="assistant-error" data-code={chat.error.code}>
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <p className="min-w-0 flex-1">{chat.error.message}</p>
          <Button variant="ghost" size="icon-sm" aria-label="Fechar aviso" onClick={() => chat.setError(null)}>
            <X />
          </Button>
        </Card>
      )}
      <div ref={bottom} />

      <form
        className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-10 -mx-1 rounded-3xl border bg-card/95 p-2 shadow-lg backdrop-blur-xl md:bottom-4"
        aria-label="Nova mensagem"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {photo && (
          <div className="flex items-center gap-2 px-1 pb-1.5" data-testid="assistant-photo-chip">
            <img src={photo.dataUrl} alt="Foto anexada" className="h-14 w-14 rounded-xl border object-cover" />
            <div className="min-w-0 flex-1 text-[11px] text-muted-foreground">
              <p className="font-medium text-foreground">Foto da refeição</p>
              <p>Enviada só com esta mensagem; não fica guardada.</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {['Quanto de proteína tem nesse prato?', 'Analise e coloque no meu almoço.'].map((q) => (
                  <button key={q} type="button" className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-foreground" onClick={() => setDraft(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Remover foto" onClick={() => setPhoto(null)}>
              <X />
            </Button>
          </div>
        )}
        <label htmlFor="assistant-input" className="sr-only">
          Mensagem para o assistente
        </label>
        <Textarea
          id="assistant-input"
          ref={input}
          rows={1}
          value={draft}
          disabled={!!blocked}
          placeholder={blocked ? 'Assistente indisponível' : 'Pergunte algo sobre seus treinos…'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            const touch = window.matchMedia?.('(pointer: coarse)').matches;
            if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          aria-invalid={over}
          className="max-h-[220px] min-h-[44px] resize-none border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
          data-testid="assistant-input"
        />
        <div className="flex items-center gap-1.5 px-1 pt-1">
          <input ref={fileInput} type="file" accept="image/*,.heic,.heif" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void onPhotoFile(e.target.files?.[0]); e.target.value = ''; }} data-testid="assistant-photo-input" />
          <Button type="button" variant="ghost" size="icon-sm" disabled={!!blocked || busy || photoBusy} aria-label="Anexar foto da refeição" title="Foto da refeição para a IA analisar" onClick={() => void pickPhoto()} data-testid="assistant-attach">
            {photoBusy ? <Loader2 className="animate-spin" /> : <Camera />}
          </Button>
          {s && s.models.length > 1 && (
            <NativeSelect value={chat.model ?? ''} onChange={(e) => chat.setModel(e.target.value)} disabled={busy} aria-label="Modelo da IA" className="h-9 w-auto max-w-[11rem] text-xs" data-testid="assistant-model">
              {s.models.map((m) => (
                <option key={m.id} value={m.id} title={m.description}>
                  {m.displayName}
                </option>
              ))}
            </NativeSelect>
          )}
          <span className={cn('ml-auto text-[11px] tabular', over ? 'text-destructive' : 'text-muted-foreground', draft.length < MAX_USER_MESSAGE_CHARS * 0.8 && !over && 'invisible')}>
            {draft.trim().length.toLocaleString('pt-BR')}/{MAX_USER_MESSAGE_CHARS.toLocaleString('pt-BR')}
          </span>
          {busy ? (
            <Button type="button" size="icon-sm" variant="destructive" aria-label="Parar resposta" onClick={chat.stop} data-testid="assistant-stop">
              <Square />
            </Button>
          ) : (
            <Button type="submit" size="icon-sm" aria-label="Enviar" disabled={(!draft.trim() && !photo) || over || !!blocked} data-testid="assistant-send">
              <SendHorizontal />
            </Button>
          )}
        </div>
      </form>
      <p className="mt-2 px-2 text-center text-[11px] text-muted-foreground">
        Respostas geradas pela OpenAI podem conter erros e não substituem orientação profissional.{' '}
        <Link to="/assistente/privacidade" className="underline underline-offset-2">
          Privacidade
        </Link>
      </p>

      <ConversationsDialog chat={chat} open={listOpen} onOpenChange={setListOpen} />
      <Dialog open={photoNotice} onOpenChange={setPhotoNotice}>
        <DialogContent className="sm:max-w-md">
          {photoNotice && (
            <PhotoNotice
              onCancel={() => setPhotoNotice(false)}
              onAccept={async () => {
                await nutritionApi.acceptPhotoNotice(PHOTO_NOTICE_VERSION);
                setPhotoNotice(false);
                fileInput.current?.click();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <NoticeDialog chat={chat} />
    </div>
  );
}
