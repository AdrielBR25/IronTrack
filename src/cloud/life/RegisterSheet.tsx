// Fase 08: painel "Registrar" (botão + da navegação). Um toque leva direto ao formulário certo de cada módulo — nada é
// gravado aqui; cada tela de destino mantém as próprias regras (XP, validação, aprovação).
import { useNavigate } from 'react-router-dom';
import { Apple, BookOpenText, Camera, CalendarPlus, Dumbbell, Play, Repeat, Timer, type LucideIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useActiveSession } from '@/hooks/data';
import { cn } from '@/lib/utils';

interface Entry {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  to: string;
  tone: string;
}

export function RegisterSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const active = useActiveSession();
  const entries: Entry[] = [
    {
      id: 'refeicao',
      label: 'Refeição',
      hint: 'Buscar alimentos',
      icon: Apple,
      to: '/alimentacao?registrar=1',
      tone: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    },
    {
      id: 'foto',
      label: 'Foto do prato',
      hint: 'Estimar pela foto',
      icon: Camera,
      to: '/alimentacao?foto=1',
      tone: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    },
    active
      ? {
          id: 'treino',
          label: 'Continuar treino',
          hint: `Treino ${active.workoutLabel}`,
          icon: Play,
          to: '/treino',
          tone: 'bg-rose-500/15 text-rose-500 dark:text-rose-400',
        }
      : {
          id: 'treino',
          label: 'Treino',
          hint: 'Escolher e iniciar',
          icon: Dumbbell,
          to: '/treinar',
          tone: 'bg-rose-500/15 text-rose-500 dark:text-rose-400',
        },
    {
      id: 'habito',
      label: 'Hábito',
      hint: 'Marcar os de hoje',
      icon: Repeat,
      to: '/missoes',
      tone: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
    },
    {
      id: 'estudo',
      label: 'Estudo',
      hint: 'Iniciar cronômetro',
      icon: Timer,
      to: '/conhecimento/foco',
      tone: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
    },
    {
      id: 'biblia',
      label: 'Leitura bíblica',
      hint: 'Continuar de onde parou',
      icon: BookOpenText,
      to: '/biblia/ler',
      tone: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
    },
    {
      id: 'atividade',
      label: 'Atividade',
      hint: 'Agendar na semana',
      icon: CalendarPlus,
      to: '/semana?nova=1',
      tone: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    },
  ];
  const go = (to: string) => {
    onOpenChange(false);
    navigator.vibrate?.(6);
    navigate(to);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="register-sheet" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Registrar</DialogTitle>
          <DialogDescription>O que você quer registrar agora?</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {entries.map((e, i) => (
            <button
              key={e.id}
              type="button"
              onClick={() => go(e.to)}
              className={cn(
                'flex min-h-[4.25rem] items-center gap-3 rounded-2xl bg-secondary/60 p-3 text-left transition hover:bg-secondary active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                i === entries.length - 1 && entries.length % 2 === 1 && 'col-span-2',
              )}
            >
              <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', e.tone)}>
                <e.icon className="h-5 w-5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold leading-tight">{e.label}</span>
                <span className="block text-xs leading-snug text-muted-foreground">{e.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
