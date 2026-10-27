import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { BarChart3, Dumbbell, History, Home, Play, Settings } from 'lucide-react';
import { cn, fmtClock } from '@/lib/utils';
import { Logo } from './Logo';
import { OfflineBadge } from './UpdatePrompt';
import { useActiveSession, useNow } from '@/hooks/data';
import { sessionProgress } from '@/lib/session';
import { remainingMs } from '@/lib/restTimer';
import { Suspense, useEffect } from 'react';

export const NAV = [
  { to: '/', label: 'Início', icon: Home, end: true },
  { to: '/treinos', label: 'Treinos', icon: Dumbbell },
  { to: '/historico', label: 'Histórico', icon: History },
  { to: '/evolucao', label: 'Evolução', icon: BarChart3 },
  { to: '/config', label: 'Ajustes', icon: Settings, title: 'Configurações' },
];

function ActivePill() {
  const session = useActiveSession();
  const navigate = useNavigate();
  const now = useNow(1000, !!session);
  if (!session) return null;
  const p = sessionProgress(session);
  const rest = session.rest ? remainingMs(session.rest, now) : 0;
  return (
    <button
      onClick={() => navigate('/treino')}
      className="flex w-full items-center gap-3 rounded-2xl border border-primary/40 bg-primary/10 px-4 py-2.5 text-left backdrop-blur-xl"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground animate-pulse-ring">
        <Play className="h-4 w-4 fill-current" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block truncate text-sm font-semibold">
          Treino {session.workoutLabel} em andamento
        </span>
        <span className="block text-xs text-muted-foreground tabular">
          {p.done}/{p.total} séries{rest > 0 ? ` · descanso ${fmtClock(rest / 1000)}` : ''}
        </span>
      </span>
      <span className="text-xs font-semibold text-primary">CONTINUAR</span>
    </button>
  );
}

export function AppLayout() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);
  return (
    <div className="min-h-dvh md:flex">
      {/* Navegação lateral (computador) */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r bg-card/40 p-4 md:flex">
        <div className="px-2 py-3">
          <Logo />
        </div>
        <nav className="mt-6 flex flex-col gap-1" aria-label="Principal">
          {NAV.map(({ to, label, icon: Icon, end, title }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )
              }
            >
              <Icon className="h-5 w-5" />
              {title ?? label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-3">
          <ActivePill />
          <OfflineBadge />
          <p className="px-2 text-xs text-muted-foreground">Dados salvos só neste navegador.</p>
        </div>
      </aside>

      <main className="min-w-0 flex-1 pb-[calc(9rem+env(safe-area-inset-bottom))] md:pb-10">
        <div className="mx-auto w-full max-w-3xl px-4 pt-[calc(1rem+env(safe-area-inset-top))] md:px-8 md:pt-8">
          <div className="mb-2 flex justify-end md:hidden">
            <OfflineBadge />
          </div>
          <motion.div key={pathname} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
            <Suspense fallback={<div className="h-40 animate-pulse rounded-2xl bg-card" />}>
              <Outlet />
            </Suspense>
          </motion.div>
        </div>
      </main>

      {/* Barra inferior (celular) */}
      <div className="fixed inset-x-0 bottom-0 z-40 md:hidden">
        <div className="px-3 pb-2">
          <ActivePill />
        </div>
        <nav className="border-t bg-background/90 pb-safe backdrop-blur-xl" aria-label="Principal">
          <ul className="grid grid-cols-5">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    cn('flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors', isActive ? 'text-primary' : 'text-muted-foreground')
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span className={cn('flex h-8 w-14 items-center justify-center rounded-full transition-colors', isActive && 'bg-primary/15')}>
                        <Icon className="h-5 w-5" />
                      </span>
                      {label}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <header className="mb-5 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-bold tracking-tight md:text-3xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}
