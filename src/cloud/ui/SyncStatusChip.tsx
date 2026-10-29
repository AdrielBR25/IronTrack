// Indicador de sincronização (Prompt 21). Estados: Sincronizado, Sincronizando, Offline, Pendentes, Conflito, Erro
// (+ "Entrar de novo" quando a sessão expirou). Texto sempre visível: não depende de cor. "Sincronizado" só aparece
// quando o servidor confirmou tudo (ver SyncEngine.refreshCounts).
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, CloudOff, GitMerge, Loader2, LogIn, UploadCloud } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSyncStatus, type SyncStatus } from '../syncEngine';

export function syncLabel(s: SyncStatus): { text: string; tone: 'ok' | 'busy' | 'warn' | 'error'; icon: typeof CheckCircle2 } {
  switch (s.state) {
    case 'synced':
      return { text: 'Sincronizado', tone: 'ok', icon: CheckCircle2 };
    case 'syncing':
      return { text: 'Sincronizando', tone: 'busy', icon: Loader2 };
    case 'offline':
      return { text: s.pending ? `Offline · ${s.pending} pendente${s.pending > 1 ? 's' : ''}` : 'Offline', tone: 'warn', icon: CloudOff };
    case 'pending':
      return { text: s.pending ? `${s.pending} pendente${s.pending > 1 ? 's' : ''}` : 'Pendentes', tone: 'warn', icon: UploadCloud };
    case 'conflict':
      return { text: `Conflito${s.conflicts > 1 ? `s (${s.conflicts})` : ''}`, tone: 'error', icon: GitMerge };
    case 'auth_required':
      return { text: 'Entrar de novo', tone: 'error', icon: LogIn };
    default:
      return { text: 'Erro de sincronização', tone: 'error', icon: AlertTriangle };
  }
}

export function SyncStatusChip({ className }: { className?: string }) {
  const s = useSyncStatus();
  if (!s) return null;
  const { text, tone, icon: Icon } = syncLabel(s);
  return (
    <Link
      to={s.state === 'auth_required' ? '/conta/entrar' : '/conta/sincronizacao'}
      data-testid="sync-status"
      data-state={s.state}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        tone === 'ok' && 'bg-primary/15 text-primary',
        tone === 'busy' && 'bg-secondary text-secondary-foreground',
        tone === 'warn' && 'bg-warn/15 text-warn',
        tone === 'error' && 'bg-destructive/15 text-destructive',
        className,
      )}
      aria-label={`Sincronização: ${text}. Ver detalhes`}
    >
      <Icon className={cn('h-3.5 w-3.5', s.state === 'syncing' && 'animate-spin')} aria-hidden />
      <span role="status">{text}</span>
    </Link>
  );
}
