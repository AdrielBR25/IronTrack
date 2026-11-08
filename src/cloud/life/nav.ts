// Navegação do modo conta. Fase 08: no celular, cinco destinos fixos — Início, Semana, Registrar (+), IA e Mais; o botão
// central abre o painel de registro rápido. No computador a barra lateral também mostra Evolução (há espaço) e o
// Registrar vira um botão de destaque no topo. Evolução segue a um toque no Início e em Mais. Sem conta, vale a NAV de antes.
import { BarChart3, CalendarDays, Home, LayoutGrid, Sparkles } from 'lucide-react';

export type NavItem = {
  to: string;
  label: string;
  icon: typeof Home;
  end?: boolean;
  title?: string;
  ariaLabel?: string;
  also?: string[];
};

const MORE_ALSO = [
  '/mais',
  '/missoes',
  '/jornada',
  '/biblia',
  '/alimentacao',
  '/conhecimento',
  '/treinar',
  '/treinos',
  '/historico',
  '/planejamento',
  '/exercicios',
  '/config',
  '/conta',
  '/metas',
  '/desempenho',
  '/evolucao',
];

/** Celular: a posição 3 (meio) é o botão Registrar, desenhado à parte no AppLayout. */
export const LIFE_NAV: NavItem[] = [
  { to: '/', label: 'Início', icon: Home, end: true },
  { to: '/semana', label: 'Semana', icon: CalendarDays },
  {
    to: '/assistente',
    label: 'IA',
    icon: Sparkles,
    title: 'Assistente IA',
    ariaLabel: 'Assistente IA',
  },
  {
    to: '/mais',
    label: 'Mais',
    icon: LayoutGrid,
    also: [...MORE_ALSO, '/minha-evolucao'],
  },
];

export const LIFE_NAV_DESKTOP: NavItem[] = [
  { to: '/', label: 'Início', icon: Home, end: true },
  { to: '/semana', label: 'Semana', icon: CalendarDays },
  {
    to: '/minha-evolucao',
    label: 'Evolução',
    icon: BarChart3,
    also: ['/jornada', '/evolucao', '/metas', '/desempenho'],
  },
  {
    to: '/assistente',
    label: 'IA',
    icon: Sparkles,
    title: 'Assistente IA',
    ariaLabel: 'Assistente IA',
  },
  {
    to: '/mais',
    label: 'Mais',
    icon: LayoutGrid,
    also: MORE_ALSO.filter((p) => !['/jornada', '/evolucao', '/metas', '/desempenho'].includes(p)),
  },
];
