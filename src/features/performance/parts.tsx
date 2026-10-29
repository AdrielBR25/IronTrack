import { Segmented } from '@/components/ui/segmented';
import { Badge } from '@/components/ui/badge';
import { MODALITY_LABEL } from '@/modules/training';
import { E1RM_METHOD } from '@/modules/analytics';
import { PERF_PERIOD_KEYS, PERF_PERIOD_LABEL, isPerfPeriodKey, type IdentityHistory, type MeasureFamily, type PerfPeriodKey, type TrackedStatus } from '@/modules/performance';

// Peças compartilhadas das telas de desempenho (P19).

/** Método de 1RM dos painéis: o contrato canônico do P09, sem fórmula nova. */
export const E1RM_NOTE = `1RM estimado pelo método ${E1RM_METHOD.name} (${E1RM_METHOD.id}): ${E1RM_METHOD.formula}; acima de ${E1RM_METHOD.maxReps} repetições não há estimativa. É uma estimativa, não um teste real (exceto quando a série teve 1 repetição).`;

export const DEFAULT_PERIOD: PerfPeriodKey = '90d';

/** Período lido da URL (`?periodo=`), sem armazenamento local. */
export const periodFrom = (params: URLSearchParams): PerfPeriodKey => {
  const p = params.get('periodo');
  return isPerfPeriodKey(p) ? p : DEFAULT_PERIOD;
};

export function PeriodPicker({ value, onChange }: { value: PerfPeriodKey; onChange: (p: PerfPeriodKey) => void }) {
  return (
    <Segmented
      aria-label="Período"
      size="sm"
      value={value}
      onChange={onChange}
      options={PERF_PERIOD_KEYS.map((k) => ({
        value: k,
        label: (
          <>
            <span aria-hidden>{PERF_PERIOD_LABEL[k].short}</span>
            <span className="sr-only">{PERF_PERIOD_LABEL[k].long}</span>
          </>
        ),
      }))}
    />
  );
}

export const FAMILY_LABEL: Record<MeasureFamily, string> = {
  carga: MODALITY_LABEL.resistance,
  corporal: MODALITY_LABEL.bodyweight,
  tempo: MODALITY_LABEL.timed,
  cardio: MODALITY_LABEL.cardio,
};

export const STATUS_LABEL: Record<TrackedStatus, string> = {
  evolucao: 'Evolução registrada',
  estavel: 'Desempenho estável',
  variacao: 'Com variação',
  sem_comparacao: 'Sem comparação suficiente',
  acompanhando: 'Acompanhando',
};

export function StatusBadge({ status }: { status: TrackedStatus }) {
  return (
    <Badge variant={status === 'evolucao' ? 'default' : 'outline'} data-testid="perf-status">
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** Origem como registrada nas sessões (nunca deduzida pelo nome). */
export function originLabel(h: Pick<IdentityHistory, 'identity' | 'observations' | 'historicReason'>): string {
  if (h.identity.kind === 'catalogo') return 'Catálogo do IronTrack';
  if (h.identity.kind === 'personalizado') return 'Meu exercício';
  const last = h.observations[h.observations.length - 1];
  if (last?.catalogId) return 'Catálogo do IronTrack (registrado na sessão)';
  if (last?.customExerciseId) return 'Meu exercício (registrado na sessão)';
  return 'Sem origem registrada';
}

/** Descrição do nível de agrupamento analisado. */
export function levelText(h: Pick<IdentityHistory, 'identity' | 'historicReason' | 'workoutLabel' | 'workoutName'>): string {
  const where = h.workoutLabel ? `Treino ${h.workoutLabel}${h.workoutName ? ` · ${h.workoutName}` : ''}` : 'treino da sessão';
  switch (h.identity.kind) {
    case 'instancia':
      return `Instância da ficha (${where}): só as sessões em que este exercício da ficha foi executado sem troca.`;
    case 'catalogo':
    case 'personalizado':
      return 'Visão agregada de instâncias vinculadas a este exercício. Só entram sessões que registraram esta origem no momento do treino.';
    case 'historico':
      if (h.historicReason === 'isolado') return 'Registro isolado: a sessão não tem dados suficientes para ligá-lo a outras com segurança.';
      return `Histórico sem vínculo (${where}): ${h.historicReason === 'substituido' ? 'exercício trocado durante o treino; ' : ''}agrupado só com o mesmo nome e equipamento no mesmo treino da mesma rotina. Nenhuma origem é atribuída.`;
  }
}
