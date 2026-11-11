// Matéria (Fase 04): tempo, meta semanal, tópicos (pendente → estudando → concluído), notas e sessões.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Archive, ArrowLeft, Check, Circle, CircleDot, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { TOPIC_STATUS_LABEL, type SessionView, type TopicStatus, type TopicView } from '@shared/knowledge/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { Bar } from '../life/ui';
import { knowledgeApi } from './api';
import { Notes, SessionDeleteDialog } from './BookPage';
import { ManualSessionDialog, SubjectDialog } from './forms';
import { Section } from './parts';
import { COLOR, SessionRow, fmtMin } from './ui';

const NEXT: Record<TopicStatus, TopicStatus> = { pending: 'studying', studying: 'done', done: 'pending' };
const TOPIC_ICON = { pending: Circle, studying: CircleDot, done: Check } as const;

export default function SubjectPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const q = useLifeQuery(() => knowledgeApi.subject(id), [id]);
  const [edit, setEdit] = useState(false);
  const [manual, setManual] = useState(false);
  const [del, setDel] = useState(false);
  const [topic, setTopic] = useState('');
  const [session, setSession] = useState<SessionView | null>(null);
  const s = q.data?.subject;
  if (q.error) return <p className="py-10 text-center text-sm text-muted-foreground">{lifeError(q.error)}</p>;
  if (!s) return <p className="py-10 text-center text-sm text-muted-foreground">Carregando…</p>;
  const c = COLOR[s.color];

  const addTopic = async () => {
    try {
      await knowledgeApi.addTopics(s.id, [{ title: topic }]);
      setTopic('');
    } catch (e) {
      toast.error(lifeError(e));
    }
  };
  const cycle = async (t: TopicView) => {
    try {
      await knowledgeApi.updateTopic(t.id, { status: NEXT[t.status] });
    } catch (e) {
      toast.error(lifeError(e));
    }
  };

  return (
    <div className="space-y-4 pb-10" data-testid="knowledge-subject">
      <PageHeader
        title={s.name}
        subtitle={s.description ?? s.category ?? undefined}
        action={
          <div className="flex">
            <button type="button" onClick={() => setEdit(true)} className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Editar matéria">
              <Pencil className="h-5 w-5" />
            </button>
            <Link to="/conhecimento/estudos" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar para Estudos">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </div>
        }
      />
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className={cn('font-display text-xl font-bold tabular-nums', c.text)}>{fmtMin(s.minutesWeek)}</p>
              <p className="text-[11px] text-muted-foreground">nesta semana</p>
            </div>
            <div>
              <p className="font-display text-xl font-bold tabular-nums">{fmtMin(s.minutesTotal)}</p>
              <p className="text-[11px] text-muted-foreground">no total</p>
            </div>
            <div>
              <p className="font-display text-xl font-bold tabular-nums">{s.topics.total ? `${s.topics.done}/${s.topics.total}` : '–'}</p>
              <p className="text-[11px] text-muted-foreground">tópicos</p>
            </div>
          </div>
          {s.weeklyGoalMin ? (
            <div className="space-y-1">
              <Bar value={s.minutesWeek / s.weeklyGoalMin} tone={c.bar} label="Meta semanal" />
              <p className="text-[11px] text-muted-foreground">Meta semanal: {fmtMin(s.weeklyGoalMin)}</p>
            </div>
          ) : null}
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Button asChild>
              <Link to={`/conhecimento/foco?materia=${s.id}`} data-testid="subject-study">
                <Play className="h-4 w-4" />
                Estudar agora
              </Link>
            </Button>
            <Button variant="secondary" onClick={() => setManual(true)}>
              <Plus className="h-4 w-4" />
              Registrar
            </Button>
          </div>
        </CardContent>
      </Card>

      <Section title="Tópicos">
        <div className="flex gap-2 py-3">
          <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Novo tópico" maxLength={120} onKeyDown={(e) => e.key === 'Enter' && topic.trim() && void addTopic()} data-testid="topic-input" />
          <Button variant="secondary" disabled={!topic.trim()} onClick={addTopic} aria-label="Adicionar tópico">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        {s.topicList?.map((t) => {
          const Icon = TOPIC_ICON[t.status];
          return (
            <div key={t.id} className="flex items-center gap-3 py-2.5" data-testid="topic-row">
              <button type="button" onClick={() => void cycle(t)} aria-label={`${t.title}: ${TOPIC_STATUS_LABEL[t.status]}. Tocar para mudar.`} className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full border', t.status === 'done' ? 'border-primary bg-primary text-primary-foreground' : t.status === 'studying' ? cn('border-current', c.text) : 'text-muted-foreground')}>
                <Icon className="h-4 w-4" />
              </button>
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-sm', t.status === 'done' && 'text-muted-foreground line-through')}>{t.title}</span>
                <span className="text-[11px] text-muted-foreground">
                  {TOPIC_STATUS_LABEL[t.status]}
                  {t.minutes ? ` · ${fmtMin(t.minutes)}` : ''}
                </span>
              </span>
              <button
                type="button"
                aria-label="Excluir tópico"
                className="p-1 text-muted-foreground"
                onClick={async () => {
                  try {
                    await knowledgeApi.deleteTopic(t.id);
                  } catch (e) {
                    toast.error(lifeError(e));
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </Section>

      <Notes subjectId={s.id} notes={q.data?.notes ?? []} reload={q.reload} />

      <Section title="Histórico">
        {q.data?.sessions.length ? q.data.sessions.map((x) => <SessionRow key={x.id} s={x} onClick={() => setSession(x)} />) : <p className="py-2 text-xs text-muted-foreground">Nenhuma sessão ainda.</p>}
      </Section>

      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="ghost"
          onClick={async () => {
            try {
              await knowledgeApi.updateSubject(s.id, s.version, { archived: !s.archived });
              toast.success(s.archived ? 'Matéria reativada.' : 'Matéria arquivada.');
              if (!s.archived) nav('/conhecimento/estudos');
            } catch (e) {
              toast.error(lifeError(e));
            }
          }}
        >
          <Archive className="h-4 w-4" />
          {s.archived ? 'Reativar' : 'Arquivar'}
        </Button>
        <Button variant="ghost" className="text-destructive" onClick={() => setDel(true)}>
          <Trash2 className="h-4 w-4" />
          Excluir
        </Button>
      </div>

      <SubjectDialog open={edit} onOpenChange={setEdit} subject={s} />
      <ManualSessionDialog open={manual} onOpenChange={setManual} preset={{ kind: 'study', subjectId: s.id }} />
      <SessionDeleteDialog session={session} onClose={() => setSession(null)} />
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        destructive
        title="Excluir matéria?"
        description="Os tópicos e as notas somem. As sessões continuam no histórico, sem a matéria."
        confirmLabel="Excluir"
        onConfirm={async () => {
          try {
            await knowledgeApi.deleteSubject(s.id);
            nav('/conhecimento/estudos');
          } catch (e) {
            toast.error(lifeError(e));
          }
        }}
      />
    </div>
  );
}
