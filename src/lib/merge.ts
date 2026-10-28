import { recordKey, stableStringify } from './integrity';
import type { BodyEntry, CollectionName, DataSnapshot, DayOverride, ProgressPhoto, Routine, RotationState, TrainingGoal, WorkoutSession } from './types';

// Planejamento determinístico da restauração por mesclagem (função pura).
// Política documentada em docs/BACKUP_RESTAURACAO.md:
//
//  mesmo ID + mesmo conteúdo      → duplicata confirmada (não grava)
//  mesmo ID + conteúdo diferente  → conflito: mantém o registro local, não grava o do backup, informa
//  IDs diferentes + conteúdo igual → duplicata confirmada; referências dependentes passam para o ID local
//  IDs diferentes + semelhantes    → registros distintos: grava e avisa ("possível duplicata")
//  registros distintos             → grava
//  metas (P12): mesmas regras por ID; o vínculo com a rotina acompanha a rotina deduplicada
//
// Nada é sobrescrito: a aplicação usa somente inserções.

export type MergeItemKind = 'conflict' | 'skipped' | 'similar' | 'duplicate-content' | 'orphan' | 'kept-local';

export interface MergeItem {
  kind: MergeItemKind;
  code: string;
  collection: CollectionName;
  id: string;
  message: string;
}

export interface CollectionCounts {
  add: number;
  duplicate: number;
  conflict: number;
  skipped: number;
}

export interface MergePlan {
  toAdd: DataSnapshot;
  counts: Record<CollectionName, CollectionCounts>;
  items: MergeItem[];
  totals: CollectionCounts;
  /** Registros do backup que NÃO serão restaurados (conflitos + ignorados). Exige confirmação explícita. */
  notRestored: number;
}

const COLLECTIONS: CollectionName[] = ['settings', 'routines', 'sessions', 'rotations', 'overrides', 'bodyEntries', 'photos', 'goals'];

function omit<T extends object>(o: T, keys: string[]): Partial<T> {
  const out = { ...o } as Record<string, unknown>;
  for (const k of keys) delete out[k];
  return out as Partial<T>;
}

/** Conteúdo para "IDs diferentes, conteúdo igual" (ignora ID e metadados de inserção). */
const contentOf = {
  routines: (r: Routine) => stableStringify(omit(r, ['id', 'createdAt', 'updatedAt'])),
  sessions: (s: WorkoutSession) => stableStringify(omit(s, ['id'])),
  bodyEntries: (e: BodyEntry) => stableStringify(omit(e, ['id', 'createdAt'])),
  photos: (p: ProgressPhoto) => stableStringify({ entryId: p.entryId, dataUrl: p.dataUrl }),
  // Metas: o que a meta mede e quando (sem ID, carimbos de tempo e versão do registro).
  goals: (g: TrainingGoal) => stableStringify(omit(g, ['id', 'createdAt', 'updatedAt', 'revision'])),
};

export function planMerge(local: DataSnapshot, incoming: DataSnapshot): MergePlan {
  const counts = Object.fromEntries(COLLECTIONS.map((c) => [c, { add: 0, duplicate: 0, conflict: 0, skipped: 0 }])) as Record<CollectionName, CollectionCounts>;
  const items: MergeItem[] = [];
  const toAdd: DataSnapshot = { settings: null, routines: [], sessions: [], rotations: [], overrides: [], bodyEntries: [], photos: [], goals: [] };
  const note = (kind: MergeItemKind, code: string, collection: CollectionName, id: string, message: string) => items.push({ kind, code, collection, id, message });

  /**
   * Classifica pela chave primária. Devolve 'new' quando a chave não existe localmente
   * nem já foi processada; contabiliza duplicatas e conflitos de ID.
   */
  function byKey<T>(c: CollectionName, rec: T, localByKey: Map<string, T>, seen: Set<string>): 'new' | 'duplicate' | 'conflict' | 'repeat' {
    const key = recordKey(c, rec);
    if (seen.has(key)) {
      counts[c].duplicate++;
      return 'repeat';
    }
    seen.add(key);
    const l = localByKey.get(key);
    if (!l) return 'new';
    if (stableStringify(l) === stableStringify(rec)) {
      counts[c].duplicate++;
      return 'duplicate';
    }
    counts[c].conflict++;
    note('conflict', 'ID_CONFLICT', c, key, 'Mesmo ID com conteúdo diferente: o registro deste aparelho foi mantido e o do backup não será aplicado.');
    return 'conflict';
  }
  const index = <T>(c: CollectionName, list: T[]) => new Map(list.map((x) => [recordKey(c, x), x]));

  // ---- Rotinas ----
  const routineRemap = new Map<string, string>();
  const conflictedRoutines = new Set<string>();
  {
    const localByKey = index('routines', local.routines);
    const localByContent = new Map(local.routines.map((r) => [contentOf.routines(r), r.id]));
    const localNames = new Set(local.routines.map((r) => r.name));
    const seen = new Set<string>();
    for (const r of incoming.routines) {
      const k = byKey('routines', r, localByKey, seen);
      if (k === 'conflict') conflictedRoutines.add(r.id);
      if (k !== 'new') continue;
      const same = localByContent.get(contentOf.routines(r));
      if (same) {
        routineRemap.set(r.id, same);
        counts.routines.duplicate++;
        note('duplicate-content', 'DUPLICATE_CONTENT', 'routines', r.id, `Rotina idêntica já existe com outro ID (${same}); referências do backup passam a apontar para ela.`);
        continue;
      }
      if (localNames.has(r.name)) note('similar', 'SIMILAR_ROUTINE', 'routines', r.id, 'Já existe uma rotina com o mesmo nome e conteúdo diferente; as duas serão mantidas.');
      toAdd.routines.push(r);
      counts.routines.add++;
    }
  }
  const mapRoutine = (id: string) => routineRemap.get(id) ?? id;

  // ---- Sessões ----
  {
    const remapped = incoming.sessions.map((s) => (routineRemap.has(s.routineId) ? { ...s, routineId: mapRoutine(s.routineId) } : s));
    const localByKey = index('sessions', local.sessions);
    const localByContent = new Set(local.sessions.map(contentOf.sessions));
    const fingerprint = (s: WorkoutSession) => `${s.startedAt}|${s.workoutName}`;
    const localFp = new Set(local.sessions.map(fingerprint));
    let hasActive = local.sessions.some((s) => s.status === 'active');
    const seen = new Set<string>();
    for (const s of remapped) {
      if (byKey('sessions', s, localByKey, seen) !== 'new') continue;
      const content = contentOf.sessions(s);
      if (localByContent.has(content)) {
        counts.sessions.duplicate++;
        note('duplicate-content', 'DUPLICATE_CONTENT', 'sessions', s.id, 'Treino idêntico já existe com outro ID.');
        continue;
      }
      if (s.status === 'active' && hasActive) {
        counts.sessions.skipped++;
        note('skipped', 'ACTIVE_SESSION_CONFLICT', 'sessions', s.id, 'Já existe um treino em andamento neste aparelho; o treino em andamento do backup não será aplicado (use "Substituir" para restaurá-lo).');
        continue;
      }
      if (localFp.has(fingerprint(s)))
        note('similar', 'SIMILAR_SESSION', 'sessions', s.id, 'Treino com o mesmo início e nome de outro já registrado, mas com conteúdo diferente; os dois serão mantidos.');
      if (s.status === 'active') hasActive = true;
      localFp.add(fingerprint(s));
      localByContent.add(content);
      toAdd.sessions.push(s);
      counts.sessions.add++;
    }
  }

  // ---- Avaliações corporais ----
  const entryRemap = new Map<string, string>();
  const conflictedEntries = new Set<string>();
  {
    const localByKey = index('bodyEntries', local.bodyEntries);
    const localByContent = new Map(local.bodyEntries.map((e) => [contentOf.bodyEntries(e), e.id]));
    const localDates = new Set(local.bodyEntries.map((e) => e.date));
    const seen = new Set<string>();
    for (const e of incoming.bodyEntries) {
      const k = byKey('bodyEntries', e, localByKey, seen);
      if (k === 'conflict') conflictedEntries.add(e.id);
      if (k !== 'new') continue;
      const same = localByContent.get(contentOf.bodyEntries(e));
      if (same) {
        entryRemap.set(e.id, same);
        counts.bodyEntries.duplicate++;
        note('duplicate-content', 'DUPLICATE_CONTENT', 'bodyEntries', e.id, `Avaliação idêntica já existe com outro ID (${same}); fotos do backup passam a apontar para ela.`);
        continue;
      }
      if (localDates.has(e.date)) note('similar', 'SIMILAR_BODY_ENTRY', 'bodyEntries', e.id, 'Já existe uma avaliação na mesma data com medidas diferentes; as duas serão mantidas.');
      localDates.add(e.date);
      localByContent.set(contentOf.bodyEntries(e), e.id);
      toAdd.bodyEntries.push(e);
      counts.bodyEntries.add++;
    }
  }

  // ---- Fotos ----
  {
    const finalEntries = new Set([...local.bodyEntries.map((e) => e.id), ...toAdd.bodyEntries.map((e) => e.id)]);
    const localByKey = index('photos', local.photos);
    const localByContent = new Set(local.photos.map(contentOf.photos));
    const seen = new Set<string>();
    for (const p0 of incoming.photos) {
      if (conflictedEntries.has(p0.entryId)) {
        if (!seen.has(p0.id)) {
          seen.add(p0.id);
          if (localByKey.has(p0.id) && stableStringify(localByKey.get(p0.id)) === stableStringify(p0)) {
            counts.photos.duplicate++;
            continue;
          }
          counts.photos.skipped++;
          note('skipped', 'PHOTO_ENTRY_CONFLICT', 'photos', p0.id, 'A avaliação desta foto está em conflito (mesmo ID com conteúdo diferente); a foto não será aplicada para não ser ligada à avaliação errada.');
        } else counts.photos.duplicate++;
        continue;
      }
      const p = entryRemap.has(p0.entryId) ? { ...p0, entryId: entryRemap.get(p0.entryId)! } : p0;
      if (byKey('photos', p, localByKey, seen) !== 'new') continue;
      const content = contentOf.photos(p);
      if (localByContent.has(content)) {
        counts.photos.duplicate++;
        continue;
      }
      if (!finalEntries.has(p.entryId))
        note('orphan', 'PHOTO_ORPHAN', 'photos', p.id, 'Foto sem avaliação correspondente: será preservada, mas não aparece na tela.');
      localByContent.add(content);
      toAdd.photos.push(p);
      counts.photos.add++;
    }
  }

  // ---- Rotação e substituições de calendário (chaves derivadas da rotina) ----
  const keyed = <T extends RotationState | DayOverride>(c: 'rotations' | 'overrides', list: T[], localList: T[], out: T[]) => {
    const localByKey = index(c, localList);
    const seen = new Set<string>();
    for (const x0 of list) {
      const x = routineRemap.has(x0.routineId) ? { ...x0, routineId: mapRoutine(x0.routineId) } : x0;
      const key = recordKey(c, x);
      if (seen.has(key)) {
        counts[c].duplicate++;
        continue;
      }
      seen.add(key);
      const l = localByKey.get(key);
      if (!l && conflictedRoutines.has(x.routineId)) {
        // O índice/treino do backup se refere à versão da rotina que NÃO foi aplicada.
        counts[c].skipped++;
        note('skipped', 'ROUTINE_CONFLICT_DEPENDENT', c, key, c === 'rotations' ? 'Ponteiro de rotação de uma rotina em conflito: não aplicado, pois se refere à versão do backup.' : 'Substituição de calendário de uma rotina em conflito: não aplicada, pois se refere à versão do backup.');
        continue;
      }
      if (!l) {
        out.push(x);
        counts[c].add++;
        continue;
      }
      // updatedAt muda a cada ajuste e não distingue o estado.
      if (stableStringify(omit(l, ['updatedAt'])) === stableStringify(omit(x, ['updatedAt']))) counts[c].duplicate++;
      else {
        counts[c].conflict++;
        note('kept-local', 'ID_CONFLICT', c, key, c === 'rotations' ? 'O próximo treino da rotação deste aparelho foi mantido.' : 'A substituição de calendário deste aparelho para esse dia foi mantida.');
      }
    }
  };
  keyed('rotations', incoming.rotations, local.rotations, toAdd.rotations);
  keyed('overrides', incoming.overrides, local.overrides, toAdd.overrides);

  // ---- Metas (P12) ----
  {
    const remapped = incoming.goals.map((g) =>
      g.exercise && routineRemap.has(g.exercise.routineId) ? { ...g, exercise: { ...g.exercise, routineId: mapRoutine(g.exercise.routineId) } } : g,
    );
    const localByKey = index('goals', local.goals);
    const localByContent = new Set(local.goals.map(contentOf.goals));
    const localTitles = new Set(local.goals.map((g) => `${g.type}|${g.title}`));
    const seen = new Set<string>();
    for (const g of remapped) {
      if (byKey('goals', g, localByKey, seen) !== 'new') continue;
      const content = contentOf.goals(g);
      if (localByContent.has(content)) {
        counts.goals.duplicate++;
        note('duplicate-content', 'DUPLICATE_CONTENT', 'goals', g.id, 'Meta idêntica já existe com outro ID.');
        continue;
      }
      if (localTitles.has(`${g.type}|${g.title}`)) note('similar', 'SIMILAR_GOAL', 'goals', g.id, 'Já existe uma meta do mesmo tipo com o mesmo título e valores diferentes; as duas serão mantidas.');
      localByContent.add(content);
      toAdd.goals.push(g);
      counts.goals.add++;
    }
  }

  // ---- Configurações: nunca mescladas campo a campo ----
  if (incoming.settings) {
    if (!local.settings) {
      toAdd.settings = incoming.settings;
      counts.settings.add++;
    } else if (stableStringify(local.settings) === stableStringify(incoming.settings)) counts.settings.duplicate++;
    else {
      counts.settings.skipped++;
      note('kept-local', 'SETTINGS_KEPT', 'settings', 'settings', 'As configurações deste aparelho foram mantidas (as do backup só são aplicadas em "Substituir").');
    }
  }

  const totals = { add: 0, duplicate: 0, conflict: 0, skipped: 0 };
  for (const c of COLLECTIONS) for (const k of Object.keys(totals) as (keyof CollectionCounts)[]) totals[k] += counts[c][k];
  return { toAdd, counts, items, totals, notRestored: totals.conflict + totals.skipped };
}

/** Junta os dados locais com o que o plano vai inserir (para verificar a integridade do resultado). */
export function applyPlan(local: DataSnapshot, plan: MergePlan): DataSnapshot {
  const a = plan.toAdd;
  return {
    settings: local.settings ?? a.settings,
    routines: [...local.routines, ...a.routines],
    sessions: [...local.sessions, ...a.sessions],
    rotations: [...local.rotations, ...a.rotations],
    overrides: [...local.overrides, ...a.overrides],
    bodyEntries: [...local.bodyEntries, ...a.bodyEntries],
    photos: [...local.photos, ...a.photos],
    goals: [...local.goals, ...a.goals],
  };
}
