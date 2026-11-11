// Metas de leitura e estudo (Fase 04): progresso diário/semanal real, vínculo com hábito/missão (sem XP em dobro) e
// "colocar na rotina" (vira um item com horário numa rotina da Fase 01).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, CalendarPlus, Loader2, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import type { GoalView } from '@shared/knowledge/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { lifeApi, useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { knowledgeApi } from './api';
import { GoalDialog } from './forms';
import { GoalRow } from './ui';

export default function GoalsPage() {
  const q = useLifeQuery(() => knowledgeApi.goals().then((r) => r.goals));
  const [edit, setEdit] = useState<GoalView | null | 'new'>(null);
  const [del, setDel] = useState<GoalView | null>(null);
  const [routine, setRoutine] = useState<GoalView | null>(null);
  const goals = q.data ?? [];
  const met = goals.filter((g) => g.status === 'active' && g.current.met).length;
  return (
    <div className="space-y-4 pb-10" data-testid="knowledge-goals">
      <PageHeader
        title="Metas de conhecimento"
        subtitle={goals.length ? `${met} de ${goals.filter((g) => g.status === 'active').length} cumprida(s) no período` : undefined}
        action={
          <Link to="/conhecimento" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar para Conhecimento">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      <Button className="w-full" onClick={() => setEdit('new')} data-testid="goal-add">
        <Plus className="h-4 w-4" />
        Nova meta
      </Button>
      {q.data && goals.length === 0 && <p className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">Comece com algo leve, como “ler 15 minutos por dia”. Constância vale mais que intensidade.</p>}
      {goals.map((g) => (
        <Card key={g.id} className={g.status !== 'active' ? 'opacity-60' : undefined}>
          <CardContent className="space-y-2 p-4">
            <GoalRow g={g} />
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="ghost" onClick={() => setEdit(g)}>
                <Pencil className="h-3.5 w-3.5" />
                Editar
              </Button>
              {g.status === 'active' && (
                <Button size="sm" variant="ghost" onClick={() => setRoutine(g)}>
                  <CalendarPlus className="h-3.5 w-3.5" />
                  Pôr na rotina
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    await knowledgeApi.updateGoal(g.id, g.version, { status: g.status === 'active' ? 'paused' : 'active' });
                  } catch (e) {
                    toast.error(lifeError(e));
                  }
                }}
              >
                {g.status === 'active' ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {g.status === 'active' ? 'Pausar' : 'Retomar'}
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDel(g)} aria-label="Excluir meta">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
      <GoalDialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} goal={edit === 'new' ? null : edit} />
      <RoutineDialog goal={routine} onClose={() => setRoutine(null)} />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        destructive
        title="Excluir meta?"
        description="O XP que ela rendeu é estornado. As sessões continuam."
        confirmLabel="Excluir"
        onConfirm={async () => {
          if (!del) return;
          try {
            await knowledgeApi.deleteGoal(del.id);
            setDel(null);
          } catch (e) {
            toast.error(lifeError(e));
          }
        }}
      />
    </div>
  );
}

function RoutineDialog({ goal, onClose }: { goal: GoalView | null; onClose: () => void }) {
  const routines = useLifeQuery(() => (goal ? lifeApi.routines().then((r) => r.routines.filter((x) => x.status === 'active')) : Promise.resolve([])), [goal?.id]);
  const [routineId, setRoutineId] = useState('');
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!goal) return;
    setBusy(true);
    try {
      await knowledgeApi.goalToRoutine(goal.id, routineId ? { routineId, startTime: time || goal.preferredTime || null } : { newRoutine: { name: 'Estudos', kind: 'study', days: goal.days }, startTime: time || goal.preferredTime || null });
      toast.success('Adicionado à rotina.');
      onClose();
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!goal} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Colocar na rotina</DialogTitle>
          <DialogDescription>Vira um item da rotina com horário. Marcar o item não dá XP extra: o XP vem das sessões e da meta.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Rotina</Label>
            <NativeSelect value={routineId} onChange={(e) => setRoutineId(e.target.value)}>
              <option value="">Criar rotina “Estudos”</option>
              {routines.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label>Horário</Label>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} placeholder={goal?.preferredTime ?? ''} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Adicionar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
