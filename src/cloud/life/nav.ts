// Navegação do modo conta (Fase 01 → Fase 06): Início, Semana (agenda unificada), Evolução (todas as áreas), IA e
// Mais. Missões seguem no Início e em Mais. Todos os módulos de treino continuam acessíveis (Início → Treinar, e Mais). Sem conta, vale a NAV de antes.
import { BarChart3, CalendarDays, Home, LayoutGrid, Sparkles } from 'lucide-react';

export type NavItem = { to: string; label: string; icon: typeof Home; end?: boolean; title?: string; ariaLabel?: string; also?: string[] };

export const LIFE_NAV: NavItem[] = [
  { to: '/', label: 'Início', icon: Home, end: true },
  { to: '/semana', label: 'Semana', icon: CalendarDays },
  { to: '/minha-evolucao', label: 'Evolução', icon: BarChart3, also: ['/jornada', '/evolucao', '/metas', '/desempenho'] },
  { to: '/assistente', label: 'IA', icon: Sparkles, title: 'Assistente IA', ariaLabel: 'Assistente IA' },
  { to: '/mais', label: 'Mais', icon: LayoutGrid, also: ['/missoes', '/biblia', '/alimentacao', '/conhecimento', '/treinar', '/treinos', '/historico', '/planejamento', '/exercicios', '/config', '/conta'] },
];

