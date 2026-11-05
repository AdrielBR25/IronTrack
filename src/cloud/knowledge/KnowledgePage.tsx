// Conhecimento (Fase 04): painel do dia — leitura e estudo de hoje, metas, livros em andamento, matérias da semana,
// XP recebido e o botão para começar uma sessão. Dias sem registro aparecem como "sem registro", nunca como zero.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, BookOpen, GraduationCap, Library, Play, Plus, Target } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { knowledgeApi } from './api';
import { ManualSessionDialog } from './forms';
import { ActiveTimerBanner, Section } from './parts';
import { BookRow, GoalRow, SessionRow, SubjectRow, fmtMin, weekdayShort } from './ui';

function Stat({ label, value, icon: Icon }: { label: string; value: string; icon: typeof BookOpen }) {
  return (
    <div className="rounded-2xl bg-secondary/60 p-3">
      <Icon className="mb-1 h-4 w-4 text-primary" />
      <p className="font-display text-lg font-bold tabular-nums leading-tight">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

export default function KnowledgePage() {
  const q = useLifeQuery(() => knowledgeApi.dashboard());
  const d = q.data;
  const [manual, setManual] = useState(false);
  const max = Math.max(1, ...(d?.week ?? []).map((w) => (w.reading ?? 0) + (w.study ?? 0) + (w.focus ?? 0)));

  return (
    <div className="space-y-4 pb-10" data-testid="knowledge-page">
      <PageHeader title="Conhecimento" subtitle="Leitura, estudos e foco" />
      <ActiveTimerBanner />

      <Card className="overflow-hidden">
        <CardContent className="space-y-4 p-4">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Leitura hoje" value={d ? fmtMin(d.readingMin) : '–'} icon={BookOpen} />
            <Stat label="Estudo hoje" value={d ? fmtMin(d.studyMin + d.focusMin) : '–'} icon={GraduationCap} />
            <Stat label="XP de hoje" value={d ? `+${d.xpToday}` : '–'} icon={Target} />
          </div>
          {d && d.sessionsToday === 0 && <p className="text-center text-xs text-muted-foreground">Nenhuma sessão hoje ainda. Que tal 10 minutos agora?</p>}
          {d && d.sessionsToday > 0 && (
            <p className="text-center text-xs text-muted-foreground">
              {d.sessionsToday} sessão(ões){d.pagesToday ? ` · ${d.pagesToday} páginas` : ''} hoje. Bom ritmo!
            </p>
          )}
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Button asChild size="lg" data-testid="knowledge-start">
              <Link to="/conhecimento/foco">
                <Play className="h-4 w-4" />
                {d?.timer ? 'Ver sessão em andamento' : 'Iniciar sessão'}
              </Link>
            </Button>
            <Button size="lg" variant="secondary" onClick={() => setManual(true)} aria-label="Registrar sessão manual" data-testid="knowledge-manual">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-4 gap-2 text-center text-[11px]">
        {[
          { to: '/conhecimento/biblioteca', label: 'Biblioteca', icon: Library },
          { to: '/conhecimento/estudos', label: 'Estudos', icon: GraduationCap },
          { to: '/conhecimento/metas', label: 'Metas', icon: Target },
          { to: '/conhecimento/estatisticas', label: 'Gráficos', icon: BarChart3 },
        ].map((l) => (
          <Link key={l.to} to={l.to} className="flex flex-col items-center gap-1 rounded-2xl bg-card p-3 active:scale-[0.98]">
            <l.icon className="h-5 w-5 text-primary" />
            {l.label}
          </Link>
        ))}
      </div>

      {d && d.goals.length > 0 && (
        <Section title="Metas" to="/conhecimento/metas">
          {d.goals.map((g) => (
            <GoalRow key={g.id} g={g} />
          ))}
        </Section>
      )}

      <Section title="Lendo agora" to="/conhecimento/biblioteca">
        {d && d.reading.length === 0 && <p className="py-2 text-xs text-muted-foreground">Nenhum livro em andamento. Adicione um na biblioteca.</p>}
        {d?.reading.map((b) => (
          <BookRow key={b.id} b={b} />
        ))}
      </Section>

      {d && d.subjectsWeek.length > 0 && (
        <Section title="Estudos da semana" to="/conhecimento/estudos">
          {d.subjectsWeek.map((s) => (
            <SubjectRow key={s.id} s={{ id: s.id, name: s.name, color: s.color, minutesWeek: s.minutes, weeklyGoalMin: s.goal, topics: { total: 0, done: 0, studying: 0 } } as never} />
          ))}
        </Section>
      )}

      {d && (
        <Section title="Últimos 7 dias">
          <div className="flex h-28 items-end gap-2 pt-2" data-testid="knowledge-week">
            {d.week.map((w) => {
              const total = w.reading == null && w.study == null && w.focus == null ? null : (w.reading ?? 0) + (w.study ?? 0) + (w.focus ?? 0);
              return (
                <div key={w.date} className="flex flex-1 flex-col items-center gap-1">
                  <div className="flex h-20 w-full items-end">
                    {total == null ? (
                      <div className="h-1 w-full rounded-full border border-dashed border-border" title="Sem registro" />
                    ) : (
                      <div className="flex w-full flex-col-reverse overflow-hidden rounded-md" style={{ height: `${Math.max(6, (total / max) * 100)}%` }} title={fmtMin(total)}>
                        <div className="bg-primary" style={{ flex: w.reading ?? 0 }} />
                        <div className="bg-sky-500" style={{ flex: w.study ?? 0 }} />
                        <div className="bg-violet-500" style={{ flex: w.focus ?? 0 }} />
                      </div>
                    )}
                  </div>
                  <span className={cn('text-[10px] text-muted-foreground', w.date === d.today && 'font-semibold text-foreground')}>{weekdayShort(w.date)}</span>
                </div>
              );
            })}
          </div>
          <div className="flex justify-center gap-3 pt-1 text-[10px] text-muted-foreground">
            <Legend c="bg-primary" l="Leitura" />
            <Legend c="bg-sky-500" l="Estudo" />
            <Legend c="bg-violet-500" l="Foco" />
            <span>tracejado = sem registro</span>
          </div>
        </Section>
      )}

      {d && d.recent.length > 0 && (
        <Section title="Sessões recentes">
          {d.recent.map((s) => (
            <SessionRow key={s.id} s={s} />
          ))}
        </Section>
      )}

      <ManualSessionDialog open={manual} onOpenChange={setManual} />
    </div>
  );
}

function Legend({ c, l }: { c: string; l: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn('h-2 w-2 rounded-full', c)} />
      {l}
    </span>
  );
}

