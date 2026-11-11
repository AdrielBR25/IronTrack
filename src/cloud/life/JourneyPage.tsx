// Evolução do personagem (Fase 01): nível, título, atributos, consistência, conquistas e histórico auditável de XP.
// Os atributos medem atividades registradas; não são avaliação clínica ou psicológica.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Award, BarChart3, ChevronRight, Flame, Lock, Target, Trophy, Undo2 } from 'lucide-react';
import { xpForLevel, type XpEventView } from '@shared/life/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { lifeApi, useLifeQuery } from './api';
import { lifeError, toastLifeError } from './forms';
import { ATTR_ICON, ATTR_TONE, Bar } from './ui';

const SOURCE_LABEL: Record<XpEventView['source'], string> = { habit: 'Hábito', mission: 'Missão', workout: 'Treino', routine: 'Rotina', achievement: 'Conquista', legacy: 'Histórico', nutrition: 'Alimentação', knowledge: 'Conhecimento', bible: 'Bíblia' };

export default function JourneyPage() {
  const dash = useLifeQuery(() => lifeApi.dashboard());
  const ach = useLifeQuery(() => lifeApi.achievements());
  const xp = useLifeQuery(() => lifeApi.xp(60));
  const [showAll, setShowAll] = useState(false);
  const d = dash.data;
  if (!d) return <div className="space-y-3">{dash.error ? <p className="text-sm">{lifeError(dash.error)}</p> : <div className="h-40 animate-pulse rounded-2xl bg-card" />}</div>;
  const p = d.profile;
  const deviceTz = lifeApi.deviceTz();
  const events = xp.data?.events ?? [];
  const patch = async (b: Parameters<typeof lifeApi.patchProfile>[0], ok: string) => {
    try {
      await lifeApi.patchProfile(b);
      toast.success(ok);
    } catch (e) {
      toastLifeError(e);
    }
  };

  return (
    <div className="space-y-4" data-testid="life-journey">
      <PageHeader title="Evolução" subtitle="Seu personagem cresce com o que você cumpre de verdade." />

      <Card className="overflow-hidden border-primary/25 bg-gradient-to-br from-primary/[0.10] via-card to-card">
        <CardContent className="space-y-3 p-5">
          <div className="flex items-center gap-4">
            <div className="flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-3xl bg-primary text-primary-foreground shadow-[0_0_40px_-10px_hsl(var(--primary)/0.9)]">
              <span className="text-[10px] font-semibold uppercase tracking-wider opacity-80">Nível</span>
              <span className="font-display text-3xl font-bold leading-none tabular-nums">{p.level.level}</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-display text-xl font-bold">{p.title}</p>
              <p className="text-sm text-muted-foreground tabular-nums">{p.totalXp.toLocaleString('pt-BR')} XP no total</p>
              {p.titles.length > 1 && (
                <NativeSelect value={p.selectedTitle ?? ''} onChange={(e) => patch({ selectedTitle: e.target.value || null }, 'Título atualizado.')} className="mt-2 h-9 text-sm" aria-label="Título exibido">
                  <option value="">Título automático</option>
                  {p.titles.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </div>
          </div>
          <Bar value={p.level.progress} label="Progresso do nível" />
          <p className="flex justify-between text-xs text-muted-foreground tabular-nums">
            <span>
              {p.level.into}/{p.level.need} XP para o nível {p.level.level + 1}
            </span>
            <span>próximo: {(xpForLevel(p.level.level + 1)).toLocaleString('pt-BR')} XP</span>
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-2">
        {[
          { icon: Flame, label: 'Sequência', value: `${p.streak.current} d`, tone: 'text-orange-500' },
          { icon: Trophy, label: 'Melhor', value: `${p.streak.best} d`, tone: 'text-amber-500' },
          { icon: Target, label: 'XP hoje', value: `${p.xpToday}`, tone: 'text-primary' },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="flex flex-col items-center gap-1 p-3">
              <s.icon className={cn('h-5 w-5', s.tone)} />
              <span className="font-display text-lg font-bold tabular-nums">{s.value}</span>
              <span className="text-[11px] text-muted-foreground">{s.label}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Atributos</CardTitle>
          <CardDescription>Progresso nas atividades registradas de cada área.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {p.attributes.map((a) => {
            const Icon = ATTR_ICON[a.attribute];
            const t = ATTR_TONE[a.attribute];
            return (
              <div key={a.attribute} className="flex items-center gap-3">
                <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', t.soft, t.text)}>
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">{a.label}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      nv. {a.level.level} · {a.xp} XP
                    </span>
                  </div>
                  <Bar value={a.level.progress} tone={t.bar} label={a.label} className="h-1.5" />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Conquistas</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {(ach.data?.achievements ?? []).map((a) => (
            <div key={a.code} className={cn('flex items-center gap-3 rounded-xl border p-3', !a.unlockedAt && 'bg-secondary/30')}>
              <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', a.unlockedAt ? 'bg-amber-500/15 text-amber-500' : 'bg-secondary text-muted-foreground')}>{a.unlockedAt ? <Award className="h-[18px] w-[18px]" /> : <Lock className="h-4 w-4" />}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-tight">{a.title}</p>
                <p className="text-xs text-muted-foreground">
                  {a.unlockedAt ? `Desbloqueada em ${new Date(a.unlockedAt).toLocaleDateString('pt-BR')}` : !a.available ? 'Ativa quando houver registros de leitura em minutos' : a.description}
                </p>
                {!a.unlockedAt && a.progress && <Bar value={a.progress.value / a.progress.target} className="mt-1.5 h-1" label={a.title} />}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Histórico de XP</CardTitle>
          <CardDescription>Cada ganho e cada estorno, com o motivo. Nada é apagado.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border/60">
          {events.length === 0 && <p className="py-2 text-sm text-muted-foreground">Ainda sem XP. Cumpra um hábito para começar.</p>}
          {(showAll ? events : events.slice(0, 12)).map((e) => (
            <div key={e.id} className={cn('flex items-center gap-3 py-2', e.reversed && 'opacity-50')}>
              <span className="w-16 shrink-0 text-[11px] text-muted-foreground">{e.day.split('-').reverse().slice(0, 2).join('/')}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{e.reason}</span>
                <span className="text-[11px] text-muted-foreground">
                  {SOURCE_LABEL[e.source]}
                  {e.requested > e.amount && e.kind === 'grant' ? ` · limitado pelo teto diário (${e.requested})` : ''}
                  {e.reversed ? ' · estornado' : ''}
                </span>
              </span>
              <span className={cn('flex shrink-0 items-center gap-1 text-sm font-semibold tabular-nums', e.amount < 0 ? 'text-destructive' : 'text-primary')}>
                {e.kind === 'reversal' && <Undo2 className="h-3 w-3" />}
                {e.amount > 0 ? `+${e.amount}` : e.amount}
              </span>
            </div>
          ))}
          {events.length > 12 && (
            <button type="button" className="w-full pt-2 text-xs font-medium text-muted-foreground" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Mostrar menos' : 'Mostrar mais'}
            </button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ajustes do personagem</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">Fuso horário</p>
              <p className="text-xs text-muted-foreground">Define a virada do dia das missões e da sequência. Atual: {p.timezone}.</p>
            </div>
            {deviceTz !== p.timezone && (
              <Button size="sm" variant="outline" onClick={() => patch({ timezone: deviceTz }, `Fuso alterado para ${deviceTz}.`)}>
                Usar {deviceTz}
              </Button>
            )}
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">Meta semanal de treinos</p>
              <p className="text-xs text-muted-foreground">Usada na missão semanal (vale a partir da próxima semana).</p>
            </div>
            <NativeSelect value={p.weeklyWorkoutTarget ?? ''} onChange={(e) => patch({ weeklyWorkoutTarget: e.target.value ? Number(e.target.value) : null }, 'Meta atualizada.')} className="h-9 w-28 text-sm" aria-label="Meta semanal de treinos">
              <option value="">Automática</option>
              {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                <option key={n} value={n}>
                  {n}× semana
                </option>
              ))}
            </NativeSelect>
          </div>
        </CardContent>
      </Card>

      <Link to="/evolucao" className="block">
        <Card className="active:scale-[0.99]">
          <CardContent className="flex items-center gap-3 p-4">
            <BarChart3 className="h-5 w-5 text-primary" />
            <span className="flex-1 text-sm font-medium">Evolução dos treinos, desempenho e metas</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </CardContent>
        </Card>
      </Link>
      <p className="px-1 text-xs text-muted-foreground">Os atributos representam o progresso nas atividades que você registra. Não são avaliação clínica, física ou psicológica.</p>
    </div>
  );
}
