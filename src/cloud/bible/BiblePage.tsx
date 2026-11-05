// Área Bíblia (Fase 05): passagem do dia, ler/continuar, plano atual, semana de leitura, metas, reflexões recentes,
// favoritos e atalho para a IA. Nada aqui é obrigatório: a área pode ficar fora do Início (Ajustes).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { BookMarked, BookOpen, CalendarCheck, Heart, MessageCircle, NotebookPen, Play, Plus, Search, Settings, Sparkles, Target } from 'lucide-react';
import type { DailyVerseView } from '@shared/bible/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { ActiveTimerBanner, Section } from '../knowledge/parts';
import { GoalRow, fmtMin, weekdayShort } from '../knowledge/ui';
import { bibleApi } from './api';
import { LinkRow, MarkRow, NavTile, PlanRow, ReflectionRow, TranslationCredit, VerseOfDayCard, readerLink } from './ui';

const INTERVAL_KEY = 'irontrack.bible.verseShownAt.v1';

export default function BiblePage() {
  const q = useLifeQuery(() => bibleApi.home());
  const d = q.data;
  const [verse, setVerse] = useState<DailyVerseView | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => setVerse(d?.verse ?? null), [d?.verse]);

  // Modo "em intervalos": ao abrir a área depois do intervalo escolhido, mostra a próxima passagem (sem pop-up).
  useEffect(() => {
    if (!d || d.prefs.verseMode !== 'interval') return;
    let last = 0;
    try {
      last = Number(localStorage.getItem(INTERVAL_KEY)) || 0;
    } catch {
      /* sem armazenamento */
    }
    const now = Date.now();
    if (last && now - last >= d.prefs.verseIntervalMin * 60_000) void bibleApi.anotherVerse().then((r) => setVerse(r.verse)).catch(() => undefined);
    try {
      if (!last || now - last >= d.prefs.verseIntervalMin * 60_000) localStorage.setItem(INTERVAL_KEY, String(now));
    } catch {
      /* ignora */
    }
  }, [d]);

  const askVerse = async () => {
    setAsking(true);
    try {
      setVerse((await bibleApi.verse()).verse);
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setAsking(false);
    }
  };
  const max = Math.max(1, ...(d?.week ?? []).map((w) => w.minutes));
  const plan = d?.plans.find((p) => p.status === 'active');

  return (
    <div className="space-y-4 pb-10" data-testid="bible-page">
      <PageHeader
        title="Bíblia"
        subtitle="Leitura, planos e reflexões"
        action={
          <Link to="/biblia/ajustes" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Ajustes da Bíblia">
            <Settings className="h-5 w-5" />
          </Link>
        }
      />
      <ActiveTimerBanner />
      {q.error && !d ? <p className="rounded-xl bg-destructive/15 p-3 text-sm">{lifeError(q.error)}</p> : null}

      {verse ? (
        <VerseOfDayCard verse={verse} onChange={setVerse} />
      ) : d ? (
        <Button variant="secondary" className="w-full" onClick={() => void askVerse()} disabled={asking} data-testid="bible-verse-ask">
          <Sparkles className="h-4 w-4" />
          Mostrar uma passagem
        </Button>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <Button asChild size="lg" data-testid="bible-read">
          <Link to={d?.resume ? readerLink(d.resume.ref) : '/biblia/ler'}>
            <BookOpen className="h-4 w-4" />
            {d?.resume ? 'Continuar' : 'Ler Bíblia'}
          </Link>
        </Button>
        <Button asChild size="lg" variant="secondary">
          <Link to={plan?.next ? `${readerLink(plan.next.chapters[0])}&plano=${plan.id}&dia=${plan.next.day}` : '/biblia/planos'}>
            <Play className="h-4 w-4" />
            {plan?.next ? 'Leitura do plano' : 'Escolher plano'}
          </Link>
        </Button>
      </div>
      {d?.resume && <p className="-mt-2 px-1 text-xs text-muted-foreground">Você parou em {d.resume.label}.</p>}

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Esta semana</h2>
            <span className="text-xs tabular-nums text-muted-foreground">{d ? `${fmtMin(d.weekMinutes)} · ${d.weekChapters} cap.` : '–'}</span>
          </div>
          <div className="flex h-16 items-end gap-1.5" aria-label="Minutos de leitura por dia">
            {(d?.week ?? []).map((w) => (
              <div key={w.date} className="flex flex-1 flex-col items-center gap-1">
                <div className={cn('w-full rounded-md', w.minutes || w.chapters ? 'bg-primary' : 'bg-secondary')} style={{ height: `${Math.max(6, (w.minutes / max) * 48)}px` }} title={`${w.minutes} min · ${w.chapters} cap.`} />
                <span className="text-[10px] text-muted-foreground">{weekdayShort(w.date)}</span>
              </div>
            ))}
          </div>
          {d && (
            <p className="text-center text-[11px] text-muted-foreground">
              {d.totals.chaptersRead} capítulo(s) diferente(s) lido(s) · {fmtMin(d.totals.minutes)} no total · {d.totals.daysWithReading} dia(s) com leitura
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-4 gap-2">
        <NavTile to="/biblia/planos" label="Planos" icon={CalendarCheck} />
        <NavTile to="/biblia/diario" label="Diário" icon={NotebookPen} />
        <NavTile to="/biblia/favoritos" label="Favoritos" icon={Heart} />
        <NavTile to="/biblia/buscar" label="Buscar" icon={Search} />
      </div>

      {d && d.plans.length > 0 && (
        <Section title="Planos" to="/biblia/planos">
          {d.plans.slice(0, 3).map((p) => (
            <PlanRow key={p.id} p={p} />
          ))}
        </Section>
      )}

      <Section title="Metas (opcionais)" to="/biblia/metas">
        {d && d.goals.length ? d.goals.map((g) => <GoalRow key={g.id} g={g} />) : <LinkRow to="/biblia/metas">Criar uma meta de leitura</LinkRow>}
      </Section>

      <Section title="Reflexões recentes" to="/biblia/diario">
        {d && d.reflections.length ? (
          d.reflections.map((r) => <ReflectionRow key={r.id} r={r} />)
        ) : (
          <Link to="/biblia/diario?nova=1" className="flex items-center gap-2 py-2.5 text-sm text-muted-foreground">
            <Plus className="h-4 w-4" />
            Escrever uma reflexão ou gratidão
          </Link>
        )}
      </Section>

      {d && d.favorites.length > 0 && (
        <Section title="Favoritos" to="/biblia/favoritos">
          {d.favorites.map((m) => (
            <MarkRow key={m.id} m={m} />
          ))}
        </Section>
      )}

      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <MessageCircle className="h-5 w-5 shrink-0 text-primary" />
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">A IA pode explicar o contexto de uma passagem, montar um plano ou sugerir uma rotina. Ela cita sempre a referência e a tradução.</p>
          <Button asChild size="sm" variant="secondary">
            <Link to={`/assistente?q=${encodeURIComponent('Monte comigo um plano de leitura bíblica que caiba na minha rotina.')}`}>Conversar</Link>
          </Button>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <Link to="/biblia/versiculos" className="flex items-center gap-2 rounded-2xl bg-card p-3">
          <Sparkles className="h-4 w-4 text-primary" />
          Passagens anteriores
        </Link>
        <Link to="/biblia/metas" className="flex items-center gap-2 rounded-2xl bg-card p-3">
          <Target className="h-4 w-4 text-primary" />
          Metas e sessões
        </Link>
        <Link to="/biblia/progresso" className="col-span-2 flex items-center gap-2 rounded-2xl bg-card p-3">
          <BookMarked className="h-4 w-4 text-primary" />
          Progresso por livro
        </Link>
      </div>
      <TranslationCredit />
    </div>
  );
}
