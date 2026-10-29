import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import type { CalendarPrefs } from './calendarPrefs';

// Preferências de exibição do calendário (IronTrack 2.0 F01/P15). Só mudam o que aparece: planejamento, sessões,
// rotação, metas e backups não são tocados. Avisos relevantes de divergência nunca são escondidos.

const OPTIONS: { key: Exclude<keyof CalendarPrefs, 'defaultView'>; label: string; hint: string }[] = [
  { key: 'showLegacy', label: 'Sugestões da agenda antiga', hint: 'Nos dias sem planejamento. Oculto, o dia aparece sem sugestão (a agenda antiga continua em Treinos).' },
  { key: 'showForecasts', label: 'Previsões da rotação', hint: 'Mostra qual treino a rotação prevê. Oculto, aparece só "pela rotação".' },
  { key: 'showSessions', label: 'Sessões concluídas na grade', hint: 'As marcas ✓ na semana e no mês. Os registros continuam no dia selecionado e no Histórico.' },
  { key: 'showGoals', label: 'Metas da semana', hint: 'O cartão de metas abaixo do calendário. As metas não mudam.' },
  { key: 'showInfo', label: 'Observações informativas', hint: 'Divergências que não mudam o que fazer. Avisos relevantes sempre aparecem.' },
];

export function CalendarPrefsDialog({ open, onOpenChange, prefs, onChange, persisted }: { open: boolean; onOpenChange: (v: boolean) => void; prefs: CalendarPrefs; onChange: (patch: Partial<CalendarPrefs>) => void; persisted: boolean }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="calendar-prefs">
        <DialogHeader>
          <DialogTitle>Exibição do calendário</DialogTitle>
          <DialogDescription>Só muda o que aparece nesta tela. Planejamento, treinos, rotação e metas não são alterados.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-sm font-medium" id="pref-view-label">
              Abrir o Planejamento em
            </p>
            <Segmented<'week' | 'month'>
              aria-label="Visão padrão"
              value={prefs.defaultView}
              onChange={(v) => onChange({ defaultView: v })}
              options={[
                { value: 'week', label: <span data-testid="pref-view-week">Semana</span> },
                { value: 'month', label: <span data-testid="pref-view-month">Mês</span> },
              ]}
            />
            <p className="text-xs text-muted-foreground">Links que abrem um dia ou o mês continuam valendo, e você pode alternar a qualquer momento.</p>
          </div>
          <ul className="space-y-3">
            {OPTIONS.map((o) => (
              <li key={o.key} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <label htmlFor={`pref-${o.key}`} className="text-sm font-medium">
                    {o.label}
                  </label>
                  <p className="text-xs text-muted-foreground">{o.hint}</p>
                </div>
                <Switch id={`pref-${o.key}`} checked={prefs[o.key]} onCheckedChange={(v) => onChange({ [o.key]: v })} data-testid={`pref-${o.key}`} />
              </li>
            ))}
          </ul>
          {!persisted && <p className="text-xs text-warn">O armazenamento deste navegador não aceitou a preferência: ela vale só enquanto a tela estiver aberta.</p>}
          <p className="text-xs text-muted-foreground">Guardadas só neste aparelho, por perfil. Não entram no backup.</p>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} data-testid="calendar-prefs-close">
            Pronto
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
