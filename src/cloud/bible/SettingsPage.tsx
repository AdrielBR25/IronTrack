// Ajustes da Bíblia (Fase 05): Início, passagem do dia, lembretes (opcionais), privacidade/IA, leitura offline e a
// ficha da tradução (nome, fonte, data, licença, créditos e estrutura).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Download, Plus, Trash2 } from 'lucide-react';
import { BOOKS, TOTAL_CHAPTERS, TRANSLATION } from '@shared/bible/canon.ts';
import { BPM_INDEX } from '@shared/bible/data/bpm/index.ts';
import { REMINDER_KINDS, REMINDER_LABEL, VERSE_MODES, VERSE_MODE_LABEL, type BiblePrefsView, type PrefsPatch, type Reminder } from '@shared/bible/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { bibleApi } from './api';
import { enableNotifications, notifyEnabled } from './reminders';
import { downloadAll } from './text';

const WD = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

export default function BibleSettingsPage() {
  const q = useLifeQuery(() => bibleApi.prefs().then((r) => r.prefs));
  const [p, setP] = useState<BiblePrefsView | null>(null);
  const [notify, setNotify] = useState(notifyEnabled());
  const [dl, setDl] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => setP(q.data ?? null), [q.data]);
  const save = async (patch: PrefsPatch) => {
    if (!p) return;
    setP({ ...p, ...patch } as BiblePrefsView);
    try {
      setP((await bibleApi.updatePrefs(patch)).prefs);
    } catch (e) {
      toast.error(lifeError(e));
      q.reload();
    }
  };
  const setReminder = (i: number, r: Partial<Reminder>) => p && void save({ reminders: p.reminders.map((x, j) => (j === i ? { ...x, ...r } : x)) });
  const total = BPM_INDEX.books.reduce((n, b) => n + b.verses.reduce((a, x) => a + x, 0), 0);

  return (
    <div className="space-y-4 pb-10" data-testid="bible-settings">
      <PageHeader
        title="Ajustes da Bíblia"
        action={
          <Link to="/biblia" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      {!p ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{q.error ? lifeError(q.error) : 'Carregando…'}</p>
      ) : (
        <>
          <Card>
            <CardContent className="space-y-4 p-4">
              <Row label="Mostrar no Início" hint="A área continua no menu Mais.">
                <Switch checked={p.showOnHome} onCheckedChange={(v) => void save({ showOnHome: v })} aria-label="Mostrar no Início" data-testid="bible-show-home" />
              </Row>
              <div className="space-y-1">
                <Label>Passagem do dia</Label>
                <NativeSelect value={p.verseMode} onChange={(e) => void save({ verseMode: e.target.value as BiblePrefsView['verseMode'] })} data-testid="bible-verse-mode">
                  {VERSE_MODES.map((m) => (
                    <option key={m} value={m}>
                      {VERSE_MODE_LABEL[m]}
                    </option>
                  ))}
                </NativeSelect>
                {p.verseMode === 'interval' && (
                  <div className="flex items-center gap-2 pt-1 text-xs">
                    Nova passagem a cada
                    <NativeSelect value={String(p.verseIntervalMin)} onChange={(e) => void save({ verseIntervalMin: Number(e.target.value) })} className="w-28">
                      {[60, 180, 360, 720].map((m) => (
                        <option key={m} value={m}>
                          {m / 60} h
                        </option>
                      ))}
                    </NativeSelect>
                    ao abrir a Bíblia
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">Nunca como pop-up: aparece na área Bíblia (e no Início, se ativado). A mesma passagem o dia todo, em qualquer aparelho.</p>
              </div>
            </CardContent>
          </Card>

          <section className="space-y-2">
            <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Lembretes (opcionais)</h2>
            <Card>
              <CardContent className="space-y-3 p-4">
                {p.reminders.map((r, i) => (
                  <div key={i} className="space-y-2 rounded-xl bg-secondary/40 p-3">
                    <div className="flex items-center gap-2">
                      <NativeSelect value={r.kind} onChange={(e) => setReminder(i, { kind: e.target.value as Reminder['kind'] })} className="flex-1">
                        {REMINDER_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {REMINDER_LABEL[k]}
                          </option>
                        ))}
                      </NativeSelect>
                      <Input type="time" value={r.time} onChange={(e) => e.target.value && setReminder(i, { time: e.target.value })} className="w-28" aria-label="Horário" />
                      <Switch checked={r.enabled} onCheckedChange={(v) => setReminder(i, { enabled: v })} aria-label="Ativo" />
                    </div>
                    <div className="flex items-center gap-1">
                      {WD.map((d, wd) => (
                        <button
                          key={wd}
                          type="button"
                          onClick={() => {
                            const days = r.days.includes(wd) ? r.days.filter((x) => x !== wd) : [...r.days, wd];
                            if (days.length) setReminder(i, { days });
                          }}
                          className={cn('h-7 w-7 rounded-full text-[11px]', r.days.includes(wd) ? 'bg-primary text-primary-foreground' : 'bg-secondary')}
                        >
                          {d}
                        </button>
                      ))}
                      <button type="button" className="ml-auto rounded-full p-1 text-muted-foreground" onClick={() => void save({ reminders: p.reminders.filter((_, j) => j !== i) })} aria-label="Remover lembrete">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
                {p.reminders.length < 8 && (
                  <Button variant="secondary" size="sm" onClick={() => void save({ reminders: [...p.reminders, { kind: 'reading', enabled: true, time: '07:00', days: [0, 1, 2, 3, 4, 5, 6] }] })} data-testid="bible-reminder-add">
                    <Plus className="h-4 w-4" /> Adicionar lembrete
                  </Button>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label>Silêncio de</Label>
                    <Input type="time" value={p.quietStart ?? ''} onChange={(e) => void save({ quietStart: e.target.value || null })} />
                  </div>
                  <div className="space-y-1">
                    <Label>até</Label>
                    <Input type="time" value={p.quietEnd ?? ''} onChange={(e) => void save({ quietEnd: e.target.value || null })} />
                  </div>
                </div>
                <Row label="Notificação do navegador" hint="Só com o app aberto (inclusive em segundo plano). Com o app fechado ainda não há notificações: isso depende de push no servidor.">
                  <Switch
                    checked={notify}
                    onCheckedChange={async (v) => {
                      const ok = await enableNotifications(v);
                      setNotify(ok);
                      if (v && !ok) toast.error('O navegador não permitiu notificações. Os lembretes continuam dentro do app.');
                    }}
                    aria-label="Notificação do navegador"
                  />
                </Row>
                <p className="text-[11px] text-muted-foreground">Horários no fuso deste aparelho. Lembretes nunca aparecem durante um treino ou uma sessão em andamento.</p>
              </CardContent>
            </Card>
          </section>

          <section className="space-y-2">
            <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Privacidade</h2>
            <Card>
              <CardContent className="space-y-3 p-4 text-xs text-muted-foreground">
                <Row label="IA pode ler minhas reflexões quando eu pedir" hint="Ela nunca lê o diário por conta própria e recebe no máximo 10 entradas por consulta.">
                  <Switch checked={p.shareAi} onCheckedChange={(v) => void save({ shareAi: v })} aria-label="IA pode ler reflexões" />
                </Row>
                <p>Reflexões, gratidões, anotações, favoritos e destaques são privados da sua conta e não entram em compartilhamentos nem relatórios. A área não presume denominação ou tradição religiosa e não dá XP por orações ou pelo conteúdo das reflexões.</p>
              </CardContent>
            </Card>
          </section>
        </>
      )}

      <section className="space-y-2" id="traducao">
        <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tradução e leitura offline</h2>
        <Card>
          <CardContent className="space-y-2 p-4 text-xs" data-testid="bible-translation-info">
            <p className="text-sm font-semibold">
              {TRANSLATION.name} ({TRANSLATION.short})
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
              <dt>Licença</dt>
              <dd>{BPM_INDEX.license} (sem restrições de cópia; atribuição não exigida, mas feita aqui)</dd>
              <dt>Fonte</dt>
              <dd>
                <a href={TRANSLATION.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                  eBible.org ({BPM_INDEX.ebibleId})
                </a>
              </dd>
              <dt>Versão</dt>
              <dd>arquivo USFM de {BPM_INDEX.sourceDate.split('-').reverse().join('/')}</dd>
              <dt>Estrutura</dt>
              <dd>
                {BOOKS.length} livros (39 AT + 27 NT), {TOTAL_CHAPTERS} capítulos, {total.toLocaleString('pt-BR')} versículos
              </dd>
            </dl>
            <p className="text-muted-foreground">{TRANSLATION.draftNotice}</p>
            <p className="text-muted-foreground">O texto é exibido exatamente como publicado (só a formatação de notas foi simplificada). Versículos ausentes no texto-base aparecem marcados, nunca completados.</p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-1"
              disabled={!!dl && dl.done < dl.total}
              onClick={async () => {
                setDl({ done: 0, total: BOOKS.length });
                const n = await downloadAll((done, t) => setDl({ done, total: t }));
                if (n === BOOKS.length) toast.success('Bíblia disponível offline neste aparelho.');
                else toast.error(`${n} de ${BOOKS.length} livros baixados. Tente de novo com conexão.`);
              }}
            >
              <Download className="h-4 w-4" />
              {dl && dl.done < dl.total ? `Baixando ${dl.done}/${dl.total}…` : 'Baixar para ler offline (~4,7 MB)'}
            </Button>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
