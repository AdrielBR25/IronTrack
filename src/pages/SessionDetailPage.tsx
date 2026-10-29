import { Link, useNavigate, useParams } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, LineChart, Trash2, Trophy } from 'lucide-react';
import { toast } from 'sonner';
import { deleteSession, updateSessionNotes } from '@/db/repo';
import { useCompletedSessions, useSession } from '@/hooks/data';
import { useUnits } from '@/hooks/useUnits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm';
import { MODALITY_LABEL, SIDE_LABEL, exerciseMeasures, exerciseVolume, fmtDurationSec, isCompletedWorkSet, sessionPRs, sessionVolume, validSetCount } from '@/modules/training';
import type { SessionExercise, SessionSet } from '@/lib/types';
import { distanceUnitOf, fmtDistance, planSummary } from '@/features/workout/modelFormat';
import { identityPath, primaryKeyOf } from '@/modules/performance';
import { fmtDateTime, fmtTime } from '@/lib/dates';
import { cn, fmtDuration } from '@/lib/utils';

type Column = { key: string; label: string; value: (s: SessionSet) => string };

/**
 * Colunas da tabela de séries conforme o que o exercício registra (P10). Exercícios antigos mantêm as colunas de
 * antes (Carga, Reps, RIR/RPE). Valor ausente aparece como "—", nunca como zero.
 */
function columnsFor(ex: SessionExercise, fmtW: (kg: number | null | undefined) => string): Column[] {
  const ms = exerciseMeasures(ex);
  const any = (f: (s: SessionSet) => unknown) => ex.sets.some((s) => s.status !== 'pending' && f(s) != null);
  const cols: Column[] = [];
  if (ms.side || any((s) => s.side)) cols.push({ key: 'side', label: 'Lado', value: (s) => (s.side ? SIDE_LABEL[s.side] ?? '—' : '—') });
  if (ms.weight !== 'none' || any((s) => s.weight)) cols.push({ key: 'weight', label: ms.weight === 'adicional' ? 'Carga adic.' : 'Carga', value: (s) => fmtW(s.weight) });
  if (ms.assistance || any((s) => s.assistanceKg)) cols.push({ key: 'assist', label: 'Assist.', value: (s) => (s.assistanceKg != null ? fmtW(s.assistanceKg) : '—') });
  if (ms.reps || any((s) => s.reps)) cols.push({ key: 'reps', label: 'Reps', value: (s) => String(s.reps ?? '—') });
  if (ms.duration || any((s) => s.durationSec)) cols.push({ key: 'dur', label: 'Duração', value: (s) => (s.durationSec ? fmtDurationSec(s.durationSec) : '—') });
  if (ms.distance || any((s) => s.distance)) cols.push({ key: 'dist', label: 'Distância', value: (s) => (s.distance ? fmtDistance(s.distance, distanceUnitOf(ex)) : '—') });
  if (ms.reps) cols.push({ key: 'effort', label: 'RIR/RPE', value: (s) => (s.rir != null ? `RIR ${s.rir}` : s.rpe != null ? `RPE ${s.rpe}` : '—') });
  return cols;
}

export default function SessionDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const session = useSession(id);
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
        const cols = columnsFor(ex, fmtW);
        const volume = exerciseVolume(ex);
        let n = 0;
        return (
          <Card key={ex.id} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold">{ex.name}</p>
                <p className="text-xs text-muted-foreground">
                  {ex.muscleGroup} · plano {planSummary(ex)}
                  {ex.modality ? ` · ${MODALITY_LABEL[ex.modality]}` : ''}
                  {ex.laterality === 'unilateral' ? ' · unilateral' : ''}
                  {ex.substitutedFrom ? ` · substituiu ${ex.substitutedFrom}` : ''}
                </p>
              </div>
              {(exerciseMeasures(ex).weight !== 'none' || volume > 0) && (
                <Badge variant="secondary" className="tabular">
                  {fmtVol(volume)}
                </Badge>
              )}
            </div>
            {shown.length > 0 && (
              // P19: desempenho da identidade desta cópia (instância da ficha ou histórico sem vínculo); a sessão não muda.
              <Link
                to={`${identityPath(primaryKeyOf(session, ex))}?periodo=all&sessao=${encodeURIComponent(session.id)}`}
                className="mt-1 inline-flex min-h-9 items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
                data-testid="session-open-performance"
              >
                <LineChart className="h-3.5 w-3.5" aria-hidden /> Ver desempenho deste exercício
              </Link>
            )}
            {shown.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">Não realizado.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm tabular">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="pb-1 font-medium">Série</th>
                    {cols.map((c) => (
                      <th key={c.key} className="pb-1 font-medium">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s) => {
                    if (s.type === 'normal') n++;
                    return (
                      <tr key={s.id} className={cn('border-t', !isCompletedWorkSet(s) && 'text-muted-foreground')}>
                        <td className="py-1.5">{s.status === 'skipped' ? 'Pulada' : s.type === 'warmup' ? 'Aquec.' : s.type === 'drop' ? 'Drop' : n}</td>
                        {cols.map((c) => (
                          <td key={c.key} className="py-1.5">
                            {c.value(s)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
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
