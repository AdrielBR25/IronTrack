// "Mais" (Fase 01): acesso a todos os módulos atuais (treino, histórico, evolução, metas…), conta e ajustes.
import { Link } from 'react-router-dom';
import { Apple, BookHeart, BookOpenText, CalendarCheck, Heart, NotebookPen, Brain, GraduationCap, Library, Timer, BarChart3, CalendarRange, LineChart, Search, BookOpen, CalendarDays, ChevronRight, Dumbbell, Gauge, History, ListChecks, Play, Settings, ShieldCheck, Target, User } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Card } from '@/components/ui/card';

const GROUPS: { title: string; items: { to: string; label: string; hint: string; icon: typeof Dumbbell }[] }[] = [
  {
    title: 'Treino',
    items: [
      { to: '/treinar', label: 'Treinar hoje', hint: 'Próximo treino, calendário e retomada', icon: Play },
      { to: '/treinos', label: 'Fichas de treino', hint: 'Fichas, planejamento e exercícios', icon: Dumbbell },
      { to: '/historico', label: 'Histórico', hint: 'Treinos concluídos', icon: History },
      { to: '/evolucao', label: 'Evolução dos treinos', hint: 'Volume, cargas e medidas', icon: BarChart3 },
      { to: '/desempenho', label: 'Desempenho', hint: 'Recordes e comparações', icon: Gauge },
      { to: '/metas', label: 'Metas de treino', hint: 'Objetivos de carga e frequência', icon: Target },
      { to: '/planejamento', label: 'Planejamento semanal', hint: 'Dias de treino e descanso', icon: CalendarDays },
      { to: '/exercicios', label: 'Biblioteca de exercícios', hint: 'Catálogo e favoritos', icon: BookOpen },
    ],
  },
  {
    title: 'Alimentação',
    items: [
      { to: '/alimentacao', label: 'Diário alimentar', hint: 'Refeições, calorias, macros e água', icon: Apple },
      { to: '/alimentacao/planejar', label: 'Planejamento alimentar', hint: 'Semana planejada × consumido', icon: CalendarRange },
      { to: '/alimentacao/analise', label: 'Histórico e gráficos', hint: 'Médias, proteína e frequência', icon: LineChart },
      { to: '/alimentacao/metas', label: 'Metas nutricionais', hint: 'Calorias, macros, água e horários', icon: Target },
      { to: '/alimentacao/alimentos', label: 'Alimentos', hint: 'Catálogo TACO, rótulos e refeições salvas', icon: Search },
    ],
  },
  {
    title: 'Conhecimento',
    items: [
      { to: '/conhecimento', label: 'Leitura e estudos', hint: 'Hoje, metas, livros e matérias', icon: Brain },
      { to: '/conhecimento/foco', label: 'Modo foco', hint: 'Cronômetro, temporizador e pomodoro', icon: Timer },
      { to: '/conhecimento/biblioteca', label: 'Biblioteca', hint: 'Livros, progresso, notas e resenhas', icon: Library },
      { to: '/conhecimento/estudos', label: 'Matérias', hint: 'Tópicos, tempo e histórico', icon: GraduationCap },
      { to: '/conhecimento/metas', label: 'Metas de leitura e estudo', hint: 'Diárias, semanais e por prazo', icon: Target },
      { to: '/conhecimento/estatisticas', label: 'Gráficos do conhecimento', hint: 'Tempo, páginas e constância', icon: LineChart },
    ],
  },
  {
    title: 'Bíblia',
    items: [
      { to: '/biblia', label: 'Bíblia', hint: 'Passagem do dia, leitura e progresso', icon: BookHeart },
      { to: '/biblia/ler', label: 'Ler Bíblia', hint: 'Continuar de onde parei', icon: BookOpenText },
      { to: '/biblia/planos', label: 'Planos de leitura', hint: 'Evangelhos, Salmos, 30/90 dias, Bíblia completa', icon: CalendarCheck },
      { to: '/biblia/diario', label: 'Diário espiritual', hint: 'Reflexões, gratidão e anotações privadas', icon: NotebookPen },
      { to: '/biblia/favoritos', label: 'Favoritos e destaques', hint: 'Passagens salvas', icon: Heart },
    ],
  },
  {
    title: 'Desenvolvimento pessoal',
    items: [
      { to: '/semana', label: 'Minha Semana', hint: 'Agenda de 7 dias com todas as áreas', icon: CalendarDays },
      { to: '/minha-evolucao', label: 'Minha Evolução', hint: 'Indicadores da semana e do mês', icon: BarChart3 },
      { to: '/missoes', label: 'Missões', hint: 'Diárias, semanais e desafios', icon: ListChecks },
      { to: '/jornada', label: 'Jornada', hint: 'Nível, atributos e conquistas', icon: Target },
      { to: '/missoes?aba=habitos', label: 'Hábitos', hint: 'Criar, pausar e arquivar', icon: ListChecks },
      { to: '/missoes?aba=rotinas', label: 'Rotinas', hint: 'Matinal, estudos, treino, noturna', icon: CalendarDays },
    ],
  },
  {
    title: 'Conta',
    items: [
      { to: '/conta', label: 'Conta e sincronização', hint: 'Dados na nuvem, aparelhos', icon: User },
      { to: '/assistente/privacidade', label: 'Privacidade e diagnóstico da IA', hint: 'Dados enviados, memórias, teste da OpenAI', icon: ShieldCheck },
      { to: '/config', label: 'Configurações', hint: 'Tema, unidades, backup', icon: Settings },
    ],
  },
];

export default function MorePage() {
  return (
    <div className="space-y-5" data-testid="life-more">
      <PageHeader title="Mais" />
      {GROUPS.map((g) => (
        <section key={g.title} className="space-y-2">
          <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{g.title}</h2>
          <Card className="divide-y divide-border/60">
            {g.items.map((i) => (
              <Link key={i.to} to={i.to} className="flex items-center gap-3 px-4 py-3 active:bg-accent">
                <i.icon className="h-5 w-5 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{i.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{i.hint}</span>
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Link>
            ))}
          </Card>
        </section>
      ))}
    </div>
  );
}
