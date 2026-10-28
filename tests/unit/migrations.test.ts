import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { DB_SCHEMA_VERSION, IronTrackDB, MigrationError, db, describeOpenError, migration, setDb } from '@/db/db';
import { completeSession, completedSessions, deleteRoutine, getActiveSession, getRotation, startSession } from '@/db/repo';
import { checkLocalIntegrity, readSnapshot } from '@/lib/backup';
import { isValidProfileId } from '@/lib/profile';
import { completeSet } from '@/lib/session';
import type { DataSnapshot } from '@/lib/types';
import { entry, photo, routine, rotation, session, settings, snapshot } from './fixtures';

// Cópias CONGELADAS das declarações `this.version(N).stores(...)` publicadas.
// Nunca altere: ela representa os bancos que já existem nos aparelhos dos usuários.
const LEGACY_V1_STORES = {
  settings: 'id',
  routines: 'id, updatedAt',
  sessions: 'id, status, startedAt, workoutId, routineId',
  rotations: 'routineId',
  overrides: '[routineId+date], routineId, date',
  bodyEntries: 'id, date',
  photos: 'id, entryId',
};

// v2 (F01/P02): perfil local e proprietário explícito dos registros.
const V2_STORES = {
  settings: 'id',
  profiles: 'id',
  routines: 'id, updatedAt, profileId',
  sessions: 'id, status, startedAt, workoutId, routineId, profileId',
  rotations: 'routineId',
  overrides: '[routineId+date], routineId, date',
  bodyEntries: 'id, date, profileId',
  photos: 'id, entryId, profileId',
};

// v3 (F01/P12): só a tabela de metas (as demais herdam a declaração da v2).
const V3_DECLARATION = { goals: 'id, profileId, status, updatedAt' };
const V3_STORES = { ...V2_STORES, ...V3_DECLARATION };
// v4 (F01/P13): só a tabela do planejamento semanal.
const V4_DECLARATION = { planEntries: 'id, profileId, scope, date, routineId, updatedAt' };
const V4_STORES = { ...V3_STORES, ...V4_DECLARATION };
// v5 (F01/P16): só a tabela das decisões lembradas do calendário.
const V5_DECLARATION = { calendarDecisions: 'id, profileId, date, updatedAt' };
const V5_STORES = { ...V4_STORES, ...V5_DECLARATION };

let n = 0;
const uniqueName = () => `migration-test-${++n}`;

/** Dados representativos de um usuário real (fictícios), incluindo treino em andamento. */
function legacyData(): DataSnapshot {
  const d = snapshot();
  const active = session('ativo', { status: 'active', workoutId: 'r1-B', workoutLabel: 'B', workoutName: 'Treino B', startedAt: 1_700_200_000_000, finishedAt: undefined, durationSec: undefined });
  active.exercises[0].sets.push({ id: 'ativo-s2', type: 'normal', status: 'pending', weight: 60, reps: 8 });
  active.rest = { durationMs: 120_000, endsAt: 1_700_200_120_000, pausedRemainingMs: null, nextLabel: 'Série 2', exerciseId: active.exercises[0].id, setId: 'ativo-s2' };
  d.sessions.push(active);
  // treino histórico de uma rotina já excluída (referência histórica legítima)
  d.sessions.push(session('historico', { routineId: 'rotina-excluida', workoutId: 'rx-A', startedAt: 1_690_000_000_000 }));
  d.bodyEntries.push(entry('b3', { date: '2026-03-10' }));
  d.photos.push(photo('p3', 'b3'), photo('orfa', 'avaliacao-excluida'));
  d.settings = settings({ userName: 'Pessoa Teste', weightUnit: 'lb', theme: 'light', rotationPolicy: 'threshold', rotationThreshold: 60 });
  return d;
}

/** Cria um banco com o esquema legado v1 usando Dexie puro (sem a classe atual). */
async function createLegacyV1(name: string, d: DataSnapshot) {
  const legacy = new Dexie(name);
  legacy.version(1).stores(LEGACY_V1_STORES);
  await legacy.open();
  await legacy.transaction('rw', legacy.tables, async () => {
    if (d.settings) await legacy.table('settings').put(d.settings);
    await legacy.table('routines').bulkPut(d.routines);
    await legacy.table('sessions').bulkPut(d.sessions);
    await legacy.table('rotations').bulkPut(d.rotations);
    await legacy.table('overrides').bulkPut(d.overrides);
    await legacy.table('bodyEntries').bulkPut(d.bodyEntries);
    await legacy.table('photos').bulkPut(d.photos);
  });
  expect(legacy.verno).toBe(1);
  legacy.close();
}

const byId = <T extends { id: string }>(a: T[]) => [...a].sort((x, y) => x.id.localeCompare(y.id));
const strip = <T extends { profileId?: string }>(a: T[]) => byId(a.map(({ profileId: _p, ...r }) => r as unknown as T & { id: string }) as (T & { id: string })[]);

/** Mesmos registros, mesmos IDs e mesmos campos; `profileId` comparado à parte. */
function expectSameData(a: DataSnapshot, b: DataSnapshot) {
  expect(a.settings).toEqual(b.settings);
  expect(strip(a.routines)).toEqual(strip(b.routines));
  expect(strip(a.sessions)).toEqual(strip(b.sessions));
  expect(a.rotations).toEqual(b.rotations);
  expect([...a.overrides].sort((x, y) => x.date.localeCompare(y.date))).toEqual([...b.overrides].sort((x, y) => x.date.localeCompare(y.date)));
  expect(strip(a.bodyEntries)).toEqual(strip(b.bodyEntries));
  expect(strip(a.photos)).toEqual(strip(b.photos));
}

function ownersOf(d: DataSnapshot) {
  return new Set([...d.routines, ...d.sessions, ...d.bodyEntries, ...d.photos].map((r) => r.profileId));
}

/** Versão hipotética 5, só para testar a infraestrutura de upgrade sobre a atual (v4, P13). */
class IronTrackDBv6 extends IronTrackDB {
  constructor(name: string, upgrade: Parameters<typeof migration>[2]) {
    super(name);
    this.version(6)
      .stores({ sessions: 'id, status, startedAt, workoutId, routineId, profileId, finishedAt' })
      .upgrade(migration(6, 'teste: índice finishedAt e campo derivado', upgrade));
  }
}

/** Simula falha na geração do ID do perfil durante o upgrade v1 → v2. */
class FailingIdDB extends IronTrackDB {
  protected newProfileId = (): string => {
    throw new Error('gerador indisponível (simulado)');
  };
}

/** Simula falha no meio da atribuição: rotinas, treinos e avaliações já migrados quando as fotos falham. */
class FailingPhotosDB extends IronTrackDB {
  constructor(name: string) {
    super(name);
    this.photos.hook('updating', () => {
      throw new Error('falha nas fotos (simulada)');
    });
  }
}

async function openRaw(name: string) {
  const raw = new Dexie(name);
  await raw.open();
  return raw;
}

describe('esquema IndexedDB', () => {
  it('versões 1 a 4 permanecem idênticas às publicadas (não alterar retroativamente) e v5 é a atual', async () => {
    expect(DB_SCHEMA_VERSION).toBe(5);
    const cur = new IronTrackDB(uniqueName());
    const versions = (cur as unknown as { _versions: { _cfg: { version: number; storesSource: Record<string, string> } }[] })._versions;
    expect(versions.find((v) => v._cfg.version === 1)?._cfg.storesSource).toEqual(LEGACY_V1_STORES);
    expect(versions.find((v) => v._cfg.version === 2)?._cfg.storesSource).toEqual(V2_STORES);
    expect(versions.find((v) => v._cfg.version === 3)?._cfg.storesSource).toEqual(V3_DECLARATION);
    expect(versions.find((v) => v._cfg.version === 4)?._cfg.storesSource).toEqual(V4_DECLARATION);
    expect(versions.find((v) => v._cfg.version === 5)?._cfg.storesSource).toEqual(V5_DECLARATION);
    await cur.open();
    expect(cur.verno).toBe(DB_SCHEMA_VERSION);
    const schema = Object.fromEntries(cur.tables.map((t) => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map((i) => i.src)].join(', ')]));
    expect(schema).toEqual(V5_STORES);
    cur.close();
  });
});

describe('migração real v1 → v2 (e v3, que só acrescenta a tabela de metas)', () => {
  it('cria exatamente um perfil principal e preserva todos os registros, IDs e relações', async () => {
    const name = uniqueName();
    const d = legacyData();
    await createLegacyV1(name, d);

    setDb(new IronTrackDB(name));
    await db.open();
    expect(db.verno).toBe(DB_SCHEMA_VERSION);
    expect(await db.goals.count()).toBe(0);
    const profiles = await db.profiles.toArray();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ displayName: 'Meu perfil', isDefault: true });
    expect(isValidProfileId(profiles[0].id)).toBe(true);
    expect(db.currentProfileId).toBe(profiles[0].id);

    const after = await readSnapshot();
    expectSameData(after, d);
    // todos os registros com dono explícito passam a pertencer ao perfil principal
    expect(ownersOf(after)).toEqual(new Set([profiles[0].id]));
    // relações intactas
    expect((await db.photos.get('p1'))?.entryId).toBe('b1');
    expect((await db.photos.get('orfa'))?.entryId).toBe('avaliacao-excluida');
    expect((await db.sessions.get('historico'))?.routineId).toBe('rotina-excluida');
    expect((await db.rotations.get('r1'))?.nextIndex).toBe(1);
    expect(await db.overrides.count()).toBe(2);
    // sessão ativa e histórico continuam acessíveis
    expect((await getActiveSession())?.id).toBe('ativo');
    expect((await completedSessions()).map((s) => s.id)).toEqual(['historico', 's1', 's2']);
    // integridade: só os avisos/infos históricos já tolerados pelo Prompt 01
    const report = await checkLocalIntegrity();
    expect(report.ok).toBe(true);
    expect(report.issues.map((i) => i.code).sort()).toEqual(['PHOTO_ORPHAN', 'SESSION_HISTORICAL_REFERENCE']);
  });

  it('fluxos continuam funcionando após a migração: treino em andamento, rotação ABC e reabertura', async () => {
    const name = uniqueName();
    const d = legacyData();
    await createLegacyV1(name, d);
    setDb(new IronTrackDB(name));
    await db.open();
    const profileId = db.currentProfileId;

    const active = await getActiveSession();
    expect(active?.id).toBe('ativo');
    expect(active?.rest?.setId).toBe('ativo-s2');
    // iniciar outro treino devolve o que está em andamento
    expect((await startSession('r1', 'r1-C')).id).toBe('ativo');
    const done = await completeSession(completeSet(active!, active!.exercises[0].id, 'ativo-s2'), undefined, 1_700_200_500_000);
    expect(done.status).toBe('completed');
    expect(done.profileId).toBe(profileId);
    // política threshold 60%: 2 de 1 planejada → avança de B para C
    expect((await getRotation('r1')).nextIndex).toBe(2);
    const next = await startSession('r1', 'r1-C');
    expect(next.profileId).toBe(profileId);

    db.close();
    setDb(new IronTrackDB(name));
    await db.open();
    expect(db.currentProfileId).toBe(profileId);
    expect(await db.profiles.count()).toBe(1);
    expect((await db.sessions.get('ativo'))?.status).toBe('completed');
    expect(await db.sessions.count()).toBe(5);
    expect(await db.photos.count()).toBe(4);
  });

  it('a migração roda uma única vez: reabrir não cria outro perfil nem altera registros', async () => {
    const name = uniqueName();
    await createLegacyV1(name, legacyData());
    setDb(new IronTrackDB(name));
    await db.open();
    const first = await readSnapshot();
    const id = db.currentProfileId;
    db.close();
    for (let i = 0; i < 3; i++) {
      setDb(new IronTrackDB(name));
      await db.open();
      expect(db.currentProfileId).toBe(id);
      expect(await db.profiles.count()).toBe(1);
      expect(await readSnapshot()).toEqual(first);
      db.close();
    }
  });

  it('banco v1 vazio também ganha exatamente um perfil', async () => {
    const name = uniqueName();
    await createLegacyV1(name, { settings: null, routines: [], sessions: [], rotations: [], overrides: [], bodyEntries: [], photos: [], goals: [], planEntries: [], calendarDecisions: [] });
    setDb(new IronTrackDB(name));
    await db.open();
    expect(await db.profiles.count()).toBe(1);
  });

  it('falha ao criar o perfil durante o upgrade: rollback completo, banco continua v1 e intacto', async () => {
    const name = uniqueName();
    const d = legacyData();
    await createLegacyV1(name, d);

    const broken = new FailingIdDB(name);
    const err = await broken.open().then(
      () => null,
      (e) => e,
    );
    expect(err).toBeTruthy();
    expect(describeOpenError(err)).toMatch(/versão 2/);
    expect(describeOpenError(err)).toMatch(/não foram apagados/);
    broken.close();

    const raw = await openRaw(name);
    expect(raw.verno).toBe(1);
    expect(raw.tables.map((t) => t.name)).not.toContain('profiles');
    expect(await raw.table('sessions').count()).toBe(d.sessions.length);
    expect((await raw.table('sessions').toArray()).some((s) => 'profileId' in s)).toBe(false);
    raw.close();

    // nova tentativa com o app normal conclui a migração
    setDb(new IronTrackDB(name));
    await db.open();
    expect(db.verno).toBe(DB_SCHEMA_VERSION);
    expectSameData(await readSnapshot(), d);
  });

  it('falha no meio da atribuição de dono: nada fica parcialmente migrado', async () => {
    const name = uniqueName();
    const d = legacyData();
    await createLegacyV1(name, d);
    const broken = new FailingPhotosDB(name);
    await expect(broken.open()).rejects.toBeTruthy();
    broken.close();

    const raw = await openRaw(name);
    expect(raw.verno).toBe(1);
    for (const t of ['routines', 'sessions', 'bodyEntries', 'photos']) expect((await raw.table(t).toArray()).every((r) => r.profileId === undefined)).toBe(true);
    raw.close();
  });

  it('versão antiga do app (v1, ex.: aba antiga em cache) grava sem dono num banco v2: registro é adotado ao reabrir', async () => {
    const name = uniqueName();
    await createLegacyV1(name, snapshot());
    setDb(new IronTrackDB(name));
    await db.open();
    const id = db.currentProfileId;
    db.close();

    const old = new Dexie(name);
    old.version(1).stores(LEGACY_V1_STORES);
    await old.open();
    await old.table('sessions').put(session('gravado-pela-aba-antiga', { startedAt: 1_700_500_000_000 }));
    old.close();

    setDb(new IronTrackDB(name));
    await db.open();
    expect((await db.sessions.get('gravado-pela-aba-antiga'))?.profileId).toBe(id);
    expect(await db.profiles.count()).toBe(1);
  });
});

describe('infraestrutura de migrações (versão 6 hipotética)', () => {
  it('upgrade real v6 → v6 preserva os dados, o perfil e aplica a transformação', async () => {
    const name = uniqueName();
    const d = legacyData();
    await createLegacyV1(name, d);
    setDb(new IronTrackDB(name));
    await db.open();
    const id = db.currentProfileId;
    db.close();

    const v6 = new IronTrackDBv6(name, async (tx) => {
      await tx
        .table('sessions')
        .toCollection()
        .modify((s: Record<string, unknown>) => {
          s.migratedFlag = true;
        });
    });
    await v6.open();
    expect(v6.verno).toBe(6);
    expect(v6.currentProfileId).toBe(id);
    const sessions = await v6.table('sessions').toArray();
    expect(sessions).toHaveLength(d.sessions.length);
    expect(sessions.every((s) => s.migratedFlag === true && s.profileId === id)).toBe(true);
    // o novo índice funciona
    expect(await v6.table('sessions').where('finishedAt').above(0).count()).toBe(3);
    expect(await v6.table('photos').count()).toBe(d.photos.length);
    expect(await v6.table('settings').get('settings')).toEqual(d.settings);
    v6.close();

    // reabertura do banco atualizado
    const again = new IronTrackDBv6(name, () => {
      throw new Error('não deveria rodar de novo');
    });
    await again.open();
    expect(await again.table('sessions').count()).toBe(d.sessions.length);
    again.close();
  });

  it('falha na migração não perde dados: banco continua na versão atual e intacto', async () => {
    const name = uniqueName();
    const d = legacyData();
    await createLegacyV1(name, d);
    setDb(new IronTrackDB(name));
    await db.open();
    const before = await readSnapshot();
    db.close();

    const broken = new IronTrackDBv6(name, async (tx) => {
      await tx
        .table('sessions')
        .toCollection()
        .modify((s: Record<string, unknown>) => {
          s.status = 'corrompido';
        });
      throw new Error('erro no meio do upgrade');
    });
    const err = await broken.open().then(
      () => null,
      (e) => e,
    );
    expect(err).toBeTruthy();
    const msg = describeOpenError(err);
    expect(msg).toMatch(/versão 6/);
    expect(msg).toMatch(/não foram apagados/);
    broken.close();

    setDb(new IronTrackDB(name));
    await db.open();
    expect(db.verno).toBe(DB_SCHEMA_VERSION);
    expect(await readSnapshot()).toEqual(before);
  });

  it('migration() embrulha o erro com versão e descrição', async () => {
    const fn = migration(3, 'exemplo', () => {
      throw new Error('boom');
    });
    await expect(fn({} as never)).rejects.toBeInstanceOf(MigrationError);
    await expect(fn({} as never)).rejects.toThrow(/versão 3 \(exemplo\): boom/);
  });

  it('app anterior (v4) abre banco já atualizado para v6 sem apagar dados', async () => {
    const name = uniqueName();
    await createLegacyV1(name, snapshot({ routines: [routine()], rotations: [rotation()] }));
    const v6 = new IronTrackDBv6(name, () => undefined);
    await v6.open();
    const id = v6.currentProfileId;
    v6.close();
    // Dexie 4 abre bancos de versão superior em modo compatível (ex.: service worker antigo em cache).
    const old = new IronTrackDB(name);
    await old.open();
    expect(old.currentProfileId).toBe(id);
    expect(await old.routines.count()).toBe(1);
    expect((await old.rotations.get('r1'))?.nextIndex).toBe(1);
    old.close();
  });

  it('erro de versão do IndexedDB vira mensagem clara', () => {
    expect(describeOpenError({ name: 'VersionError' })).toMatch(/versão mais nova/);
    expect(describeOpenError({ name: 'DatabaseClosedError', inner: { name: 'VersionError' } })).toMatch(/versão mais nova/);
    expect(describeOpenError({ name: 'MissingAPIError' })).toMatch(/IndexedDB/);
    expect(describeOpenError(new Error('x'))).toMatch(/Nada foi apagado/);
  });
});

describe('exclusão de rotina após a migração', () => {
  it('treinos históricos continuam acessíveis e com o mesmo dono', async () => {
    const name = uniqueName();
    await createLegacyV1(name, legacyData());
    setDb(new IronTrackDB(name));
    await db.open();
    await deleteRoutine('r1');
    const hist = await completedSessions();
    expect(hist.map((s) => s.id)).toEqual(['historico', 's1', 's2']);
    expect(hist.every((s) => s.profileId === db.currentProfileId)).toBe(true);
    expect((await checkLocalIntegrity()).ok).toBe(true);
  });
});
