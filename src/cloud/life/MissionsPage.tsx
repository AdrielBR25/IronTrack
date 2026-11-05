// Missões (Fase 01): hoje, semana, hábitos, rotinas e desafios, com criação, edição, pausa e histórico.
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, ChevronRight, Pencil, Plus } from 'lucide-react';
import { ROUTINE_KIND_LABEL, type HabitView, type MissionView, type RoutineView } from '@shared/life/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { lifeApi, useLifeQuery } from './api';
import { HABIT_TEMPLATES, HabitDialog, MissionDetailDialog, MissionDialog, ROUTINE_TEMPLATES, RoutineDialog, WEEKDAY_SHORT, draftFromTemplate, lifeError, toastLifeError, type HabitDraft } from './forms';
import { AttrChip, HabitRow, ICON, MissionRow } from './ui';

type Tab = 'hoje' | 'semana' | 'habitos' | 'rotinas' | 'desafios';
const TABS: { value: Tab; label: string }[] = [
  { value: 'hoje', label: 'Hoje' },
  { value: 'semana', label: 'Semana' },
  { value: 'habitos', label: 'Hábitos' },
  { value: 'rotinas', label: 'Rotinas' },
  { value: 'desafios', label: 'Desafios' },
];

const daysLabel = (d: number[]) => (d.length === 7 ? 'Todos os dias' : d.map((x) => WEEKDAY_SHORT[x]).join(' '));

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

function List({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="divide-y divide-border/60 p-3">{children}</CardContent>
    </Card>
  );
}

function RoutineCard({ r, onEdit }: { r: RoutineView; onEdit: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const check = async (itemId: string, done: boolean) => {
    setBusy(itemId);
    try {
      await lifeApi.checkItem(r.id, itemId, done);
    } catch (e) {
      toastLifeError(e);
    } finally {
      setBusy(null);
    }
  };
  const doneCount = r.items.filter((i) => i.done).length;
  return (
    <Card className={cn(r.status !== 'active' && 'opacity-70')}>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-display font-semibold">{r.name}</p>
            <p className="text-xs text-muted-foreground">
              {ROUTINE_KIND_LABEL[r.kind]} · {daysLabel(r.days)}
              {r.status === 'paused' ? ' · pausada' : r.status === 'archived' ? ' · arquivada' : ''}
            </p>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label={`Editar ${r.name}`} onClick={onEdit}>
            <Pencil />
          </Button>
        </div>
        {r.scheduledToday && (
          <p className="text-xs font-medium text-primary">
            Hoje: {doneCount}/{r.items.length}
            {r.completedToday ? ' · completa!' : ''}
          </p>
        )}
        <div className="divide-y divide-border/60">
          {r.items.map((i) => (
            <div key={i.id} className="flex items-center gap-3 py-2">
              <button
                type="button"
                disabled={!r.scheduledToday || busy === i.id}
                onClick={() => check(i.id, !i.done)}
                aria-pressed={i.done}
                aria-label={i.done ? `Desmarcar ${i.title}` : `Concluir ${i.title}`}
                className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2', i.done ? 'border-primary bg-primary text-primary-foreground' : 'border-border', !r.scheduledToday && 'opacity-40')}
              >
                {i.done && <Check className="h-4 w-4" strokeWidth={3} />}
              </button>
              <span className="w-11 shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">{i.startTime ?? ''}</span>
              <span className={cn('min-w-0 flex-1 truncate text-sm', i.done && 'text-muted-foreground line-through')}>{i.title}</span>
              {i.durationMin && <span className="shrink-0 text-xs text-muted-foreground">{i.durationMin} min</span>}
              {i.habitId && <span className="shrink-0 rounded-full bg-secondary px-1.5 text-[10px] text-muted-foreground">hábito</span>}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function MissionsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.value === params.get('aba'))?.value ?? 'hoje') as Tab;
  const setTab = (t: Tab) => setParams(t === 'hoje' ? {} : { aba: t }, { replace: true });
  const [archived, setArchived] = useState(false);
  const dash = useLifeQuery(() => lifeApi.dashboard());
  const habits = useLifeQuery(() => lifeApi.habits(archived), [archived]);
  const routines = useLifeQuery(() => lifeApi.routines());
  const history = useLifeQuery(() => (tab === 'desafios' ? lifeApi.missions('history') : Promise.resolve({ missions: [] as MissionView[] })), [tab]);
  const [habitEdit, setHabitEdit] = useState<HabitView | null>(null);
  const [habitNew, setHabitNew] = useState<HabitDraft | null>(null);
  const [routineEdit, setRoutineEdit] = useState<RoutineView | null>(null);
  const [routineNew, setRoutineNew] = useState<(typeof ROUTINE_TEMPLATES)[number] | 'blank' | null>(null);
  const [missionNew, setMissionNew] = useState(false);
  const [mission, setMission] = useState<MissionView | null>(null);
  const d = dash.data;
  const allHabits = habits.data?.habits ?? [];

  const err = dash.error ?? habits.error ?? routines.error;
  return (
    <div className="space-y-4" data-testid="life-missions">
      <PageHeader
        title="Missões"
        subtitle={d ? `Nível ${d.profile.level.level} · ${d.profile.title}` : undefined}
        action={
          tab === 'habitos' ? (
            <Button size="sm" onClick={() => setHabitNew(draftFromTemplate({ name: '' }))}>
              <Plus /> Hábito
            </Button>
          ) : tab === 'rotinas' ? (
            <Button size="sm" onClick={() => setRoutineNew('blank')}>
              <Plus /> Rotina
            </Button>
          ) : tab === 'desafios' ? (
            <Button size="sm" onClick={() => setMissionNew(true)}>
              <Plus /> Missão
            </Button>
          ) : undefined
        }
      />
      <div className="-mx-4 overflow-x-auto px-4">
        <Segmented value={tab} onChange={setTab} options={TABS} size="sm" className="min-w-[22rem]" aria-label="Seções" />
      </div>
      {err ? <p className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{lifeError(err)}</p> : null}

      {tab === 'hoje' && d && (
        <div className="space-y-4">
          {d.missionsToday.length > 0 && (
            <List>
              {d.missionsToday.map((m) => (
                <MissionRow key={m.id} m={m} onOpen={() => setMission(m)} />
              ))}
            </List>
          )}
          {d.habitsToday.length > 0 ? (
            <List>
              {d.habitsToday.map((h) => (
                <HabitRow key={h.id} h={h} onError={toastLifeError} />
              ))}
            </List>
          ) : (
            <Empty>Nenhum hábito previsto para hoje.</Empty>
          )}
          {d.missionsCustom.filter((m) => m.status === 'active').length > 0 && (
            <List>
              {d.missionsCustom
                .filter((m) => m.status === 'active')
                .map((m) => (
                  <MissionRow key={m.id} m={m} onOpen={() => setMission(m)} />
                ))}
            </List>
          )}
        </div>
      )}

      {tab === 'semana' && d && (d.missionsWeek.length ? <List>{d.missionsWeek.map((m) => <MissionRow key={m.id} m={m} onOpen={() => setMission(m)} />)}</List> : <Empty>As missões semanais aparecem quando você tem hábitos, rotinas ou treinos.</Empty>)}

      {tab === 'habitos' && (
        <div className="space-y-3">
          {allHabits.length === 0 && !habits.loading && (
            <div className="flex flex-wrap gap-2">
              {HABIT_TEMPLATES.map((t) => (
                <button key={t.name} type="button" onClick={() => setHabitNew(draftFromTemplate(t))} className="flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-sm">
                  <Plus className="h-3.5 w-3.5 text-primary" />
                  {t.name}
                </button>
              ))}
            </div>
          )}
          {allHabits.length > 0 && (
            <List>
              {allHabits.map((h) => {
                const Icon = ICON[h.icon] ?? Check;
                return (
                  <button key={h.id} type="button" onClick={() => setHabitEdit(h)} className={cn('flex w-full items-center gap-3 py-2.5 text-left', h.status !== 'active' && 'opacity-60')}>
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary">
                      <Icon className="h-[18px] w-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{h.name}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <AttrChip attribute={h.attribute} />
                        {h.frequency === 'daily' ? daysLabel(h.days) : `${h.timesPerWeek}× semana`}
                        {h.status === 'paused' ? ' · pausado' : h.status === 'archived' ? ' · arquivado' : ''}
                        {h.streak > 1 ? ` · ${h.streak} seguidos` : ''}
                      </span>
                    </span>
                    <span className="text-xs font-semibold text-muted-foreground">+{h.xp}</span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </button>
                );
              })}
            </List>
          )}
          <label className="flex items-center justify-between px-1 text-sm text-muted-foreground">
            Mostrar arquivados
            <Switch checked={archived} onCheckedChange={setArchived} />
          </label>
        </div>
      )}

      {tab === 'rotinas' && (
        <div className="space-y-3">
          {(routines.data?.routines ?? []).map((r) => (
            <RoutineCard key={r.id} r={r} onEdit={() => setRoutineEdit(r)} />
          ))}
          {routines.data && routines.data.routines.length === 0 && <Empty>Organize seu dia em blocos: comece por um modelo.</Empty>}
          <div className="flex flex-wrap gap-2">
            {ROUTINE_TEMPLATES.map((t) => (
              <button key={t.kind} type="button" onClick={() => setRoutineNew(t)} className="flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-sm">
                <Plus className="h-3.5 w-3.5 text-primary" />
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'desafios' && d && (
        <div className="space-y-4">
          {d.missionsCustom.length ? <List>{d.missionsCustom.map((m) => <MissionRow key={m.id} m={m} onOpen={() => setMission(m)} />)}</List> : <Empty>Crie uma missão com prazo, como “Ler 30 minutos” ou um desafio de 21 dias.</Empty>}
          {(history.data?.missions.length ?? 0) > 0 && (
            <div className="space-y-2">
              <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Histórico</h2>
              <List>
                {history.data!.missions.slice(0, 30).map((m) => (
                  <MissionRow key={m.id} m={m} onOpen={() => setMission(m)} />
                ))}
              </List>
            </div>
          )}
        </div>
      )}

      <HabitDialog open={!!habitEdit || !!habitNew} onOpenChange={(o) => !o && (setHabitEdit(null), setHabitNew(null))} habit={habitEdit} template={habitNew} />
      <RoutineDialog open={!!routineEdit || !!routineNew} onOpenChange={(o) => !o && (setRoutineEdit(null), setRoutineNew(null))} routine={routineEdit} template={routineNew === 'blank' ? null : routineNew} habits={allHabits} />
      {d && <MissionDialog open={missionNew} onOpenChange={setMissionNew} today={d.profile.today} habits={allHabits} />}
      <MissionDetailDialog mission={mission} onOpenChange={(o) => !o && setMission(null)} />
    </div>
  );
}
