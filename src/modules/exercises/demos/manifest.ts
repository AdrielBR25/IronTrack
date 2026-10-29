// Manifesto da cobertura visual (P20, docs/ANIMACOES_EXERCICIOS.md). Diz, para cada exercício do catálogo, o que a tela
// mostra — sem inventar cobertura:
//  - 'animado':  humanoide 3D executando o movimento real do exercício (./animations.ts, kind 'animated');
//  - 'posicao':  humanoide 3D na posição sustentada do exercício isométrico (kind 'static');
//  - 'anatomia': humanoide 3D em postura neutra só com os músculos destacados, mais as instruções em texto. Não há
//                movimento para esses exercícios; a tela diz isso com todas as letras.
// Exercícios personalizados (`cx_…`) sempre ficam em 'anatomia' (não sabemos como a pessoa executa).
// Todo o desenho é gerado no aparelho a partir deste código (modelo próprio `irontrack-humanoid-v1`): sem arquivos de
// modelo, imagens ou vídeos de terceiros, sem rede. Funciona offline.
import { DEMOS, type Demo } from './animations';

export const HUMANOID_MODEL = 'irontrack-humanoid-v1';

export type VisualStatus = 'animado' | 'posicao' | 'anatomia';

export const VISUAL_STATUS_LABEL: Record<VisualStatus, string> = {
  animado: 'Demonstração 3D',
  posicao: 'Posição 3D',
  anatomia: 'Mapa muscular 3D',
};

export interface VisualEntry {
  status: VisualStatus;
  model: typeof HUMANOID_MODEL;
  /** Animação usada (null em 'anatomia'). */
  demoId: string | null;
  demoVersion: number | null;
  /** Como o movimento foi conferido. */
  validation: 'geometria+inspecao' | null;
  offline: true;
}

const byCatalog = new Map<string, Demo>();
for (const d of DEMOS) for (const id of d.catalogIds) byCatalog.set(id, d);

/** Demonstração de um exercício do catálogo (null = sem movimento: só mapa muscular e instruções). */
export const demoForCatalog = (catalogId: string | null | undefined): Demo | null => (catalogId ? byCatalog.get(catalogId) ?? null : null);

export function visualFor(catalogId: string | null | undefined): VisualEntry {
  const d = demoForCatalog(catalogId);
  if (!d) return { status: 'anatomia', model: HUMANOID_MODEL, demoId: null, demoVersion: null, validation: null, offline: true };
  return { status: d.kind === 'animated' ? 'animado' : 'posicao', model: HUMANOID_MODEL, demoId: d.id, demoVersion: d.version, validation: 'geometria+inspecao', offline: true };
}

/** Contagem da cobertura para um conjunto de IDs do catálogo (relatório e documentação). */
export function coverage(catalogIds: readonly string[]): Record<VisualStatus, number> {
  const out: Record<VisualStatus, number> = { animado: 0, posicao: 0, anatomia: 0 };
  for (const id of catalogIds) out[visualFor(id).status]++;
  return out;
}
