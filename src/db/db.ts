import Dexie, { type Table, type Transaction } from 'dexie';
import { OWNED_COLLECTIONS, type BodyEntry, type CalendarDecision, type CustomExercise, type DayOverride, type ExerciseFavorite, type LocalProfile, type PlanEntry, type ProgressPhoto, type Routine, type RotationState, type Settings, type TrainingGoal, type WorkoutSession } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/defaults';
import { ProfileError, generateProfileId, isValidProfileId, newDefaultProfile, pickDefaultProfile } from '@/lib/profile';
import { installModelSnapshotHooks } from './modelGuard';

/**
 * Versão atual do esquema IndexedDB (Dexie). É independente da versão do formato
 * JSON de backup (BACKUP_SCHEMA_VERSION). Histórico e regras em docs/MIGRACOES.md.
 */
export const DB_SCHEMA_VERSION = 6;

/** Tabelas com dono na época da migração v1 → v2 (congelada: a v2 não tem a tabela de metas). */
export const V2_OWNED_TABLES = ['routines', 'sessions', 'bodyEntries', 'photos'] as const;

export class IronTrackDB extends Dexie {
  settings!: Table<Settings, string>;
  routines!: Table<Routine, string>;
  sessions!: Table<WorkoutSession, string>;
  rotations!: Table<RotationState, string>;
  overrides!: Table<DayOverride, [string, string]>;
  bodyEntries!: Table<BodyEntry, string>;
  photos!: Table<ProgressPhoto, string>;
  profiles!: Table<LocalProfile, string>;
  goals!: Table<TrainingGoal, string>;
  planEntries!: Table<PlanEntry, string>;
  calendarDecisions!: Table<CalendarDecision, string>;
  customExercises!: Table<CustomExercise, string>;
  exerciseFavorites!: Table<ExerciseFavorite, string>;

  /** ID do perfil principal, carregado ao abrir o banco (antes de qualquer outra operação). */
  currentProfileId: string | null = null;
  /** Gerador do ID do perfil (substituível nos testes para simular falhas). */
  protected newProfileId: () => string = () => generateProfileId();

  constructor(name = 'irontrack') {
    super(name);
    // Versões do esquema IndexedDB. Ao mudar a estrutura, adicione uma nova
    // versão com .upgrade() em vez de alterar as anteriores.
    // As declarações publicadas são congeladas (ver tests/unit/migrations.test.ts).
    this.version(1).stores({
      settings: 'id',
      routines: 'id, updatedAt',
      sessions: 'id, status, startedAt, workoutId, routineId',
      rotations: 'routineId',
      overrides: '[routineId+date], routineId, date',
      bodyEntries: 'id, date',
      photos: 'id, entryId',
    });
    // v2 (IronTrack 2.0 F01/P02): perfil local e proprietário explícito dos registros.
    // Esquema completo da versão; detalhes em docs/PERFIL_LOCAL.md e docs/MIGRACOES.md.
    this.version(2)
      .stores({
        settings: 'id',
        profiles: 'id',
        routines: 'id, updatedAt, profileId',
        sessions: 'id, status, startedAt, workoutId, routineId, profileId',
        rotations: 'routineId',
        overrides: '[routineId+date], routineId, date',
        bodyEntries: 'id, date, profileId',
        photos: 'id, entryId, profileId',
      })
      .upgrade(
        migration(2, 'perfil local principal e proprietário dos registros', async (tx) => {
          // Banco legado: cria exatamente um perfil principal e atribui a ele todos os
          // registros existentes, sem mudar IDs nem apagar nada. Tudo na transação de upgrade.
          const profiles = tx.table<LocalProfile, string>('profiles');
          let def = pickDefaultProfile(await profiles.toArray());
          if (!def) {
            def = newDefaultProfile(this.newProfileId(), Date.now());
            await profiles.add(def);
          }
          for (const t of V2_OWNED_TABLES) await adoptUnowned(tx.table(t), def.id);
        }),
      );
    // v3 (IronTrack 2.0 F01/P12): tabela de metas de treinamento. Só acrescenta uma tabela vazia: nenhuma outra
    // tabela, índice ou registro muda, então não há função de transformação. Detalhes em docs/METAS_TREINAMENTO.md §3.
    this.version(3).stores({ goals: 'id, profileId, status, updatedAt' });
    // v4 (IronTrack 2.0 F01/P13): tabela do planejamento semanal (modelo recorrente e exceções de data). Também só
    // acrescenta uma tabela vazia, sem transformação. Detalhes em docs/PLANEJAMENTO_SEMANAL.md §7.
    this.version(4).stores({ planEntries: 'id, profileId, scope, date, routineId, updatedAt' });
    // v5 (IronTrack 2.0 F01/P16): decisões lembradas sobre divergências do calendário. Só acrescenta uma tabela vazia,
    // sem transformação. Tabela própria (e não um registro em `settings`) porque cada decisão tem dono, identidade,
    // revisão e vai para o backup como as outras coleções. Detalhes em docs/DECISOES_CALENDARIO.md §8.
    this.version(5).stores({ calendarDecisions: 'id, profileId, date, updatedAt' });
    // v6 (IronTrack 2.0 F01/P17): biblioteca de exercícios — personalizados e favoritos. Só acrescenta duas tabelas
    // vazias, sem transformação: fichas, sessões, metas e histórico não são tocados (a origem na biblioteca é um campo
    // opcional dentro da ficha, sem índice). O catálogo padrão é estático no código e não vai para o banco.
    // Detalhes em docs/BIBLIOTECA_EXERCICIOS.md §13.
    this.version(6).stores({ customExercises: 'id, profileId, updatedAt', exerciseFavorites: 'id, profileId, target' });

    // Proprietário dos registros novos e proteção contra troca silenciosa de dono.
    for (const t of [this.routines, this.sessions, this.bodyEntries, this.photos, this.goals, this.planEntries, this.calendarDecisions, this.customExercises, this.exerciseFavorites] as Table<{ profileId?: string }, string>[]) {
      t.hook('creating', (_pk, obj) => {
        if (obj.profileId === undefined || obj.profileId === null) {
          if (!this.currentProfileId) throw new ProfileError('Perfil local não inicializado: o registro não foi gravado.');
          obj.profileId = this.currentProfileId;
        }
      });
      t.hook('updating', (mods, _pk, obj) => {
        if (!Object.prototype.hasOwnProperty.call(mods, 'profileId')) return;
        const prev = obj.profileId;
        const next = (mods as { profileId?: unknown }).profileId;
        if (!prev || next === prev) return;
        // Regravação sem o campo (ex.: objeto antigo em memória): mantém o dono atual.
        if (next === undefined || next === null) return { profileId: prev };
        throw new ProfileError('Um registro não pode mudar de perfil proprietário. Nada foi gravado.');
      });
    }

    // P11: fotografia dos campos de modalidade gravados por este app (detecção de regravação por app antigo).
    // Fica fora do banco e dos backups; ver docs/CRONOMETROS_E_CONCORRENCIA.md §7.
    installModelSnapshotHooks(this.routines);

    // Toda abertura garante o perfil principal antes de liberar o banco para o app.
    this.on(
      'ready',
      async (vip) => {
        const p = await ensureDefaultProfile(vip as IronTrackDB, () => this.newProfileId());
        this.currentProfileId = p.id;
      },
      true,
    );
  }
}

/** Atribui ao perfil os registros sem proprietário (legados). Nunca altera um dono existente. */
async function adoptUnowned(table: Table, profileId: string): Promise<number> {
  return table
    .toCollection()
    .modify((r: { profileId?: string }) => {
      if (r.profileId === undefined || r.profileId === null || r.profileId === '') r.profileId = profileId;
    });
}

/**
 * Garante que existe exatamente um perfil principal e o devolve. Seguro com várias abas:
 * a leitura e a criação ocorrem na mesma transação de escrita, que o IndexedDB serializa,
 * então a segunda aba sempre encontra o perfil criado pela primeira.
 * - Nunca cria um segundo perfil se já existe um principal (com duplicidade, escolhe o mais antigo).
 * - Se há perfis mas nenhum principal, promove o mais antigo (sem mudar seu ID).
 * - Se não há perfil mas os registros têm um único dono, recria o perfil com esse ID.
 * - Registros sem dono (ex.: gravados por uma versão antiga do app ainda aberta em outra aba)
 *   são atribuídos ao perfil principal, como na migração v1 → v2.
 */
export async function ensureDefaultProfile(database: IronTrackDB, newId: () => string = generateProfileId, now = Date.now()): Promise<LocalProfile> {
  const tables = OWNED_COLLECTIONS.map((t) => database.table(t));
  const profile = await database.transaction('rw', [database.profiles, ...tables], async () => {
    const all = await database.profiles.toArray();
    const def = pickDefaultProfile(all);
    if (def) return def;
    const candidates = all.filter((p) => isValidProfileId(p?.id)).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
    if (candidates.length) {
      const promoted = { ...candidates[0], isDefault: true, updatedAt: now };
      await database.profiles.put(promoted);
      return promoted;
    }
    // Nenhum perfil válido. Se os registros apontam para exatamente um dono válido (ex.: o
    // registro do perfil foi perdido), restabelece esse mesmo ID em vez de inventar outro:
    // assim nenhum registro muda de dono. Com vários donos, nada é reatribuído.
    const owners = new Set<string>();
    for (const t of tables) for (const k of await t.orderBy('profileId').uniqueKeys()) owners.add(String(k));
    const validOwners = [...owners].filter(isValidProfileId);
    const id = owners.size === 1 && validOwners.length === 1 ? validOwners[0] : newId();
    if (!isValidProfileId(id)) throw new ProfileError('Falha ao gerar o identificador do perfil local.');
    const created = newDefaultProfile(id, now);
    await database.profiles.add(created);
    return created;
  });
  // Detecção barata (só chaves do índice); a varredura completa só roda se houver registros sem dono.
  const unowned = await database.transaction('r', tables, async () => {
    for (const t of tables) if ((await t.count()) !== (await t.orderBy('profileId').count())) return true;
    return false;
  });
  if (unowned) await database.transaction('rw', tables, async () => Promise.all(tables.map((t) => adoptUnowned(t, profile.id))));
  return profile;
}

export class MigrationError extends Error {
  constructor(
    readonly version: number,
    readonly description: string,
    readonly cause: unknown,
  ) {
    super(`Falha ao atualizar o banco local para a versão ${version} (${description}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'MigrationError';
  }
}

/**
 * Envolve a função de upgrade de uma versão do esquema. Os upgrades do Dexie rodam
 * dentro da transação de mudança de versão: se a função falhar, o IndexedDB desfaz
 * tudo e o banco continua na versão anterior, com os dados intactos.
 * Regras: determinística, sem rede, sem timers, só operações na transação `tx`.
 */
export function migration(version: number, description: string, fn: (tx: Transaction) => Promise<void> | void) {
  return async (tx: Transaction) => {
    try {
      await fn(tx);
    } catch (e) {
      throw new MigrationError(version, description, e);
    }
  };
}

/** Traduz falhas ao abrir o banco em mensagens compreensíveis (sem apagar nada). */
export function describeOpenError(e: unknown): string {
  const err = e as { name?: string; inner?: { name?: string }; message?: string };
  const name = err?.inner?.name ?? err?.name;
  if (err instanceof MigrationError || (err as { inner?: unknown })?.inner instanceof MigrationError)
    return `${(err instanceof MigrationError ? err : (err as { inner: MigrationError }).inner).message}. Seus dados não foram apagados: o banco permaneceu na versão anterior.`;
  if (name === 'VersionError')
    return 'Os dados deste aparelho foram gravados por uma versão mais nova do IronTrack. Atualize o app (recarregue a página) para acessá-los; nada foi apagado.';
  if (err instanceof ProfileError || (err as { inner?: unknown })?.inner instanceof ProfileError)
    return `Não foi possível preparar o perfil local: ${(err instanceof ProfileError ? err : (err as { inner: ProfileError }).inner).message} Nada foi apagado; recarregue a página.`;
  if (name === 'MissingAPIError' || name === 'InvalidStateError')
    return 'Este navegador não permite armazenamento local (IndexedDB), por exemplo em modo privado. Seus dados não podem ser acessados aqui.';
  return `Não foi possível abrir os dados locais (${name ?? 'erro desconhecido'}). Nada foi apagado; feche outras abas do IronTrack e recarregue.`;
}

export let db = new IronTrackDB();

/** Usado nos testes para isolar bancos. */
export function setDb(next: IronTrackDB) {
  db = next;
}

/** Tabelas de dados do app (tudo menos `profiles`): o conteúdo do backup e o que "apagar tudo" limpa. */
export function dataTables() {
  return [db.settings, db.routines, db.sessions, db.rotations, db.overrides, db.bodyEntries, db.photos, db.goals, db.planEntries, db.calendarDecisions, db.customExercises, db.exerciseFavorites];
}

/** Apaga todos os dados do app numa única transação. O perfil local (nome e ID) é mantido. */
export async function clearLocalData(): Promise<void> {
  const tables = dataTables();
  await db.transaction('rw', tables, async () => {
    await Promise.all(tables.map((t) => t.clear()));
  });
}

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get('settings');
  return mergeSettings(s);
}

export function mergeSettings(s: Partial<Settings> | undefined): Settings {
  if (!s) return { ...DEFAULT_SETTINGS };
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    progression: {
      ...DEFAULT_SETTINGS.progression,
      ...(s.progression ?? {}),
      increments: { ...DEFAULT_SETTINGS.progression.increments, ...(s.progression?.increments ?? {}) },
    },
    id: 'settings',
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = mergeSettings({ ...current, ...patch });
  await db.settings.put(next);
  return next;
}

/** Pede ao navegador armazenamento persistente (menos chance de limpeza automática). */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (navigator.storage?.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch {
    /* indisponível */
  }
  return null;
}
