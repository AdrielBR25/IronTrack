// Explicações dos indicadores e disponibilidade de análises por exercício (IronTrack 2.0 F01/P09).
// Textos fixos em pt-BR, derivados das mesmas constantes usadas nos cálculos: se um limiar mudar, a explicação
// muda junto. Nada aqui calcula números novos.
import { E1RM_METHOD } from '../domain/oneRepMax';
import { supportsLoadMetrics } from '../domain/classification';
import { MIN_PRIOR_SESSIONS_FOR_RECORD, REGULARITY_MIN_WEEKS } from '../domain/metrics';
import { TREND_LONG_GAP_DAYS, TREND_MIN_POINTS, TREND_MIN_SPAN_DAYS } from '../domain/trends';
import type { ExerciseSummary } from '../domain/types';

export interface IndicatorGuide {
  id: 'sessoes' | 'frequencia' | 'volume' | 'series' | 'grupos' | 'e1rm' | 'tendencia' | 'recordes' | 'regularidade';
  title: string;
  /** O que o indicador mede. */
  measures: string;
  /** Como é calculado. */
  calculation: string;
  /** Quando pode ser comparado. */
  comparable: string;
  /** Limitações. */
  limitations: string;
}

export const INDICATOR_GUIDE: readonly IndicatorGuide[] = [
  {
    id: 'sessoes',
    title: 'Sessões',
    measures: 'Quantos treinos foram concluídos no período.',
    calculation: 'Conta só treinos finalizados; treinos em andamento ou descartados ficam de fora.',
    comparable: 'Com o período anterior de mesma duração, quando o histórico cobre esse período inteiro.',
    limitations: 'Não diz nada sobre a duração ou a intensidade de cada treino.',
  },
  {
    id: 'frequencia',
    title: 'Por semana',
    measures: 'Média de treinos por semana no trecho do período coberto pelo histórico.',
    calculation: 'Sessões ÷ (dias cobertos ÷ 7). Não é calculada com menos de 7 dias de histórico.',
    comparable: 'Entre períodos com pelo menos algumas semanas de histórico.',
    limitations: 'Uma semana de folga pesa na média como zero treinos.',
  },
  {
    id: 'volume',
    title: 'Volume',
    measures: 'Trabalho com carga externa registrada.',
    calculation: 'Soma de carga × repetições das séries com carga. Peso corporal nunca é convertido em quilos.',
    comparable: 'Entre períodos com exercícios parecidos; trocar exercícios muda o volume.',
    limitations: 'Exercícios de peso corporal, por tempo ou cardio não entram (exceto a carga adicional registrada).',
  },
  {
    id: 'series',
    title: 'Séries',
    measures: 'Séries de trabalho concluídas.',
    calculation: 'Séries marcadas como feitas, sem aquecimento, com repetições válidas. Drop-sets contam como séries.',
    comparable: 'Entre períodos de mesma duração.',
    limitations: 'Uma série de exercício unilateral conta uma vez; o app não registra o lado.',
  },
  {
    id: 'grupos',
    title: 'Séries por grupo muscular',
    measures: 'Como as séries se distribuem entre os grupos informados na ficha.',
    calculation:
      'O texto do grupo é normalizado (maiúsculas, acentos, espaços e sinônimos, como Peito → Peitoral). Cada série conta uma vez, no grupo principal do exercício.',
    comparable: 'Só entre grupos reconhecidos. Textos desconhecidos ou que citam vários grupos aparecem à parte.',
    limitations: 'A ficha tem um grupo por exercício: músculos auxiliares não recebem séries. A ficha original não é alterada.',
  },
  {
    id: 'e1rm',
    title: '1RM estimado',
    measures: 'Uma estimativa da carga máxima para uma repetição, para comparar séries com repetições diferentes.',
    calculation: `Método ${E1RM_METHOD.name}: ${E1RM_METHOD.formula}. Acima de ${E1RM_METHOD.maxReps} repetições não há estimativa.`,
    comparable: 'Só entre estimativas do mesmo método e do mesmo exercício.',
    limitations:
      'É uma estimativa, não um teste. O gráfico antigo da aba Treino usa outra variante (com 1 repetição mostra cerca de 3% a mais e estima também acima de 12 repetições).',
  },
  {
    id: 'tendencia',
    title: 'Tendência',
    measures: 'Se a métrica do exercício subiu, ficou estável ou ficou abaixo entre a primeira e a segunda metade das sessões do período.',
    calculation: `Compara as médias das duas metades. A variação precisa superar um limiar mínimo e o ruído natural das próprias sessões. Exige ${TREND_MIN_POINTS} sessões em pelo menos ${TREND_MIN_SPAN_DAYS} dias.`,
    comparable: 'Só dentro da mesma métrica: 1RM com 1RM, repetições com repetições. Duração e carga nunca se misturam.',
    limitations: `Dias sem o exercício não contam como queda; pausas acima de ${TREND_LONG_GAP_DAYS} dias são sinalizadas. Não é teste estatístico nem diagnóstico.`,
  },
  {
    id: 'recordes',
    title: 'Recordes',
    measures: 'A melhor marca de todo o histórico do exercício.',
    calculation: `Um novo recorde de carga só é declarado quando supera a melhor marca de pelo menos ${MIN_PRIOR_SESSIONS_FOR_RECORD} sessões anteriores com carga. Empates não renovam.`,
    comparable: 'Com o próprio histórico do exercício.',
    limitations: 'Renomear um exercício mantém o histórico; trocar de exercício começa outro.',
  },
  {
    id: 'regularidade',
    title: 'Regularidade',
    measures: 'O quanto o número de treinos por semana oscila.',
    calculation: `Coeficiente de variação das sessões por semana nas semanas completas. Exige ${REGULARITY_MIN_WEEKS} semanas completas.`,
    comparable: 'Entre períodos com várias semanas completas.',
    limitations: 'Não considera o planejamento: uma semana de descanso planejada conta como variação.',
  },
];

export const UNAVAILABLE_ANALYSIS_TEXT = 'Este exercício ainda não possui dados suficientes para esse tipo de análise.';

export type AnalysisKind = 'carga' | 'repeticoes' | 'carga_adicional' | 'duracao' | 'cardio' | 'lados';

export interface AnalysisAvailability {
  kind: AnalysisKind;
  title: string;
  available: boolean;
  /** Por que não está disponível (quando não está). */
  reason?: string;
}

/** Quais análises os registros do exercício sustentam. Só as disponíveis viram gráfico ou número na tela. */
export function exerciseAnalyses(ex: Pick<ExerciseSummary, 'classification'>): AnalysisAvailability[] {
  const c = ex.classification;
  const bodyweight = c.modalities.includes('bodyweight');
  const out: AnalysisAvailability[] = [];
  out.push(
    supportsLoadMetrics(c)
      ? { kind: 'carga', title: 'Carga, 1RM estimado e volume', available: true }
      : {
          kind: 'carga',
          title: 'Carga, 1RM estimado e volume',
          available: false,
          reason: bodyweight
            ? 'Em peso corporal, a carga registrada é só a adicional; o app não soma o peso do corpo nem estima 1RM.'
            : 'Nenhuma série com carga registrada.',
        },
  );
  out.push({ kind: 'repeticoes', title: 'Repetições', available: c.measures.reps, ...(c.measures.reps ? {} : { reason: 'Nenhuma série com repetições válidas.' }) });
  if (bodyweight)
    out.push(
      c.load === 'corporal_com_adicional'
        ? { kind: 'carga_adicional', title: 'Carga adicional', available: true }
        : { kind: 'carga_adicional', title: 'Carga adicional', available: false, reason: 'Nenhuma série com carga adicional registrada.' },
    );
  out.push(
    c.measures.duration
      ? { kind: 'duracao', title: 'Duração', available: true }
      : { kind: 'duracao', title: 'Duração', available: false, reason: 'O app ainda não registra a duração de cada série. Repetições não são convertidas em segundos.' },
  );
  out.push(
    c.measures.distance
      ? { kind: 'cardio', title: 'Distância e ritmo', available: true }
      : { kind: 'cardio', title: 'Distância e ritmo', available: false, reason: 'O app ainda não registra distância nem duração por exercício.' },
  );
  out.push(
    c.measures.side
      ? { kind: 'lados', title: 'Comparação entre lados', available: true }
      : { kind: 'lados', title: 'Comparação entre lados', available: false, reason: 'O app ainda não registra o lado (direito ou esquerdo) de cada série.' },
  );
  return out;
}

export const LOAD_KIND_LABEL: Record<ExerciseSummary['classification']['load'], string> = {
  externa: 'Carga externa',
  corporal: 'Peso corporal',
  corporal_com_adicional: 'Peso corporal com carga adicional',
  corporal_assistida: 'Peso corporal com assistência',
  desconhecida: 'Tipo não identificado',
};
