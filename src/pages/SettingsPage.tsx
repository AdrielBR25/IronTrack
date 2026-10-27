import { useEffect, useRef, useState } from 'react';
import { Bell, Database, Download, HardDrive, Palette, Plus, Smartphone, Target, Timer, TrendingUp, Upload, Vibrate, Volume2, X, Dumbbell, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/AppLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Segmented } from '@/components/ui/segmented';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm';
import { useSettings } from '@/hooks/data';
import { db, requestPersistentStorage, saveSettings } from '@/db/db';
import type { Equipment, Settings } from '@/lib/types';
import { GOAL_LABEL } from '@/lib/defaults';
import { EQUIPMENT_LABEL } from '@/lib/units';
import { cn, downloadJson, fmtNum, parseNum, readFileText } from '@/lib/utils';
import { weekdayShort } from '@/lib/dates';
import { audioAvailable, notificationState, playBeep, requestNotificationPermission, showLocalNotification, unlockAudio, vibrate, vibrationAvailable, type NotifState } from '@/lib/alerts';
import { useInstallAvailable } from '@/components/InstallBanner';
import { promptInstall } from '@/lib/install';
import { exportBackup, parseBackup, restoreBackupMerge, restoreBackupReplace, type BackupFile } from '@/lib/backup';

function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function NumField({ value, onCommit, suffix, min = 0, max = 9999, integer, label }: { value: number; onCommit: (v: number) => void; suffix?: string; min?: number; max?: number; integer?: boolean; label: string }) {
  const [t, setT] = useState(fmtNum(value, 2));
  useEffect(() => setT(fmtNum(value, 2)), [value]);
  return (
    <div className="flex items-center gap-1.5">
      <Input
        aria-label={label}
        className="h-10 w-20 text-center tabular"
        inputMode={integer ? 'numeric' : 'decimal'}
        value={t}
        onChange={(e) => setT(e.target.value)}
        onBlur={() => {
          const n = parseNum(t);
          if (n === null || n < min || n > max || (integer && !Number.isInteger(n))) {
            toast.error(`${label}: valor entre ${min} e ${max}`);
            setT(fmtNum(value, 2));
            return;
          }
          if (n !== value) onCommit(n);
        }}
      />
      {suffix && <span className="w-6 text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

function Section({ icon: Icon, title, description, children }: { icon: typeof Bell; title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-primary" /> {title}
        </CardTitle>
        {description && <CardDescription className="text-xs">{description}</CardDescription>}
      </CardHeader>
      <CardContent className="divide-y">{children}</CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const s = useSettings();
  const set = (p: Partial<Settings>) => void saveSettings(p);
  const [notif, setNotif] = useState<NotifState>(notificationState());
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<string | null>(null);
  const [pendingBackup, setPendingBackup] = useState<BackupFile | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [newGroup, setNewGroup] = useState('');
  const installAvailable = useInstallAvailable();
  const fileRef = useRef<HTMLInputElement>(null);
  const standalone = typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches;

  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
    void navigator.storage?.estimate?.().then((e) => setUsage(e.usage != null ? `${fmtNum((e.usage ?? 0) / 1024 / 1024, 1)} MB usados` : null));
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader title="Configurações" subtitle="Personalize o IronTrack" />

      <Section icon={Target} title="Perfil">
        <div className="space-y-1.5 py-3">
          <Label htmlFor="s-name">Seu nome</Label>
          <Input id="s-name" defaultValue={s.userName} key={s.userName} onBlur={(e) => e.target.value.trim() !== s.userName && set({ userName: e.target.value.trim() })} placeholder="Para a saudação" />
        </div>
        <div className="space-y-1.5 py-3">
          <Label>Objetivo</Label>
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(GOAL_LABEL) as Settings['goal'][]).map((g) => (
              <button key={g} onClick={() => set({ goal: g })} className={cn('rounded-xl border px-3 py-2.5 text-sm font-medium', s.goal === g ? 'border-primary bg-primary/10' : 'text-muted-foreground')}>
                {GOAL_LABEL[g]}
              </button>
            ))}
          </div>
        </div>
      </Section>

      <Section icon={Dumbbell} title="Treino">
        <Row label="Unidade de peso" hint="Os dados são guardados em kg e convertidos na tela.">
          <Segmented
            className="w-32"
            value={s.weightUnit}
            onChange={(u) => set({ weightUnit: u })}
            options={[
              { value: 'kg', label: 'kg' },
              { value: 'lb', label: 'lb' },
            ]}
          />
        </Row>
        <div className="space-y-2 py-3">
          <p className="text-sm font-medium">Dias de treino</p>
          <div className="flex gap-1.5">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => {
              const on = s.trainingDays.includes(d);
              return (
                <button
                  key={d}
                  aria-pressed={on}
                  onClick={() => {
                    const next = on ? s.trainingDays.filter((x) => x !== d) : [...s.trainingDays, d];
                    if (!next.length) return toast.error('Mantenha pelo menos 1 dia de treino');
                    set({ trainingDays: next.sort() });
                  }}
                  className={cn('h-11 flex-1 rounded-xl text-xs font-semibold', on ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground')}
                >
                  {weekdayShort(d)}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">A rotação segue nesses dias e continua de onde parou na semana seguinte.</p>
        </div>
        <Row label="Descanso de compostos" hint="Padrão para novos exercícios">
          <NumField label="Descanso de compostos" integer max={900} value={s.restCompoundSec} onCommit={(v) => set({ restCompoundSec: v })} suffix="s" />
        </Row>
        <Row label="Descanso de isoladores">
          <NumField label="Descanso de isoladores" integer max={900} value={s.restIsolationSec} onCommit={(v) => set({ restIsolationSec: v })} suffix="s" />
        </Row>
        <Row label="Descanso após aquecimento">
          <NumField label="Descanso após aquecimento" integer max={600} value={s.restWarmupSec} onCommit={(v) => set({ restWarmupSec: v })} suffix="s" />
        </Row>
        <Row label="Passo do botão de peso (+/−)">
          <NumField label="Passo de peso" min={0.25} max={50} value={s.weightStep} onCommit={(v) => set({ weightStep: v })} suffix={s.weightUnit} />
        </Row>
        <Row label="Passo do botão de repetições">
          <NumField label="Passo de repetições" integer min={1} max={10} value={s.repStep} onCommit={(v) => set({ repStep: v })} />
        </Row>
        <Row label="Dica de carga por equipamento" hint="Ex.: “soma dos 2 halteres”. A carga registrada é sempre a carga total externa.">
          <Switch checked={s.showEquipmentHint} onCheckedChange={(v) => set({ showEquipmentHint: v })} aria-label="Dica de carga por equipamento" />
        </Row>
      </Section>

      <Section icon={TrendingUp} title="Progressão de carga" description="Sugestão quando todas as séries chegam ao topo da faixa com margem. Nunca aplicada sem sua confirmação.">
        {(Object.keys(EQUIPMENT_LABEL) as Equipment[]).map((k) => (
          <Row key={k} label={`Incremento · ${EQUIPMENT_LABEL[k]}`}>
            <NumField label={`Incremento ${EQUIPMENT_LABEL[k]}`} min={0.25} max={50} value={s.progression.increments[k]} onCommit={(v) => set({ progression: { ...s.progression, increments: { ...s.progression.increments, [k]: v } } })} suffix="kg" />
          </Row>
        ))}
        <Row label="RIR mínimo compatível" hint="Se registrar RIR abaixo disso, a sugestão é manter a carga.">
          <NumField label="RIR mínimo" integer max={5} value={s.progression.minRir} onCommit={(v) => set({ progression: { ...s.progression, minRir: v } })} />
        </Row>
        <Row label="RPE máximo compatível">
          <NumField label="RPE máximo" min={5} max={10} value={s.progression.maxRpe} onCommit={(v) => set({ progression: { ...s.progression, maxRpe: v } })} />
        </Row>
      </Section>

      <Section icon={RotateCw} title="Rotação de treinos" description="A rotação nunca avança só por abrir o app.">
        <div className="space-y-2 py-3">
          <Segmented
            value={s.rotationPolicy}
            onChange={(v) => set({ rotationPolicy: v })}
            options={[
              { value: 'finish', label: 'Ao finalizar' },
              { value: 'threshold', label: 'Com % mínimo' },
            ]}
          />
          <p className="text-xs text-muted-foreground">
            {s.rotationPolicy === 'finish'
              ? 'Avança ao finalizar um treino com pelo menos 1 série válida.'
              : 'Avança só se a porcentagem mínima das séries planejadas for concluída.'}
          </p>
        </div>
        {s.rotationPolicy === 'threshold' && (
          <Row label="Porcentagem mínima">
            <NumField label="Porcentagem mínima" integer min={1} max={100} value={s.rotationThreshold} onCommit={(v) => set({ rotationThreshold: v })} suffix="%" />
          </Row>
        )}
      </Section>

      <Section icon={Timer} title="Avisos de descanso" description="Com o app aberto, som e vibração funcionam de forma confiável. Com a tela bloqueada, o navegador pode atrasar ou bloquear avisos; a contagem continua correta ao voltar.">
        <Row label="Som" hint={audioAvailable() ? undefined : 'Indisponível neste navegador'}>
          <div className="flex items-center gap-2">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Testar som"
              onClick={() => {
                unlockAudio();
                playBeep();
              }}
            >
              <Volume2 />
            </Button>
            <Switch checked={s.sound} onCheckedChange={(v) => set({ sound: v })} aria-label="Som" />
          </div>
        </Row>
        <Row label="Vibração" hint={vibrationAvailable() ? undefined : 'Indisponível neste aparelho/navegador (ex.: iPhone)'}>
          <div className="flex items-center gap-2">
            <Button size="icon-sm" variant="ghost" aria-label="Testar vibração" disabled={!vibrationAvailable()} onClick={() => vibrate()}>
              <Vibrate />
            </Button>
            <Switch checked={s.vibration} onCheckedChange={(v) => set({ vibration: v })} aria-label="Vibração" />
          </div>
        </Row>
        <Row
          label="Notificações"
          hint={
            notif === 'unsupported'
              ? 'Não suportadas aqui. Instale o app para tentar novamente.'
              : notif === 'denied'
                ? 'Bloqueadas. Libere nas configurações do navegador.'
                : notif === 'granted'
                  ? 'Permitidas. Aviso quando o app estiver em segundo plano.'
                  : 'Toque em Permitir para autorizar.'
          }
        >
          {notif === 'granted' ? (
            <div className="flex items-center gap-2">
              <Button size="icon-sm" variant="ghost" aria-label="Testar notificação" onClick={() => void showLocalNotification('IronTrack', 'Notificações funcionando!')}>
                <Bell />
              </Button>
              <Switch checked={s.notifications} onCheckedChange={(v) => set({ notifications: v })} aria-label="Notificações" />
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={notif === 'unsupported' || notif === 'denied'}
              onClick={async () => {
                const r = await requestNotificationPermission();
                setNotif(r);
                if (r === 'granted') {
                  set({ notifications: true });
                  toast.success('Notificações ativadas');
                }
              }}
            >
              Permitir
            </Button>
          )}
        </Row>
      </Section>

      <Section icon={Palette} title="Aparência">
        <div className="py-3">
          <Segmented
            value={s.theme}
            onChange={(t) => set({ theme: t })}
            options={[
              { value: 'dark', label: 'Escuro' },
              { value: 'light', label: 'Claro' },
              { value: 'system', label: 'Sistema' },
            ]}
          />
        </div>
      </Section>

      <Section icon={Dumbbell} title="Grupos musculares">
        <div className="space-y-3 py-3">
          <div className="flex flex-wrap gap-1.5">
            {s.muscleGroups.map((g) => (
              <span key={g} className="flex items-center gap-1 rounded-full bg-secondary py-1 pl-3 pr-1 text-sm">
                {g}
                <button aria-label={`Remover ${g}`} className="rounded-full p-1 hover:bg-accent" onClick={() => set({ muscleGroups: s.muscleGroups.filter((x) => x !== g) })}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const g = newGroup.trim();
              if (!g || s.muscleGroups.includes(g)) return;
              set({ muscleGroups: [...s.muscleGroups, g] });
              setNewGroup('');
            }}
          >
            <Input placeholder="Novo grupo (ex.: Lombar)" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
            <Button type="submit" variant="secondary" size="icon" aria-label="Adicionar grupo">
              <Plus />
            </Button>
          </form>
        </div>
      </Section>

      <Section icon={Database} title="Dados e backup" description="Tudo fica salvo apenas neste navegador, neste aparelho. Não há sincronização entre dispositivos.">
        <div className="grid gap-2 py-3 sm:grid-cols-2">
          <Button
            size="lg"
            data-testid="export-backup"
            onClick={async () => {
              const b = await exportBackup();
              downloadJson(`irontrack-backup-${new Date().toISOString().slice(0, 10)}.json`, b);
              toast.success('Backup exportado', { description: `${b.data.sessions.length} treinos, ${b.data.routines.length} rotinas` });
            }}
          >
            <Download /> Exportar backup
          </Button>
          <Button size="lg" variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload /> Restaurar backup
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            data-testid="import-backup-input"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const r = parseBackup(await readFileText(f));
              if (!r.ok) toast.error('Backup inválido', { description: r.errors.join('\n'), duration: 10000 });
              else setPendingBackup(r.value);
            }}
          />
        </div>
        <div className="space-y-2 py-3 text-xs text-muted-foreground">
          <p className="flex items-start gap-2">
            <HardDrive className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Apagar os dados de navegação/site deste navegador elimina seus registros. Exporte backups com frequência.
              {usage && ` · ${usage}`}
            </span>
          </p>
          <p>
            Armazenamento persistente:{' '}
            <strong className={persisted ? 'text-primary' : 'text-foreground'}>{persisted === null ? 'indisponível' : persisted ? 'ativo' : 'não garantido'}</strong>
            {!persisted && (
              <button
                className="ml-2 font-semibold text-primary underline-offset-2 hover:underline"
                onClick={async () => {
                  const r = await requestPersistentStorage();
                  setPersisted(r);
                  toast(r ? 'Armazenamento persistente ativado' : 'O navegador não concedeu agora. Instalar o app costuma ajudar.');
                }}
              >
                Solicitar
              </button>
            )}
          </p>
        </div>
        <div className="py-3">
          <Button variant="ghost" className="w-full text-destructive" onClick={() => setConfirmWipe(true)}>
            Apagar todos os dados
          </Button>
        </div>
      </Section>

      <Section icon={Smartphone} title="Instalar o app">
        <div className="space-y-2 py-3 text-sm">
          {standalone ? (
            <p className="text-primary">O IronTrack está instalado e funciona offline.</p>
          ) : installAvailable ? (
            <Button className="w-full" onClick={() => void promptInstall()}>
              <Smartphone /> Instalar IronTrack
            </Button>
          ) : (
            <p className="text-muted-foreground">
              No Android (Chrome): menu ⋮ › <strong>Instalar app</strong> ou <strong>Adicionar à tela inicial</strong>. No PC (Chrome/Edge): ícone de instalar na barra de endereço.
            </p>
          )}
          <p className="text-xs text-muted-foreground">Versão {__APP_VERSION__}</p>
        </div>
      </Section>

      <Dialog open={!!pendingBackup && !confirmReplace} onOpenChange={(o) => !o && setPendingBackup(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restaurar backup</DialogTitle>
            <DialogDescription>
              Backup de {pendingBackup ? new Date(pendingBackup.exportedAt).toLocaleString('pt-BR') : ''}: {pendingBackup?.data.routines.length} rotinas, {pendingBackup?.data.sessions.length} treinos,{' '}
              {pendingBackup?.data.bodyEntries.length} avaliações.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Button
              size="lg"
              data-testid="backup-merge"
              onClick={async () => {
                if (!pendingBackup) return;
                const r = await restoreBackupMerge(pendingBackup);
                setPendingBackup(null);
                toast.success('Backup mesclado', { description: `+${r.sessions} treinos, +${r.routines} rotinas, +${r.bodyEntries} avaliações · ${r.skipped} duplicados ignorados` });
              }}
            >
              Mesclar com os dados atuais
            </Button>
            <Button size="lg" variant="outline" className="text-destructive" data-testid="backup-replace" onClick={() => setConfirmReplace(true)}>
              Substituir todos os dados
            </Button>
          </div>
          <DialogFooter>
            <p className="text-xs text-muted-foreground">Mesclar adiciona o que não existe, sem duplicar.</p>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmReplace}
        onOpenChange={(o) => {
          setConfirmReplace(o);
          if (!o) setPendingBackup(null);
        }}
        destructive
        title="Substituir todos os dados?"
        description="Tudo o que está neste aparelho será apagado e trocado pelo conteúdo do backup. Essa ação não pode ser desfeita."
        confirmLabel="Substituir"
        onConfirm={async () => {
          if (!pendingBackup) return;
          const r = await restoreBackupReplace(pendingBackup);
          toast.success('Backup restaurado', { description: `${r.sessions} treinos, ${r.routines} rotinas` });
        }}
      />
      <ConfirmDialog
        open={confirmWipe}
        onOpenChange={setConfirmWipe}
        destructive
        title="Apagar todos os dados?"
        description="Rotinas, histórico, avaliações, fotos e configurações deste aparelho serão apagados. Exporte um backup antes, se quiser guardar."
        confirmLabel="Apagar tudo"
        onConfirm={async () => {
          await db.transaction('rw', [db.settings, db.routines, db.sessions, db.rotations, db.overrides, db.bodyEntries, db.photos], async () => {
            await Promise.all([db.settings, db.routines, db.sessions, db.rotations, db.overrides, db.bodyEntries, db.photos].map((t) => t.clear()));
          });
          toast('Dados apagados');
        }}
      />
    </div>
  );
}
