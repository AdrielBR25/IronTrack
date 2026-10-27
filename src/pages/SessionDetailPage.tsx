import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Trash2, Trophy } from 'lucide-react';
import { toast } from 'sonner';
import { db } from '@/db/db';
import { deleteSession, updateSessionNotes } from '@/db/repo';
import { useCompletedSessions } from '@/hooks/data';
import { useUnits } from '@/hooks/useUnits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm';
import { exerciseVolume, isValidWorkingSet, sessionPRs, sessionVolume, validSetCount } from '@/lib/volume';
import { fmtDateTime, fmtTime } from '@/lib/dates';
import { cn, fmtDuration } from '@/lib/utils';
import { fmtRepRange } from '@/lib/routineSchema';

export default function SessionDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const session = useLiveQuery(() => (id ? db.sessions.get(id) : undefined), [id]);
  const all = useCompletedSessions();
  const { fmtW, fmtVol } = useUnits();
  const [notes, setNotes] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setNotes(session?.notes ?? ''), [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const prs = useMemo(() => (session && all ? sessionPRs(session, all) : []), [session, all]);

  if (session === undefined) return null;
  if (!session || session.status !== 'completed')
    return (
      <div className="space-y-3">
        <p>Treino não encontrado.</p>
        <Button onClick={() => navigate('/historico')}>Voltar</Button>
      </div>
    );

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="Voltar" onClick={() => navigate('/historico')}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-xl font-bold">
            <span className="text-primary">Treino {session.workoutLabel}</span> · {session.workoutName}
          </h1>
          <p className="text-xs text-muted-foreground">
            {fmtDateTime(session.startedAt)}
            {session.finishedAt ? ` – ${fmtTime(session.finishedAt)}` : ''}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          ['Duração', fmtDuration(session.durationSec ?? 0)],
          ['Volume', fmtVol(sessionVolume(session))],
          ['Séries válidas', String(validSetCount(session))],
        ].map(([k, v]) => (
          <Card key={k} className="p-3 text-center">
            <p className="font-display text-lg font-bold tabular">{v}</p>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{k}</p>
          </Card>
        ))}
      </div>

      {prs.length > 0 && (
        <Card className="flex items-start gap-2 border-primary/40 bg-primary/10 p-3 text-sm">
          <Trophy className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p>
            <strong>Recordes pessoais:</strong> {prs.join(', ')}
          </p>
        </Card>
      )}

      {session.exercises.map((ex) => {
        const shown = ex.sets.filter((s) => s.status !== 'pending');
        let n = 0;
        return (
          <Card key={ex.id} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold">{ex.name}</p>
                <p className="text-xs text-muted-foreground">
                  {ex.muscleGroup} · plano {ex.plannedSets} × {fmtRepRange(ex.repMin, ex.repMax)}
                  {ex.substitutedFrom ? ` · substituiu ${ex.substitutedFrom}` : ''}
                </p>
              </div>
              <Badge variant="secondary" className="tabular">
                {fmtVol(exerciseVolume(ex))}
              </Badge>
            </div>
            {shown.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">Não realizado.</p>
            ) : (
              <table className="mt-3 w-full text-sm tabular">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="pb-1 font-medium">Série</th>
                    <th className="pb-1 font-medium">Carga</th>
                    <th className="pb-1 font-medium">Reps</th>
                    <th className="pb-1 font-medium">RIR/RPE</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s) => {
                    if (s.type === 'normal') n++;
                    return (
                      <tr key={s.id} className={cn('border-t', !isValidWorkingSet(s) && 'text-muted-foreground')}>
                        <td className="py-1.5">{s.status === 'skipped' ? 'Pulada' : s.type === 'warmup' ? 'Aquec.' : s.type === 'drop' ? 'Drop' : n}</td>
                        <td className="py-1.5">{fmtW(s.weight)}</td>
                        <td className="py-1.5">{s.reps ?? '—'}</td>
                        <td className="py-1.5">{s.rir != null ? `RIR ${s.rir}` : s.rpe != null ? `RPE ${s.rpe}` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {shown.some((s) => s.note) && (
              <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                {shown
                  .filter((s) => s.note)
                  .map((s) => (
                    <li key={s.id}>• {s.note}</li>
                  ))}
              </ul>
            )}
          </Card>
        );
      })}

      <Card className="space-y-2 p-4">
        <p className="text-sm font-semibold">Observações</p>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Como foi o treino?" />
        <Button
          size="sm"
          variant="secondary"
          disabled={notes === (session.notes ?? '')}
          onClick={async () => {
            await updateSessionNotes(session.id, notes);
            toast.success('Observações salvas');
          }}
        >
          Salvar observações
        </Button>
      </Card>

      <Button variant="ghost" className="w-full text-destructive" onClick={() => setConfirm(true)}>
        <Trash2 /> Excluir este treino do histórico
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        destructive
        title="Excluir este treino?"
        description="As séries, cargas e o volume desta sessão serão apagados permanentemente. A rotação não é alterada (corrija em Treinos, se precisar)."
        confirmLabel="Excluir"
        onConfirm={async () => {
          await deleteSession(session.id);
          toast('Treino excluído');
          navigate('/historico', { replace: true });
        }}
      />
    </div>
  );
}
