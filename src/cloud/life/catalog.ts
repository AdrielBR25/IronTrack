// Fase 08: catálogo único das funções do modo conta. Uma fonte para o menu Mais (categorias e busca), as ações rápidas
// do Início e o painel "Registrar". Cada função aparece em UMA categoria (sem caminhos duplicados); a busca encontra
// todas, inclusive as que só existem dentro dos módulos (ex.: busca na Bíblia).
import {
  Apple,
  BarChart3,
  BookHeart,
  BookOpen,
  BookOpenText,
  Brain,
  CalendarCheck,
  CalendarDays,
  CalendarPlus,
  CalendarRange,
  Camera,
  Dumbbell,
  Gauge,
  GraduationCap,
  Heart,
  History,
  Library,
  LineChart,
  ListChecks,
  NotebookPen,
  Play,
  Repeat,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Swords,
  Target,
  Timer,
  User,
  type LucideIcon,
} from 'lucide-react';

export interface Feature {
  id: string;
  to: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** Palavras extras para a busca (sinônimos, nomes antigos). */
  keywords?: string;
}

export interface Category {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** Cor do ícone (o verde-limão fica reservado para ações e seleção). */
  tone: string;
  items: Feature[];
}

export const CATEGORIES: Category[] = [
  {
    id: 'treinos',
    label: 'Treinos',
    hint: 'Treinar, fichas, histórico e exercícios',
    icon: Dumbbell,
    tone: 'bg-rose-500/15 text-rose-500 dark:text-rose-400',
    items: [
      {
        id: 'treinar',
        to: '/treinar',
        label: 'Treinar hoje',
        hint: 'Próximo treino e retomada',
        icon: Play,
        keywords: 'iniciar treino academia continuar',
      },
      {
        id: 'fichas',
        to: '/treinos',
        label: 'Fichas de treino',
        hint: 'Criar e editar fichas',
        icon: Dumbbell,
        keywords: 'rotina abcd divisão',
      },
      {
        id: 'historico',
        to: '/historico',
        label: 'Histórico de treinos',
        hint: 'Treinos concluídos',
        icon: History,
        keywords: 'sessões passadas',
      },
      {
        id: 'exercicios',
        to: '/exercicios',
        label: 'Exercícios',
        hint: 'Catálogo e favoritos',
        icon: BookOpen,
        keywords: 'biblioteca movimentos',
      },
      {
        id: 'metas-treino',
        to: '/metas',
        label: 'Metas de treino',
        hint: 'Carga e frequência',
        icon: Target,
        keywords: 'objetivos',
      },
      {
        id: 'planejamento-treino',
        to: '/planejamento',
        label: 'Dias de treino',
        hint: 'Treino e descanso por dia',
        icon: CalendarDays,
        keywords: 'planejamento semanal',
      },
    ],
  },
  {
    id: 'alimentacao',
    label: 'Alimentação',
    hint: 'Diário, planejamento e alimentos',
    icon: Apple,
    tone: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    items: [
      {
        id: 'diario',
        to: '/alimentacao',
        label: 'Diário alimentar',
        hint: 'Refeições, calorias e água',
        icon: Apple,
        keywords: 'comida macros kcal proteína',
      },
      {
        id: 'refeicao-foto',
        to: '/alimentacao?foto=1',
        label: 'Foto do prato',
        hint: 'Estimar a refeição pela foto',
        icon: Camera,
        keywords: 'câmera camera imagem',
      },
      {
        id: 'plano-alimentar',
        to: '/alimentacao/planejar',
        label: 'Planejamento alimentar',
        hint: 'Semana planejada',
        icon: CalendarRange,
        keywords: 'dieta cardápio',
      },
      {
        id: 'alimentos',
        to: '/alimentacao/alimentos',
        label: 'Alimentos',
        hint: 'Catálogo e refeições salvas',
        icon: Search,
        keywords: 'taco rótulo',
      },
      {
        id: 'metas-nutri',
        to: '/alimentacao/metas',
        label: 'Metas nutricionais',
        hint: 'Calorias, macros e água',
        icon: Target,
        keywords: 'objetivos',
      },
      {
        id: 'graficos-nutri',
        to: '/alimentacao/analise',
        label: 'Gráficos',
        hint: 'Médias e frequência',
        icon: LineChart,
        keywords: 'análise histórico',
      },
    ],
  },
  {
    id: 'habitos',
    label: 'Hábitos e missões',
    hint: 'Missões, hábitos, rotinas e personagem',
    icon: ListChecks,
    tone: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
    items: [
      {
        id: 'missoes',
        to: '/missoes',
        label: 'Missões',
        hint: 'O que falta hoje e na semana',
        icon: ListChecks,
        keywords: 'tarefas desafios',
      },
      {
        id: 'habitos',
        to: '/missoes?aba=habitos',
        label: 'Hábitos',
        hint: 'Criar, pausar e arquivar',
        icon: Repeat,
      },
      {
        id: 'rotinas',
        to: '/missoes?aba=rotinas',
        label: 'Rotinas',
        hint: 'Matinal, estudos, noturna',
        icon: CalendarCheck,
      },
      {
        id: 'personagem',
        to: '/jornada',
        label: 'Personagem',
        hint: 'Nível, atributos e conquistas',
        icon: Swords,
        keywords: 'rpg xp jornada conquistas título',
      },
    ],
  },
  {
    id: 'estudos',
    label: 'Estudos e leitura',
    hint: 'Foco, livros, matérias e metas',
    icon: Brain,
    tone: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
    items: [
      {
        id: 'foco',
        to: '/conhecimento/foco',
        label: 'Iniciar foco',
        hint: 'Cronômetro e pomodoro',
        icon: Timer,
        keywords: 'pomodoro timer estudar',
      },
      {
        id: 'conhecimento',
        to: '/conhecimento',
        label: 'Resumo de hoje',
        hint: 'Leitura e estudo do dia',
        icon: Brain,
        keywords: 'conhecimento',
      },
      {
        id: 'biblioteca',
        to: '/conhecimento/biblioteca',
        label: 'Livros',
        hint: 'Progresso, notas e resenhas',
        icon: Library,
        keywords: 'biblioteca leitura',
      },
      {
        id: 'materias',
        to: '/conhecimento/estudos',
        label: 'Matérias',
        hint: 'Tópicos e tempo',
        icon: GraduationCap,
        keywords: 'estudos disciplinas',
      },
      {
        id: 'metas-estudo',
        to: '/conhecimento/metas',
        label: 'Metas de estudo',
        hint: 'Diárias, semanais e por prazo',
        icon: Target,
      },
      {
        id: 'graficos-estudo',
        to: '/conhecimento/estatisticas',
        label: 'Gráficos',
        hint: 'Tempo, páginas e constância',
        icon: LineChart,
        keywords: 'estatísticas',
      },
    ],
  },
  {
    id: 'biblia',
    label: 'Bíblia',
    hint: 'Leitura, planos e favoritos',
    icon: BookHeart,
    tone: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
    items: [
      {
        id: 'ler-biblia',
        to: '/biblia/ler',
        label: 'Continuar leitura',
        hint: 'De onde você parou',
        icon: BookOpenText,
        keywords: 'ler bíblia capítulo',
      },
      {
        id: 'biblia',
        to: '/biblia',
        label: 'Passagem do dia',
        hint: 'Versículo, plano e progresso',
        icon: BookHeart,
        keywords: 'versículo',
      },
      {
        id: 'planos-biblia',
        to: '/biblia/planos',
        label: 'Planos de leitura',
        hint: 'Evangelhos, Salmos, Bíblia toda',
        icon: CalendarCheck,
      },
      {
        id: 'favoritos-biblia',
        to: '/biblia/favoritos',
        label: 'Favoritos',
        hint: 'Passagens salvas',
        icon: Heart,
        keywords: 'destaques',
      },
      {
        id: 'diario-biblia',
        to: '/biblia/diario',
        label: 'Reflexões',
        hint: 'Diário espiritual privado',
        icon: NotebookPen,
        keywords: 'diário gratidão oração',
      },
      {
        id: 'buscar-biblia',
        to: '/biblia/buscar',
        label: 'Buscar na Bíblia',
        hint: 'Palavras e passagens',
        icon: Search,
      },
    ],
  },
  {
    id: 'evolucao',
    label: 'Histórico e evolução',
    hint: 'Indicadores, medidas e recordes',
    icon: BarChart3,
    tone: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    items: [
      {
        id: 'minha-evolucao',
        to: '/minha-evolucao',
        label: 'Minha Evolução',
        hint: 'Semana e mês em todas as áreas',
        icon: BarChart3,
        keywords: 'indicadores progresso',
      },
      {
        id: 'semana',
        to: '/semana',
        label: 'Minha Semana',
        hint: 'Agenda de 7 dias',
        icon: CalendarDays,
        keywords: 'agenda planejar calendário',
      },
      {
        id: 'evolucao-treino',
        to: '/evolucao',
        label: 'Corpo e cargas',
        hint: 'Volume, cargas e medidas',
        icon: LineChart,
        keywords: 'evolução dos treinos medidas peso',
      },
      {
        id: 'desempenho',
        to: '/desempenho',
        label: 'Recordes',
        hint: 'Desempenho por exercício',
        icon: Gauge,
        keywords: 'desempenho pr 1rm',
      },
    ],
  },
  {
    id: 'conta',
    label: 'Conta e configurações',
    hint: 'Conta, privacidade e ajustes',
    icon: Settings,
    tone: 'bg-secondary text-muted-foreground',
    items: [
      {
        id: 'conta',
        to: '/conta',
        label: 'Conta e sincronização',
        hint: 'Nuvem e aparelhos',
        icon: User,
        keywords: 'senha e-mail sair',
      },
      {
        id: 'config',
        to: '/config',
        label: 'Configurações',
        hint: 'Tema, unidades e backup',
        icon: Settings,
        keywords: 'ajustes tema',
      },
      {
        id: 'privacidade-ia',
        to: '/assistente/privacidade',
        label: 'Privacidade da IA',
        hint: 'Dados enviados e memórias',
        icon: ShieldCheck,
        keywords: 'openai diagnóstico',
      },
    ],
  },
];

export const ALL_FEATURES: (Feature & { category: Category })[] = CATEGORIES.flatMap((c) => c.items.map((i) => ({ ...i, category: c })));

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Busca por nome, descrição, categoria e sinônimos (sem acento, sem diferenciar maiúsculas). */
export function searchFeatures(q: string): (Feature & { category: Category })[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return ALL_FEATURES.filter((f) => {
    const hay = fold(`${f.label} ${f.hint} ${f.category.label} ${f.keywords ?? ''}`);
    return words.every((w) => hay.includes(w));
  });
}

// ------------------------------------------------------------------ uso (destaque das funções frequentes)

const USAGE_KEY = 'irontrack.life.usage.v1';
const DEFAULT_FREQUENT = ['treinar', 'diario', 'missoes', 'foco'];

function readUsage(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(USAGE_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function recordUse(id: string) {
  try {
    const u = readUsage();
    u[id] = (u[id] ?? 0) + 1;
    localStorage.setItem(USAGE_KEY, JSON.stringify(u));
  } catch {
    /* sem armazenamento: só não aprende os favoritos */
  }
}

/** As 4 funções mais abertas neste aparelho (completadas com um padrão útil). */
export function frequentFeatures(n = 4): (Feature & { category: Category })[] {
  const u = readUsage();
  const used = Object.entries(u)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  const ids = [...new Set([...used, ...DEFAULT_FREQUENT])].slice(0, n);
  return ids.map((id) => ALL_FEATURES.find((f) => f.id === id)).filter((f): f is Feature & { category: Category } => !!f);
}

// ------------------------------------------------------------------ ações rápidas do Início

export interface QuickAction {
  id: string;
  label: string;
  icon: LucideIcon;
  to: string;
  tone: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'treinar',
    label: 'Treinar',
    icon: Dumbbell,
    to: '/treinar',
    tone: 'text-rose-500 dark:text-rose-400',
  },
  {
    id: 'refeicao',
    label: 'Registrar refeição',
    icon: Apple,
    to: '/alimentacao?registrar=1',
    tone: 'text-amber-600 dark:text-amber-400',
  },
  {
    id: 'foco',
    label: 'Iniciar foco',
    icon: Timer,
    to: '/conhecimento/foco',
    tone: 'text-sky-600 dark:text-sky-400',
  },
  {
    id: 'missoes',
    label: 'Minhas missões',
    icon: ListChecks,
    to: '/missoes',
    tone: 'text-violet-600 dark:text-violet-400',
  },
  {
    id: 'foto',
    label: 'Foto do prato',
    icon: Camera,
    to: '/alimentacao?foto=1',
    tone: 'text-amber-600 dark:text-amber-400',
  },
  {
    id: 'biblia',
    label: 'Ler a Bíblia',
    icon: BookOpenText,
    to: '/biblia/ler',
    tone: 'text-orange-600 dark:text-orange-400',
  },
  {
    id: 'semana',
    label: 'Minha Semana',
    icon: CalendarDays,
    to: '/semana',
    tone: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    id: 'atividade',
    label: 'Nova atividade',
    icon: CalendarPlus,
    to: '/semana?nova=1',
    tone: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    id: 'habito',
    label: 'Novo hábito',
    icon: Repeat,
    to: '/missoes?aba=habitos&novo=1',
    tone: 'text-violet-600 dark:text-violet-400',
  },
  {
    id: 'evolucao',
    label: 'Minha Evolução',
    icon: BarChart3,
    to: '/minha-evolucao',
    tone: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    id: 'ia',
    label: 'Falar com a IA',
    icon: Sparkles,
    to: '/assistente',
    tone: 'text-primary',
  },
];
export const DEFAULT_QUICK = ['treinar', 'refeicao', 'foco', 'missoes'];
export const QUICK_KEY = 'irontrack.life.quick.v1';

/** Ações rápidas escolhidas (neste aparelho, por conta). Sempre 4, válidas e sem repetição. */
export function readQuick(accountId: string | undefined): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(QUICK_KEY) ?? '{}') as Record<string, unknown>;
    const v = all[accountId ?? '_'];
    if (Array.isArray(v)) {
      const ids = [...new Set(v.filter((x): x is string => typeof x === 'string' && QUICK_ACTIONS.some((a) => a.id === x)))];
      if (ids.length === 4) return ids;
    }
  } catch {
    /* padrão */
  }
  return DEFAULT_QUICK;
}

export function saveQuick(accountId: string | undefined, ids: string[]) {
  try {
    const all = JSON.parse(localStorage.getItem(QUICK_KEY) ?? '{}') as Record<string, unknown>;
    all[accountId ?? '_'] = ids;
    localStorage.setItem(QUICK_KEY, JSON.stringify(all));
  } catch {
    /* sem armazenamento: vale só nesta abertura */
  }
}
