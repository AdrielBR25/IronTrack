// Fase 07: aviso de que o app é o da homologação (VITE_APP_ENV=staging). Fase 08: selo compacto na linha de status,
// com a explicação completa ao tocar (title + texto para leitor de tela), sem ocupar uma faixa inteira da tela.
import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { IS_STAGING } from '../config';
import { cn } from '@/lib/utils';

const FULL = 'Homologação: ambiente de testes, separado do IronTrack oficial. Não use dados reais.';

export function EnvBanner({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  if (!IS_STAGING) return null;
  return (
    <button
      type="button"
      role="note"
      data-testid="env-banner"
      title={FULL}
      aria-label={FULL}
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      className={cn('flex min-w-0 items-center gap-1.5 rounded-full bg-amber-400/12 px-2.5 py-1 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-400/30 dark:text-amber-200', className)}
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">{open ? 'Ambiente de testes · não use dados reais' : 'Homologação'}</span>
    </button>
  );
}
