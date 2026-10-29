// Reconhecimento assistido de exercícios antigos (IronTrack 2.0 F01/P18, docs/RECONHECIMENTO_EXERCICIOS.md).
// Exercícios de fichas criados antes da biblioteca não têm origem (`catalogId`/`customExerciseId`). Aqui ficam o
// inventário deles, o motor de sugestões e as funções puras de associar/desassociar. Regras:
//  - nada é associado sozinho: o motor só SUGERE, explicando os motivos e os avisos; a gravação exige confirmação;
//  - sem nome parecido não há sugestão: grupo muscular, equipamento e modalidade só reforçam ou alertam, nunca bastam
//    sozinhos ("trabalha o mesmo músculo" não torna dois exercícios equivalentes);
//  - associar acrescenta SÓ a referência de origem; nome, ID, séries, carga, modalidade, metas e sessões ficam iguais;
//  - a identidade da instância (`id`) nunca muda; sessões antigas nunca ganham origem retroativa.
// Puro e determinístico (sem React, sem Dexie). O catálogo chega por parâmetro (fica fora do pacote principal).
import type { ExerciseTemplate, Routine, TrainingModality } from '@/modules/training';
import { MODALITY_LABEL } from '@/modules/training';
import { CATALOG_ID_RE, isCustomId } from './custom';
import { libraryKeyOf } from './instance';
import { compareItems, foldText } from './search';
import { EQUIPMENT_NAME, FROM_TEMPLATE_EQUIPMENT, MUSCLE_NAME, muscleFromText } from './vocab';
import type { LibraryItem, LibraryKey } from './types';

// ---------- Normalização de nomes ----------

const STOPWORDS = new Set(['a', 'o', 'e', 'de', 'da', 'do', 'das', 'dos', 'com', 'na', 'no', 'nas', 'nos', 'em', 'ao', 'para', 'pra', 'um', 'uma']);

/** Termos significativos de um nome: dobrado (sem acentos), sem palavras de ligação e com plural simples removido. */
export function nameTokens(raw: string): string[] {
  const out: string[] = [];
  for (const w of foldText(raw).split(' ')) {
    if (!w || STOPWORDS.has(w)) continue;
    const t = w.length > 5 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Semelhança de nomes entre 0 e 1: 1 = iguais depois de dobrados; senão o coeficiente de Dice dos termos. */
export function nameSimilarity(a: string, b: string): number {
  const fa = foldText(a);
  const fb = foldText(b);
  if (!fa || !fb) return 0;
  if (fa === fb) return 1;
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return 0;
  const common = ta.filter((t) => tb.includes(t)).length;
  return (2 * common) / (ta.length + tb.length);
}

// ---------- Motor de sugestões ----------

export type MatchTier = 'forte' | 'possivel' | 'nenhuma';

export const MATCH_TIER_LABEL: Record<MatchTier, string> = { forte: 'Correspondência forte', possivel: 'Correspondência possível', nenhuma: 'Sem sugestão confiável' };

/** Limiares explícitos (documentados em docs/RECONHECIMENTO_EXERCICIOS.md §3). */
export const MATCH_THRESHOLDS = { strongName: 0.75, possibleName: 0.5, maxCandidates: 3 } as const;

export interface MatchCandidate {
  item: LibraryItem;
  tier: Exclude<MatchTier, 'nenhuma'>;
  /** Semelhança do nome (0–1) com o nome ou um apelido do item. */
  nameScore: number;
  /** O nome bateu com o nome do item ou com um apelido. */
  via: 'nome' | 'apelido';
  /** Pontos a favor, em frases curtas ("mesmo grupo muscular"). */
  reasons: string[];
  /** Divergências que a pessoa precisa conferir antes de confirmar. */
  warnings: string[];
  /** Frase única com os motivos: "Nome semelhante, mesmo grupo muscular e mesma modalidade." */
  explanation: string;
}

export interface Recognition {
  tier: MatchTier;
  candidates: MatchCandidate[];
}

const joinPt = (parts: string[]) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`);
const sentence = (parts: string[]) => {
  const s = joinPt(parts);
  return s ? `${s[0].toUpperCase()}${s.slice(1)}.` : '';
};

/** Modalidade efetiva da instância: ausente = registro antigo de carga × repetições (o mesmo que resistência). */
export const effectiveModality = (t: Pick<ExerciseTemplate, 'modality'>): TrainingModality => t.modality ?? 'resistance';

/** Tipo de carga conhecido da instância (só o declarado; resistência sem campo = carga externa). */
function knownLoadMode(t: ExerciseTemplate): string | null {
  if (t.loadMode) return t.loadMode;
  const m = effectiveModality(t);
  return m === 'resistance' ? 'externa' : null;
}

const LOAD_LABEL: Record<string, string> = { externa: 'carga externa', corporal: 'peso corporal', adicional: 'peso corporal com carga adicional', assistida: 'peso corporal com assistência' };

/** Compara uma instância antiga com um item da biblioteca (sem decidir nada: só descreve). */
export function compareWithItem(t: ExerciseTemplate, item: LibraryItem): MatchCandidate | null {
  let nameScore = nameSimilarity(t.name, item.name);
  let via: MatchCandidate['via'] = 'nome';
  for (const a of item.aliases) {
    const s = nameSimilarity(t.name, a);
    if (s > nameScore) [nameScore, via] = [s, 'apelido'];
  }
  if (nameScore < MATCH_THRESHOLDS.possibleName) return null;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const exact = nameScore === 1;
  const nameReason = exact ? (via === 'apelido' ? 'nome igual a um apelido do exercício da biblioteca' : 'mesmo nome') : 'nome semelhante';

  const muscle = muscleFromText(t.muscleGroup);
  if (muscle) {
    if (item.primaryMuscles.includes(muscle)) reasons.push('mesmo grupo muscular');
    else if (item.secondaryMuscles.includes(muscle)) warnings.push(`Grupo muscular diferente: na ficha "${t.muscleGroup}" é o principal; na biblioteca ele é secundário (principal: ${item.primaryMuscles.map((m) => MUSCLE_NAME[m]).join(', ')}).`);
    else warnings.push(`Grupo muscular diferente: ficha "${t.muscleGroup}", biblioteca ${item.primaryMuscles.map((m) => MUSCLE_NAME[m]).join(', ')}.`);
  }

  const tm = effectiveModality(t);
  if (tm === item.modality) reasons.push(t.modality ? 'mesma modalidade' : 'modalidade compatível');
  else
    warnings.push(
      `Modalidade diferente: a ficha registra ${t.modality ? MODALITY_LABEL[tm] : 'carga × repetições (modalidade não informada)'}; o exercício da biblioteca é ${MODALITY_LABEL[item.modality]}. Associar não muda a modalidade da ficha.`,
    );

  const tl = knownLoadMode(t);
  if (tm === item.modality && tl && item.loadMode && tl !== item.loadMode)
    warnings.push(`Tipo de carga diferente: ficha com ${LOAD_LABEL[tl] ?? tl}; biblioteca com ${LOAD_LABEL[item.loadMode] ?? item.loadMode}. Associar não muda o registro da ficha.`);

  const te = FROM_TEMPLATE_EQUIPMENT[t.equipment];
  if (te && te !== 'outros') {
    if (item.equipment.includes(te)) reasons.push('mesmo equipamento');
    else warnings.push(`Equipamento diferente: ficha ${EQUIPMENT_NAME[te]}; biblioteca ${item.equipment.map((e) => EQUIPMENT_NAME[e]).join(', ')}.`);
  }

  if (t.laterality && item.modality !== 'cardio' && t.laterality !== item.laterality)
    warnings.push(`Execução diferente: a ficha é ${t.laterality}; o exercício da biblioteca é ${item.laterality}.`);
  else if (t.laterality && t.laterality === item.laterality && t.laterality === 'unilateral') reasons.push('mesma lateralidade');

  const tier: MatchCandidate['tier'] = nameScore >= MATCH_THRESHOLDS.strongName && warnings.length === 0 ? 'forte' : 'possivel';
  return { item, tier, nameScore, via, reasons, warnings, explanation: sentence([nameReason, ...reasons]) };
}

/**
 * Sugestões para uma instância antiga: no máximo 3 candidatos, ordenados por classificação, semelhança do nome,
 * quantidade de motivos, menos avisos e nome. Arquivados nunca são sugeridos. Nunca grava nada.
 */
export function recognize(t: ExerciseTemplate, items: readonly LibraryItem[], limit: number = MATCH_THRESHOLDS.maxCandidates): Recognition {
  const out: MatchCandidate[] = [];
  for (const item of items) {
    if (item.archived) continue;
    const c = compareWithItem(t, item);
    if (c) out.push(c);
  }
  const rank = (c: MatchCandidate) => (c.tier === 'forte' ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || b.nameScore - a.nameScore || b.reasons.length - a.reasons.length || a.warnings.length - b.warnings.length || compareItems(a.item, b.item));
  const candidates = out.slice(0, limit);
  return { tier: candidates[0]?.tier ?? 'nenhuma', candidates };
}

// ---------- Inventário ----------

export interface SheetEntry {
  routineId: string;
  routineName: string;
  workoutId: string;
  workoutLabel: string;
  workoutName: string;
  /** Posição (0…) do exercício no treino. */
  position: number;
  exercise: ExerciseTemplate;
}

export interface LegacyInventory {
  /** Instâncias sem origem, na ordem rotina → treino → posição. */
  unlinked: SheetEntry[];
  /** Instâncias com origem (associadas, ou criadas a partir da biblioteca). */
  linked: SheetEntry[];
  /** Treinos (fichas) com ao menos um exercício sem origem. */
  workoutsAffected: number;
}

/** Percorre as fichas do perfil (rotinas sem dono são do perfil, como no resto do app). Ordem estável. */
export function legacyInventory(routines: readonly Routine[], profileId?: string | null): LegacyInventory {
  const unlinked: SheetEntry[] = [];
  const linked: SheetEntry[] = [];
  const affected = new Set<string>();
  const sorted = [...routines].filter((r) => !profileId || !r.profileId || r.profileId === profileId).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  for (const r of sorted)
    for (const w of r.workouts ?? [])
      (w.exercises ?? []).forEach((exercise, position) => {
        const entry: SheetEntry = { routineId: r.id, routineName: r.name, workoutId: w.id, workoutLabel: w.label, workoutName: w.name, position, exercise };
        if (libraryKeyOf(exercise)) linked.push(entry);
        else {
          unlinked.push(entry);
          affected.add(`${r.id}/${w.id}`);
        }
      });
  return { unlinked, linked, workoutsAffected: affected.size };
}

export interface RecognitionSummary {
  unlinked: number;
  workoutsAffected: number;
  withSuggestions: number;
  manual: number;
  linked: number;
}

export function recognitionSummary(inv: LegacyInventory, recognitions: ReadonlyMap<string, Recognition>): RecognitionSummary {
  let withSuggestions = 0;
  for (const e of inv.unlinked) if ((recognitions.get(e.exercise.id)?.tier ?? 'nenhuma') !== 'nenhuma') withSuggestions++;
  return { unlinked: inv.unlinked.length, workoutsAffected: inv.workoutsAffected, withSuggestions, manual: inv.unlinked.length - withSuggestions, linked: inv.linked.length };
}

// ---------- Associação e desassociação (puras) ----------

/** Referência de origem que a associação acrescenta. */
export type LibraryRef = { catalogId: string; catalogVersion: number } | { customExerciseId: string };

export function refOfItem(item: LibraryItem): LibraryRef {
  return item.kind === 'catalog' ? { catalogId: item.refId, catalogVersion: item.version } : { customExerciseId: item.refId };
}

export const refKey = (r: LibraryRef): LibraryKey => ('catalogId' in r ? `catalog:${r.catalogId}` : `custom:${r.customExerciseId}`);

export function isValidRef(r: unknown): r is LibraryRef {
  if (typeof r !== 'object' || r === null) return false;
  const x = r as Record<string, unknown>;
  if ('catalogId' in x) return typeof x.catalogId === 'string' && CATALOG_ID_RE.test(x.catalogId) && x.catalogId.length <= 100 && Number.isInteger(x.catalogVersion) && (x.catalogVersion as number) >= 1 && !('customExerciseId' in x);
  return isCustomId(x.customExerciseId);
}

/**
 * Impressão digital estável de uma instância (todas as chaves, ordenadas). A tela guarda a da prévia; a gravação
 * compara com a versão gravada e recusa se algo mudou entre a prévia e a confirmação (outra aba, restauração…).
 */
export function instanceFingerprint(t: ExerciseTemplate): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object')
      return Object.keys(v as object)
        .sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, norm((v as Record<string, unknown>)[k])]);
    return v;
  };
  return JSON.stringify(norm(t));
}

/** A instância com a origem acrescentada. Só a referência muda; nada mais é copiado do item da biblioteca. */
export function linkInstance(t: ExerciseTemplate, ref: LibraryRef): ExerciseTemplate {
  const { catalogId: _c, catalogVersion: _v, customExerciseId: _x, ...rest } = t;
  return 'catalogId' in ref ? { ...rest, catalogId: ref.catalogId, catalogVersion: ref.catalogVersion } : { ...rest, customExerciseId: ref.customExerciseId };
}

/** A instância sem a origem (nada mais muda). */
export function unlinkInstance(t: ExerciseTemplate): ExerciseTemplate {
  const { catalogId: _c, catalogVersion: _v, customExerciseId: _x, ...rest } = t;
  return rest;
}

/** A instância já aponta para esta origem? (associar de novo é idempotente). */
export const hasRef = (t: ExerciseTemplate, ref: LibraryRef) => libraryKeyOf(t) === refKey(ref);

/** Comparação lado a lado para a tela de confirmação (só leitura). */
export interface LinkComparison {
  current: { name: string; muscleGroup: string; modality: string; equipment: string; laterality: string | null; config: string; notes: string | null };
  library: { name: string; muscles: string; modality: string; equipment: string; laterality: string; loadMode: string };
  changes: string[];
  unchanged: string[];
}

export const LINK_UNCHANGED = ['Nome atual na ficha', 'ID da instância', 'Séries', 'Repetições', 'Carga', 'Descanso', 'Observações', 'Metas', 'Sessões antigas', 'Histórico', 'Analytics'] as const;

export function linkComparison(t: ExerciseTemplate, item: LibraryItem, config: string): LinkComparison {
  const te = FROM_TEMPLATE_EQUIPMENT[t.equipment];
  return {
    current: {
      name: t.name,
      muscleGroup: t.muscleGroup,
      modality: t.modality ? MODALITY_LABEL[t.modality] : 'Não informada (carga × repetições)',
      equipment: te ? EQUIPMENT_NAME[te] : '—',
      laterality: t.laterality ?? null,
      config,
      notes: t.notes?.trim() || null,
    },
    library: {
      name: item.name,
      muscles: item.primaryMuscles.map((m) => MUSCLE_NAME[m]).join(', '),
      modality: MODALITY_LABEL[item.modality],
      equipment: item.equipment.map((e) => EQUIPMENT_NAME[e]).join(', '),
      laterality: item.modality === 'cardio' ? '—' : item.laterality,
      loadMode: item.loadMode ? (LOAD_LABEL[item.loadMode] ?? item.loadMode) : 'sem carga',
    },
    changes: [`Referência de origem: passa a apontar para "${item.name}" (${item.kind === 'catalog' ? `biblioteca, versão ${item.version}` : 'meu exercício'}).`],
    unchanged: [...LINK_UNCHANGED],
  };
}
