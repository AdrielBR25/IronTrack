import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { BarChart3, Dumbbell, History, Home, Play, Settings, Sparkles } from 'lucide-react';
import { cn, fmtClock } from '@/lib/utils';
import { Logo } from './Logo';
import { OfflineBadge } from './UpdatePrompt';
import { useActiveSession, useNow } from '@/hooks/data';
import { sessionProgress, remainingMs } from '@/modules/training';
import { Suspense, useEffect } from 'react';

export const NAV = [
  { to: '/', label: 'Início', icon: Home, end: true },
  { to: '/treinos', label: 'Treinos', icon: Dumbbell },
  { to: '/historico', label: 'Histórico', icon: History },
  { to: '/evolucao', label: 'Evolução', icon: BarChart3 },
  // Rótulo curto na barra do celular (6 itens em 360 px); nome completo no computador e para leitores de tela.
  { to: '/assistente', label: 'IA', icon: Sparkles, title: 'Assistente IA', ariaLabel: 'Assistente IA' },
  { to: '/config', label: 'Ajustes', icon: Settings, title: 'Configurações' },
];

function ActivePill() {
  const session = useActiveSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const now = useNow(1000, !!session);
  // Na tela inicial o cartão principal já mostra CONTINUAR TREINO.
  if (!session || pathname === '/') return null;
  const p = sessionProgress(session);
  const rest = session.rest ? remainingMs(session.rest, now) : 0;
  return (
    <button
      onClick={() => navigate('/treino')}
      className="flex w-full items-center gap-3 rounded-2xl border border-primary/40 bg-card px-4 py-2.5 text-left shadow-[0_8px_30px_rgba(0,0,0,0.5)] active:scale-[0.98]"
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
          <div className="flex justify-end empty:hidden md:hidden">
            <OfflineBadge className="mb-2" />
          </div>
          <motion.div key={pathname} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>
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
        <nav className="border-t border-border/60 bg-background/95 pb-safe backdrop-blur-2xl backdrop-saturate-150" aria-label="Principal">
          <ul className="grid grid-cols-6">
            {NAV.map(({ to, label, icon: Icon, end, ariaLabel }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  aria-label={ariaLabel}
                  onClick={() => navigator.vibrate?.(6)}
                  className={({ isActive }) =>
                    cn('flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors active:opacity-70', isActive ? 'text-primary' : 'text-muted-foreground')
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span className="relative flex h-8 w-12 items-center justify-center">
                        {isActive && (
                          <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-full bg-primary/15" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
                        )}
                        <Icon className="relative h-5 w-5" strokeWidth={isActive ? 2.4 : 2} />
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
    <header className="sticky top-0 z-20 -mx-4 mb-4 flex items-end justify-between gap-3 bg-background/85 px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.5rem)] backdrop-blur-xl md:static md:mx-0 md:mb-5 md:bg-transparent md:p-0 md:backdrop-blur-none">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-bold tracking-tight md:text-3xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}
