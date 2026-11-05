// Navegação do modo conta (Fase 01): o app vira o RPG de desenvolvimento pessoal — Início, Missões, Evolução, IA e
// Mais. Todos os módulos de treino continuam acessíveis (Início → Treinar, e Mais). Sem conta, vale a NAV de antes.
import { BarChart3, Home, LayoutGrid, Sparkles, Trophy } from 'lucide-react';

export type NavItem = { to: string; label: string; icon: typeof Home; end?: boolean; title?: string; ariaLabel?: string; also?: string[] };

export const LIFE_NAV: NavItem[] = [
  { to: '/', label: 'Início', icon: Home, end: true },
  { to: '/missoes', label: 'Missões', icon: Trophy },
  { to: '/jornada', label: 'Evolução', icon: BarChart3, also: ['/evolucao', '/metas', '/desempenho'] },
  { to: '/assistente', label: 'IA', icon: Sparkles, title: 'Assistente IA', ariaLabel: 'Assistente IA' },
  { to: '/mais', label: 'Mais', icon: LayoutGrid, also: ['/treinar', '/treinos', '/historico', '/planejamento', '/exercicios', '/config', '/conta'] },
];

