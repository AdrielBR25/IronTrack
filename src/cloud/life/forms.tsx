// Formulários do RPG: hábito, rotina e missão (criar/editar), detalhe da missão com registros e modelos prontos.
// O servidor valida tudo de novo (limites de XP, datas, vínculos); aqui só guiamos a pessoa.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Loader2, Trash2 } from 'lucide-react';
import {
  ATTRIBUTES,
  ATTRIBUTE_LABEL,
  ICONS,
  REWARD,
  ROUTINE_KINDS,
  ROUTINE_KIND_LABEL,
  TAGS,
  TAG_ATTRIBUTE,
  TAG_LABEL,
  UNIT_LABEL,
  defaultMissionXp,
  type Attribute,
  type HabitView,
  type IconName,
  type MissionEntryView,
  type MissionUnit,
  type MissionView,
  type RoutineKind,
  type RoutineView,
  type Tag,
} from '@shared/life/protocol.ts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { ApiClientError } from '../api';
import { lifeApi } from './api';
import { ICON, MissionRow } from './ui';

export const WEEKDAY_SHORT = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
export const WEEKDAY_NAME = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export function lifeError(e: unknown): string {
  if (e instanceof ApiClientError) {
    const f = e.fields ? Object.values(e.fields)[0] : null;
    return f ? `${e.message} ${f}` : e.message;
  }
  return 'Não foi possível concluir agora.';
}
export const toastLifeError = (e: unknown) => toast.error(lifeError(e));

export function DaysPicker({ value, onChange }: { value: number[]; onChange: (d: number[]) => void }) {
  return (
    <div className="flex gap-1.5" role="group" aria-label="Dias da semana">
      {WEEKDAY_SHORT.map((l, i) => {
        const on = value.includes(i);
        return (
          <button
            key={i}
            type="button"
            aria-pressed={on}
            aria-label={WEEKDAY_NAME[i]}
            onClick={() => {
              const next = on ? value.filter((x) => x !== i) : [...value, i].sort();
              if (next.length) onChange(next);
            }}
            className={cn('h-9 flex-1 rounded-lg text-xs font-semibold transition-colors', on ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground')}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ hábito

export interface HabitDraft {
  name: string;
  description: string;
  attribute: Attribute;
  tag: Tag;
  icon: IconName;
  frequency: 'daily' | 'weekly';
  days: number[];
  timesPerWeek: number;
  goalKind: 'check' | 'count' | 'duration';
  goalTarget: number;
  goalUnit: string;
  preferredTime: string;
  xp: number;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const HABIT_TEMPLATES: (Partial<HabitDraft> & { name: string })[] = [
  { name: 'Beber água', tag: 'water', icon: 'droplet', goalKind: 'count', goalTarget: 8, goalUnit: 'copos' },
  { name: 'Ler diariamente', tag: 'reading', icon: 'book-open', goalKind: 'duration', goalTarget: 20, goalUnit: 'min' },
  { name: 'Estudar', tag: 'study', icon: 'graduation', goalKind: 'duration', goalTarget: 60, goalUnit: 'min', xp: 20 },
  { name: 'Treinar', tag: 'workout', icon: 'dumbbell', frequency: 'weekly', timesPerWeek: 4, goalKind: 'check', xp: 15 },
  { name: 'Dormir no horário planejado', tag: 'sleep', icon: 'moon', goalKind: 'check', preferredTime: '22:30' },
  { name: 'Ler a Bíblia', tag: 'bible', icon: 'church', goalKind: 'check' },
  { name: 'Organizar a rotina', tag: 'routine', icon: 'list', goalKind: 'check', preferredTime: '21:00' },
];

export const draftFromTemplate = (t: Partial<HabitDraft> & { name: string }): HabitDraft => ({
  description: '',
  tag: 'other',
  icon: 'check',
  frequency: 'daily',
  days: ALL_DAYS,
  timesPerWeek: 3,
  goalKind: 'check',
  goalTarget: 1,
  goalUnit: '',
  preferredTime: '',
  xp: REWARD.habit.default,
  ...t,
  attribute: t.attribute ?? TAG_ATTRIBUTE[t.tag ?? 'other'],
});

const draftFromHabit = (h: HabitView): HabitDraft => ({
  name: h.name,
  description: h.description ?? '',
  attribute: h.attribute,
  tag: h.tag,
  icon: h.icon,
  frequency: h.frequency,
  days: h.days,
  timesPerWeek: h.timesPerWeek ?? 3,
  goalKind: h.goalKind,
  goalTarget: h.goalTarget,
  goalUnit: h.goalUnit ?? '',
  preferredTime: h.preferredTime ?? '',
  xp: h.xp,
});

const habitBody = (d: HabitDraft) => ({
  name: d.name.trim(),
  description: d.description.trim() || null,
  attribute: d.attribute,
  tag: d.tag,
  icon: d.icon,
  frequency: d.frequency,
  days: d.days,
  timesPerWeek: d.frequency === 'weekly' ? d.timesPerWeek : null,
  goalKind: d.goalKind,
  goalTarget: d.goalKind === 'check' ? 1 : d.goalTarget,
  goalUnit: d.goalKind === 'check' ? null : d.goalUnit.trim() || (d.goalKind === 'duration' ? 'min' : null),
  preferredTime: d.preferredTime || null,
  xp: d.xp,
});

export function HabitDialog({ open, onOpenChange, habit, template }: { open: boolean; onOpenChange: (o: boolean) => void; habit?: HabitView | null; template?: HabitDraft | null }) {
  const [d, setD] = useState<HabitDraft>(() => (habit ? draftFromHabit(habit) : (template ?? draftFromTemplate({ name: '' }))));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setD(habit ? draftFromHabit(habit) : (template ?? draftFromTemplate({ name: '' })));
  }, [open, habit, template]);
  const set = (p: Partial<HabitDraft>) => setD((x) => ({ ...x, ...p }));
  const save = async () => {
    setBusy(true);
    try {
      if (habit) await lifeApi.updateHabit(habit.id, habit.version, habitBody(d));
      else await lifeApi.createHabit(habitBody(d));
      toast.success(habit ? 'Hábito atualizado.' : 'Hábito criado.');
      onOpenChange(false);
    } catch (e) {
      toastLifeError(e);
    } finally {
      setBusy(false);
    }
  };
  const status = async (s: 'active' | 'paused' | 'archived') => {
    if (!habit) return;
    setBusy(true);
    try {
      await lifeApi.updateHabit(habit.id, habit.version, { status: s });
      toast.success(s === 'paused' ? 'Hábito pausado. Não entra nas missões até você retomar.' : s === 'archived' ? 'Hábito arquivado (o histórico fica guardado).' : 'Hábito retomado.');
      onOpenChange(false);
    } catch (e) {
      toastLifeError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{habit ? 'Editar hábito' : 'Novo hábito'}</DialogTitle>
          <DialogDescription>Cumprir a meta do dia dá {d.xp} XP em {ATTRIBUTE_LABEL[d.attribute]}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Nome">
            <Input value={d.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} placeholder="Ex.: Ler 20 minutos" autoFocus={!habit} />
          </Field>
          <Field label="Ícone">
            <div className="grid grid-cols-10 gap-1">
              {ICONS.map((i) => {
                const I = ICON[i];
                return (
                  <button key={i} type="button" aria-label={i} aria-pressed={d.icon === i} onClick={() => set({ icon: i })} className={cn('flex h-8 items-center justify-center rounded-lg', d.icon === i ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground')}>
                    <I className="h-4 w-4" />
                  </button>
                );
              })}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Categoria">
              <NativeSelect value={d.attribute} onChange={(e) => set({ attribute: e.target.value as Attribute })}>
                {ATTRIBUTES.map((a) => (
                  <option key={a} value={a}>
                    {ATTRIBUTE_LABEL[a]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Tipo">
              <NativeSelect value={d.tag} onChange={(e) => set({ tag: e.target.value as Tag })}>
                {TAGS.map((t) => (
                  <option key={t} value={t}>
                    {TAG_LABEL[t]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field label="Frequência">
            <Segmented
              value={d.frequency}
              onChange={(v) => set({ frequency: v })}
              options={[
                { value: 'daily', label: 'Dias específicos' },
                { value: 'weekly', label: 'Vezes por semana' },
              ]}
            />
          </Field>
          {d.frequency === 'daily' ? (
            <DaysPicker value={d.days} onChange={(days) => set({ days })} />
          ) : (
            <Field label={`${d.timesPerWeek}× por semana`}>
              <input type="range" min={1} max={7} value={d.timesPerWeek} onChange={(e) => set({ timesPerWeek: Number(e.target.value) })} className="w-full accent-[hsl(var(--primary))]" />
            </Field>
          )}
          <Field label="Meta do dia">
            <Segmented
              value={d.goalKind}
              onChange={(v) => set({ goalKind: v, goalTarget: v === 'duration' ? Math.max(d.goalTarget, 10) : d.goalTarget })}
              options={[
                { value: 'check', label: 'Concluir' },
                { value: 'count', label: 'Quantidade' },
                { value: 'duration', label: 'Minutos' },
              ]}
            />
          </Field>
          {d.goalKind !== 'check' && (
            <div className="grid grid-cols-2 gap-3">
              <Input type="number" inputMode="numeric" min={1} max={1440} value={d.goalTarget} onChange={(e) => set({ goalTarget: Math.max(1, Math.min(1440, Number(e.target.value) || 1)) })} aria-label="Meta" />
              <Input value={d.goalUnit} maxLength={20} onChange={(e) => set({ goalUnit: e.target.value })} placeholder={d.goalKind === 'duration' ? 'min' : 'copos, páginas…'} aria-label="Unidade" />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Horário preferido">
              <Input type="time" value={d.preferredTime} onChange={(e) => set({ preferredTime: e.target.value })} />
            </Field>
            <Field label={`XP: ${d.xp}`}>
              <input type="range" min={REWARD.habit.min} max={REWARD.habit.max} step={5} value={d.xp} onChange={(e) => set({ xp: Number(e.target.value) })} className="mt-3 w-full accent-[hsl(var(--primary))]" aria-label="XP por cumprimento" />
            </Field>
          </div>
          <Field label="Descrição (opcional)">
            <Textarea value={d.description} maxLength={300} onChange={(e) => set({ description: e.target.value })} className="min-h-[60px]" />
          </Field>
        </div>
        <DialogFooter className="gap-2">
          {habit && habit.status !== 'archived' && (
            <div className="flex gap-2 sm:mr-auto">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => status(habit.status === 'paused' ? 'active' : 'paused')}>
                {habit.status === 'paused' ? 'Retomar' : 'Pausar'}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => status('archived')}>
                Arquivar
              </Button>
            </div>
          )}
          {habit?.status === 'archived' && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => status('active')} className="sm:mr-auto">
              Restaurar
            </Button>
          )}
          <Button onClick={save} disabled={busy || !d.name.trim()}>
            {busy && <Loader2 className="animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ rotina

interface ItemDraft {
  id?: string;
  title: string;
  startTime: string;
  durationMin: string;
  habitId: string;
}

export const ROUTINE_TEMPLATES: { kind: RoutineKind; name: string; items: Omit<ItemDraft, 'habitId'>[] }[] = [
  { kind: 'morning', name: 'Rotina matinal', items: [{ title: 'Beber um copo de água', startTime: '06:30', durationMin: '2' }, { title: 'Oração / leitura bíblica', startTime: '06:35', durationMin: '15' }, { title: 'Alongamento', startTime: '06:50', durationMin: '10' }, { title: 'Planejar o dia', startTime: '07:00', durationMin: '10' }] },
  { kind: 'study', name: 'Rotina de estudos', items: [{ title: 'Revisar anotações', startTime: '19:00', durationMin: '15' }, { title: 'Bloco de estudo focado', startTime: '19:15', durationMin: '45' }, { title: 'Exercícios / resumo', startTime: '20:00', durationMin: '20' }] },
  { kind: 'training', name: 'Rotina de treino', items: [{ title: 'Pré-treino e hidratação', startTime: '', durationMin: '10' }, { title: 'Treino do dia', startTime: '', durationMin: '60' }, { title: 'Alongamento final', startTime: '', durationMin: '10' }] },
  { kind: 'night', name: 'Rotina noturna', items: [{ title: 'Desligar telas', startTime: '22:00', durationMin: '' }, { title: 'Leitura', startTime: '22:05', durationMin: '20' }, { title: 'Preparar o dia seguinte', startTime: '22:25', durationMin: '5' }] },
];

export function RoutineDialog({ open, onOpenChange, routine, template, habits }: { open: boolean; onOpenChange: (o: boolean) => void; routine?: RoutineView | null; template?: (typeof ROUTINE_TEMPLATES)[number] | null; habits: HabitView[] }) {
  const init = () => ({
    name: routine?.name ?? template?.name ?? '',
    kind: routine?.kind ?? template?.kind ?? ('custom' as RoutineKind),
    days: routine?.days ?? ALL_DAYS,
    items: routine ? routine.items.map((i) => ({ id: i.id, title: i.title, startTime: i.startTime ?? '', durationMin: i.durationMin ? String(i.durationMin) : '', habitId: i.habitId ?? '' })) : (template?.items.map((i) => ({ ...i, habitId: '' })) ?? [{ title: '', startTime: '', durationMin: '', habitId: '' }]),
  });
  const [d, setD] = useState(init);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setD(init());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, routine, template]);
  const setItem = (i: number, p: Partial<ItemDraft>) => setD((x) => ({ ...x, items: x.items.map((it, j) => (j === i ? { ...it, ...p } : it)) }));
  const move = (i: number, by: number) =>
    setD((x) => {
      const items = [...x.items];
      const j = i + by;
      if (j < 0 || j >= items.length) return x;
      [items[i], items[j]] = [items[j], items[i]];
      return { ...x, items };
    });
  const body = () => ({
    name: d.name.trim(),
    kind: d.kind,
    days: d.days,
    items: d.items.filter((i) => i.title.trim()).map((i) => ({ ...(i.id ? { id: i.id } : {}), title: i.title.trim(), startTime: i.startTime || null, durationMin: i.durationMin ? Number(i.durationMin) : null, habitId: i.habitId || null })),
  });
  const save = async () => {
    setBusy(true);
    try {
      const b = body();
      if (routine) await lifeApi.updateRoutine(routine.id, routine.version, b);
      else await lifeApi.createRoutine({ ...b, items: b.items.map(({ id: _id, ...rest }) => rest) });
      toast.success(routine ? 'Rotina atualizada.' : 'Rotina criada.');
      onOpenChange(false);
    } catch (e) {
      toastLifeError(e);
    } finally {
      setBusy(false);
    }
  };
  const status = async (s: 'active' | 'paused' | 'archived') => {
    if (!routine) return;
    setBusy(true);
    try {
      await lifeApi.updateRoutine(routine.id, routine.version, { status: s });
      onOpenChange(false);
    } catch (e) {
      toastLifeError(e);
    } finally {
      setBusy(false);
    }
  };
  const activeHabits = habits.filter((h) => h.status !== 'archived');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{routine ? 'Editar rotina' : 'Nova rotina'}</DialogTitle>
          <DialogDescription>Atividades vinculadas a um hábito registram o hábito (o XP é o dele, sem dobrar). Completar a rotina inteira dá +{REWARD.routineBonus} XP.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field label="Nome">
              <Input value={d.name} maxLength={60} onChange={(e) => setD({ ...d, name: e.target.value })} />
            </Field>
            <Field label="Tipo">
              <NativeSelect value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as RoutineKind })}>
                {ROUTINE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {ROUTINE_KIND_LABEL[k].replace('Rotina ', '')}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <DaysPicker value={d.days} onChange={(days) => setD({ ...d, days })} />
          <div className="space-y-2">
            <Label>Atividades (em ordem)</Label>
            {d.items.map((it, i) => (
              <div key={i} className="space-y-2 rounded-xl border p-2.5">
                <div className="flex gap-2">
                  <Input value={it.title} maxLength={80} onChange={(e) => setItem(i, { title: e.target.value })} placeholder="Atividade" className="h-10" />
                  <Button variant="ghost" size="icon-sm" aria-label="Subir" onClick={() => move(i, -1)} disabled={i === 0}>
                    <ArrowUp />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Descer" onClick={() => move(i, 1)} disabled={i === d.items.length - 1}>
                    <ArrowDown />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Remover" onClick={() => setD({ ...d, items: d.items.filter((_, j) => j !== i) })} disabled={d.items.length === 1}>
                    <Trash2 />
                  </Button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Input type="time" value={it.startTime} onChange={(e) => setItem(i, { startTime: e.target.value })} aria-label="Horário" className="h-9 text-sm" />
                  <Input type="number" inputMode="numeric" min={1} max={600} value={it.durationMin} onChange={(e) => setItem(i, { durationMin: e.target.value })} placeholder="min" aria-label="Duração (min)" className="h-9 text-sm" />
                  <NativeSelect value={it.habitId} onChange={(e) => setItem(i, { habitId: e.target.value })} aria-label="Vincular a hábito" className="h-9 text-sm">
                    <option value="">Sem vínculo</option>
                    {activeHabits.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
            ))}
            {d.items.length < 30 && (
              <Button variant="outline" size="sm" onClick={() => setD({ ...d, items: [...d.items, { title: '', startTime: '', durationMin: '', habitId: '' }] })}>
                Adicionar atividade
              </Button>
            )}
          </div>
        </div>
        <DialogFooter className="gap-2">
          {routine && (
            <div className="flex gap-2 sm:mr-auto">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => status(routine.status === 'paused' ? 'active' : 'paused')}>
                {routine.status === 'paused' ? 'Retomar' : 'Pausar'}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => status('archived')}>
                Arquivar
              </Button>
            </div>
          )}
          <Button onClick={save} disabled={busy || !d.name.trim() || !d.items.some((i) => i.title.trim())}>
            {busy && <Loader2 className="animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ missão

export const MISSION_TEMPLATES: { title: string; unit: MissionUnit; tag: Tag; target: number; attribute: Attribute; days: number }[] = [
  { title: 'Ler 30 minutos', unit: 'minutes', tag: 'reading', target: 30, attribute: 'knowledge', days: 1 },
  { title: 'Estudar 45 minutos', unit: 'minutes', tag: 'study', target: 45, attribute: 'knowledge', days: 1 },
  { title: 'Ler um capítulo bíblico', unit: 'chapters', tag: 'bible', target: 1, attribute: 'spirituality', days: 1 },
  { title: 'Registrar alimentação', unit: 'check', tag: 'nutrition', target: 1, attribute: 'health', days: 1 },
  { title: 'Ler 150 páginas no mês', unit: 'pages', tag: 'reading', target: 150, attribute: 'knowledge', days: 30 },
];

const addDaysIso = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

export function MissionDialog({ open, onOpenChange, today, habits }: { open: boolean; onOpenChange: (o: boolean) => void; today: string; habits: HabitView[] }) {
  const empty = () => ({ type: 'custom' as 'custom' | 'special', title: '', description: '', metric: 'manual' as 'manual' | 'habit' | 'workouts' | 'habit_completions', habitId: '', unit: 'minutes' as MissionUnit, tag: 'other' as Tag, target: 30, attribute: 'knowledge' as Attribute, endsOn: today, xp: null as number | null });
  const [d, setD] = useState(empty);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setD(empty());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, today]);
  const days = Math.round((Date.parse(`${d.endsOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) + 1;
  const lim = REWARD.mission[d.type];
  const suggested = defaultMissionXp(d.type, d.metric === 'manual' ? d.unit : 'times', d.target, Math.max(1, days));
  const xp = d.xp ?? suggested;
  const save = async () => {
    setBusy(true);
    try {
      await lifeApi.createMission({ type: d.type, title: d.title.trim(), description: d.description.trim() || null, metric: d.metric, habitId: d.metric === 'habit' ? d.habitId : null, unit: d.metric === 'manual' ? d.unit : 'times', tag: d.tag, target: d.target, attribute: d.attribute, endsOn: d.endsOn, xp });
      toast.success('Missão criada.');
      onOpenChange(false);
    } catch (e) {
      toastLifeError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova missão</DialogTitle>
          <DialogDescription>Objetivo mensurável com prazo. A recompensa sai quando a meta for atingida.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5">
          {MISSION_TEMPLATES.map((t) => (
            <button key={t.title} type="button" onClick={() => setD({ ...d, title: t.title, unit: t.unit, tag: t.tag, target: t.target, attribute: t.attribute, metric: 'manual', endsOn: addDaysIso(today, t.days - 1), type: t.days >= 3 ? 'special' : 'custom', xp: null })} className="rounded-full bg-secondary px-3 py-1 text-xs">
              {t.title}
            </button>
          ))}
        </div>
        <div className="space-y-4">
          <Segmented
            value={d.type}
            onChange={(type) => setD({ ...d, type, endsOn: type === 'special' && days < 3 ? addDaysIso(today, 6) : d.endsOn, xp: null })}
            options={[
              { value: 'custom', label: 'Personalizada' },
              { value: 'special', label: 'Especial (3–90 dias)' },
            ]}
          />
          <Field label="Título">
            <Input value={d.title} maxLength={80} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="Ex.: Ler 30 minutos" />
          </Field>
          <Field label="Como medir">
            <NativeSelect value={d.metric} onChange={(e) => setD({ ...d, metric: e.target.value as typeof d.metric })}>
              <option value="manual">Eu registro o progresso</option>
              <option value="habit">Cumprimentos de um hábito</option>
              <option value="habit_completions">Hábitos cumpridos (qualquer)</option>
              <option value="workouts">Treinos concluídos</option>
            </NativeSelect>
          </Field>
          {d.metric === 'habit' && (
            <NativeSelect value={d.habitId} onChange={(e) => setD({ ...d, habitId: e.target.value })} aria-label="Hábito">
              <option value="">Escolha o hábito</option>
              {habits
                .filter((h) => h.status === 'active')
                .map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
            </NativeSelect>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Meta">
              <Input type="number" inputMode="numeric" min={1} value={d.unit === 'check' && d.metric === 'manual' ? 1 : d.target} disabled={d.unit === 'check' && d.metric === 'manual'} onChange={(e) => setD({ ...d, target: Math.max(1, Number(e.target.value) || 1), xp: null })} />
            </Field>
            {d.metric === 'manual' ? (
              <Field label="Unidade">
                <NativeSelect value={d.unit} onChange={(e) => setD({ ...d, unit: e.target.value as MissionUnit, xp: null })}>
                  {(['minutes', 'pages', 'chapters', 'times', 'check'] as MissionUnit[]).map((u) => (
                    <option key={u} value={u}>
                      {u === 'check' ? 'Concluir' : UNIT_LABEL[u]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : (
              <Field label="Unidade">
                <Input value="vezes" disabled />
              </Field>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Categoria">
              <NativeSelect value={d.attribute} onChange={(e) => setD({ ...d, attribute: e.target.value as Attribute })}>
                {ATTRIBUTES.map((a) => (
                  <option key={a} value={a}>
                    {ATTRIBUTE_LABEL[a]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Prazo">
              <Input type="date" min={today} value={d.endsOn} onChange={(e) => setD({ ...d, endsOn: e.target.value || today, xp: null })} />
            </Field>
          </div>
          <Field label="Tipo da atividade" hint="Leitura em minutos conta para a conquista de 100 minutos.">
            <NativeSelect value={d.tag} onChange={(e) => setD({ ...d, tag: e.target.value as Tag })}>
              {TAGS.map((t) => (
                <option key={t} value={t}>
                  {TAG_LABEL[t]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={`Recompensa: ${xp} XP`} hint={`Entre ${lim.min} e ${lim.max} XP. Sugerido: ${suggested}.`}>
            <input type="range" min={lim.min} max={lim.max} step={5} value={xp} onChange={(e) => setD({ ...d, xp: Number(e.target.value) })} className="w-full accent-[hsl(var(--primary))]" />
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy || !d.title.trim() || (d.metric === 'habit' && !d.habitId) || (d.type === 'special' && (days < 3 || days > 90))}>
            {busy && <Loader2 className="animate-spin" />}
            Criar missão
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MissionDetailDialog({ mission, onOpenChange }: { mission: MissionView | null; onOpenChange: (o: boolean) => void }) {
  const [entries, setEntries] = useState<MissionEntryView[] | null>(null);
  const [m, setM] = useState<MissionView | null>(mission);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async (id: string) => {
    try {
      const r = await lifeApi.mission(id);
      setM(r.mission);
      setEntries(r.entries);
    } catch (e) {
      toastLifeError(e);
    }
  };
  useEffect(() => {
    setM(mission);
    setEntries(null);
    setAmount('');
    if (mission) void load(mission.id);
  }, [mission]);
  const run = async (fn: () => Promise<unknown>) => {
    if (!m) return;
    setBusy(true);
    try {
      await fn();
      await load(m.id);
    } catch (e) {
      toastLifeError(e);
    } finally {
      setBusy(false);
    }
  };
  const manual = m?.metric === 'manual';
  const editable = m && (m.status === 'active' || m.status === 'paused');
  return (
    <Dialog open={!!mission} onOpenChange={onOpenChange}>
      <DialogContent>
        {m && (
          <>
            <DialogHeader>
              <DialogTitle>{m.title}</DialogTitle>
              <DialogDescription>
                {m.startsOn === m.endsOn ? `Hoje` : `De ${m.startsOn.split('-').reverse().join('/')} até ${m.endsOn.split('-').reverse().join('/')}`} · {m.xp} XP · {ATTRIBUTE_LABEL[m.attribute]}
                {m.origin === 'system' ? ' · automática' : m.origin === 'ai' ? ' · criada com a IA' : ''}
              </DialogDescription>
            </DialogHeader>
            <MissionRow m={m} />
            {m.description && <p className="text-sm text-muted-foreground">{m.description}</p>}
            {manual && m.status === 'active' && (
              <div className="flex gap-2">
                {m.unit === 'check' ? (
                  <Button className="flex-1" disabled={busy} onClick={() => run(() => lifeApi.addEntry(m.id, 1))}>
                    Marcar como feito
                  </Button>
                ) : (
                  <>
                    <Input type="number" inputMode="numeric" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`Quantos ${UNIT_LABEL[m.unit]}?`} />
                    <Button disabled={busy || !(Number(amount) > 0)} onClick={() => run(async () => { await lifeApi.addEntry(m.id, Number(amount)); setAmount(''); })}>
                      Registrar
                    </Button>
                  </>
                )}
              </div>
            )}
            {!manual && <p className="text-xs text-muted-foreground">Progresso automático: conta {m.metric === 'workouts' ? 'treinos concluídos' : m.metric === 'active_days' ? 'dias com atividade' : m.metric === 'routine_completions' ? 'rotinas completas' : 'hábitos cumpridos'} no período.</p>}
            {manual && entries && entries.length > 0 && (
              <div className="space-y-1">
                <Label>Histórico</Label>
                {entries.map((e) => (
                  <div key={e.id} className="flex items-center justify-between rounded-lg bg-secondary/60 px-3 py-1.5 text-sm">
                    <span>
                      {e.date.split('-').reverse().slice(0, 2).join('/')} · {m.unit === 'check' ? 'feito' : `${e.amount} ${UNIT_LABEL[m.unit]}`}
                      {e.fromRoutine ? ' · rotina' : ''}
                    </span>
                    {m.status !== 'cancelled' && !e.fromRoutine && (
                      <button type="button" aria-label="Desfazer registro" disabled={busy} onClick={() => run(() => lifeApi.deleteEntry(m.id, e.id))} className="text-muted-foreground">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {editable && (
              <DialogFooter className="gap-2">
                <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => lifeApi.updateMission(m.id, m.version, { status: m.status === 'paused' ? 'active' : 'paused' }))}>
                  {m.status === 'paused' ? 'Retomar' : 'Pausar'}
                </Button>
                {m.origin !== 'system' && (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => lifeApi.updateMission(m.id, m.version, { status: 'cancelled' }))}>
                    Cancelar missão
                  </Button>
                )}
              </DialogFooter>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
