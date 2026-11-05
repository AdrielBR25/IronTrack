// Fase 07: faixa fixa no topo do conteúdo quando o app é o da homologação (VITE_APP_ENV=staging).
import { FlaskConical } from 'lucide-react';
import { IS_STAGING } from '../config';
import { cn } from '@/lib/utils';

export function EnvBanner({ className }: { className?: string }) {
  if (!IS_STAGING) return null;
  return (
    <div role="note" data-testid="env-banner" className={cn('mb-3 flex items-center gap-2 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-200', className)}>
      <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />
      <span>Homologação · ambiente de testes, separado do IronTrack oficial. Não use dados reais.</span>
    </div>
  );
}
