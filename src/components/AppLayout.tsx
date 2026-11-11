import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { BarChart3, ChevronLeft, Dumbbell, History, Home, Play, Plus, Settings, Sparkles } from 'lucide-react';
import { cn, fmtClock } from '@/lib/utils';
import { Logo } from './Logo';
import { OfflineBadge } from './UpdatePrompt';
import { useActiveSession, useNow } from '@/hooks/data';
import { sessionProgress, remainingMs } from '@/modules/training';
import { Suspense, useEffect, useState } from 'react';
import { RouteErrorBoundary } from './RouteErrorBoundary';
import { EnvBanner } from '@/cloud/ui/EnvBanner';
import { SyncStatusChip } from '@/cloud/ui/SyncStatusChip';
import { ImportOffer } from '@/cloud/ui/ImportOffer';
import { useAccountPointer } from '@/cloud/accountPointer';
import { ACCOUNTS_ENABLED, accountModeActive } from '@/cloud/config';
import { LifeSyncWatcher, RewardFx } from '@/cloud/life/ui';
import { BibleReminders } from '@/cloud/bible/reminders';
import { LIFE_NAV, LIFE_NAV_DESKTOP, type NavItem } from '@/cloud/life/nav';
import { RegisterSheet } from '@/cloud/life/RegisterSheet';

/** P21: onde os dados ficam (texto do rodapé lateral). */
function StorageNote() {
  const p = useAccountPointer();
  if (ACCOUNTS_ENABLED && p?.mode === 'account')
    return (
      <div className="space-y-1.5 px-2">
        <SyncStatusChip />
        <p className="text-xs text-muted-foreground">Conta: {p.email}. Dados neste aparelho e na nuvem; fotos só neste aparelho.</p>
      </div>
    );
  return <p className="px-2 text-xs text-muted-foreground">Dados salvos só neste navegador.</p>;
}


export const NAV: NavItem[] = [
  { to: '/', label: 'Início', icon: Home, end: true },
  // P13: o planejamento semanal (#/planejamento) fica dentro de Treinos, sem novo item na barra.
  // P17: a biblioteca de exercícios (#/exercicios) também (a barra do celular já tem 6 itens em 360 px).
  { to: '/treinos', label: 'Treinos', icon: Dumbbell, also: ['/planejamento', '/exercicios'] },
  { to: '/historico', label: 'Histórico', icon: History },
  // P12: as metas (#/metas) ficam dentro de Evolução, sem novo item na barra. P19: o desempenho (#/desempenho) também.
  { to: '/evolucao', label: 'Evolução', icon: BarChart3, also: ['/metas', '/desempenho'] },
  // Rótulo curto na barra do celular (6 itens em 360 px); nome completo no computador e para leitores de tela.
  { to: '/assistente', label: 'IA', icon: Sparkles, title: 'Assistente IA', ariaLabel: 'Assistente IA' },
  { to: '/config', label: 'Ajustes', icon: Settings, title: 'Configurações' },
];

/** Rotas que pertencem a um item da navegação sem ser sub-rota dele (ex.: #/metas dentro de Evolução). */
const inAlso = (pathname: string, also?: string[]) => !!also?.some((p) => pathname === p || pathname.startsWith(`${p}/`));

function ActivePill() {
  const session = useActiveSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const now = useNow(1000, !!session);
  // Na tela inicial (e no painel de treino do modo conta) o cartão principal já mostra CONTINUAR TREINO.
  if (!session || pathname === '/' || pathname === '/treinar') return null;
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
  const life = accountModeActive();
  const nav = life ? LIFE_NAV : NAV;
  const sideNav = life ? LIFE_NAV_DESKTOP : NAV;
  const [registerOpen, setRegisterOpen] = useState(false);
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
        {life && (
          <button
            type="button"
            onClick={() => setRegisterOpen(true)}
            data-testid="nav-register-desktop"
            className="mt-5 flex items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2.5 text-sm font-semibold text-primary-foreground shadow-[0_6px_24px_-10px_hsl(var(--primary)/0.9)] transition hover:brightness-105 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Plus className="h-4 w-4" strokeWidth={2.6} />
            Registrar
          </button>
        )}
        <nav className={cn('flex flex-col gap-1', life ? 'mt-4' : 'mt-6')} aria-label="Principal">
          {sideNav.map(({ to, label, icon: Icon, end, title, also }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive || inAlso(pathname, also) ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
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
          <StorageNote />
        </div>
      </aside>

      <main className="min-w-0 flex-1 pb-[calc(9rem+env(safe-area-inset-bottom))] md:pb-10">
        <div className="mx-auto w-full max-w-3xl px-4 pt-[calc(1rem+env(safe-area-inset-top))] md:px-8 md:pt-8">
          <div className="mb-2 flex items-center gap-2 empty:hidden">
            <EnvBanner />
            <span className="ml-auto flex items-center gap-2 empty:hidden md:hidden">
              <OfflineBadge />
              <SyncStatusChip />
            </span>
          </div>
          <ImportOffer />
          <motion.div key={pathname} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>
            <RouteErrorBoundary resetKey={pathname}>
              <Suspense fallback={<div className="h-40 animate-pulse rounded-2xl bg-card" />}>
                <Outlet />
              </Suspense>
            </RouteErrorBoundary>
          </motion.div>
        </div>
      </main>

      {life && (
        <>
          <RegisterSheet open={registerOpen} onOpenChange={setRegisterOpen} />
          <RewardFx />
          <LifeSyncWatcher />
          <BibleReminders />
        </>
      )}

      {/* Barra inferior (celular) */}
      <div className="fixed inset-x-0 bottom-0 z-40 md:hidden">
        <div className="px-3 pb-2">
          <ActivePill />
        </div>
        <nav className="border-t border-border/60 bg-background/95 pb-safe backdrop-blur-2xl backdrop-saturate-150" aria-label="Principal">
          <ul className={cn('grid', life ? 'grid-cols-5' : 'grid-cols-6')}>
            {nav.map((item, idx) => (
              <MobileNavCell key={item.to} item={item} pathname={pathname} before={life && idx === 2 ? <RegisterCell onOpen={() => setRegisterOpen(true)} /> : null} />
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, action, back }: { title: string; subtitle?: React.ReactNode; action?: React.ReactNode; back?: string }) {
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 z-20 -mx-4 mb-4 flex items-end justify-between gap-3 bg-background/85 px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.5rem)] backdrop-blur-xl md:static md:mx-0 md:mb-5 md:bg-transparent md:p-0 md:backdrop-blur-none">
      <div className="flex min-w-0 items-center gap-1">
        {back && (
          <button type="button" onClick={() => navigate(back)} aria-label="Voltar" data-testid="page-back" className="-ml-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-95">
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        <div className="min-w-0">
        <h1 className="truncate font-display text-2xl font-bold tracking-tight md:text-3xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {action}
    </header>
  );
}

function MobileNavCell({ item, pathname, before }: { item: NavItem; pathname: string; before?: React.ReactNode }) {
  const { to, label, icon: Icon, end, ariaLabel, also } = item;
  return (
    <>
      {before}
      <li>
        <NavLink
          to={to}
          end={end}
          aria-label={ariaLabel}
          onClick={() => navigator.vibrate?.(6)}
          className={({ isActive }) =>
            cn('flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors active:opacity-70', isActive || inAlso(pathname, also) ? 'text-primary' : 'text-muted-foreground')
          }
        >
          {({ isActive: exact }) => {
            const isActive = exact || inAlso(pathname, also);
            return (
              <>
                <span className="relative flex h-8 w-12 items-center justify-center">
                  {isActive && <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-full bg-primary/15" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
                  <Icon className="relative h-5 w-5" strokeWidth={isActive ? 2.4 : 2} />
                </span>
                {label}
              </>
            );
          }}
        </NavLink>
      </li>
    </>
  );
}

/** Fase 08: botão central "Registrar" da barra do celular (abre o painel de registro rápido). */
function RegisterCell({ onOpen }: { onOpen: () => void }) {
  return (
    <li className="flex items-center justify-center">
      <button
        type="button"
        onClick={() => {
          navigator.vibrate?.(8);
          onOpen();
        }}
        aria-label="Registrar"
        data-testid="nav-register"
        className="flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground active:opacity-80"
      >
        <span className="flex h-9 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[0_4px_18px_-6px_hsl(var(--primary)/0.9)]">
          <Plus className="h-5 w-5" strokeWidth={2.6} />
        </span>
        Registrar
      </button>
    </li>
  );
}
