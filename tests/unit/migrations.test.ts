import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { DB_SCHEMA_VERSION, IronTrackDB, MigrationError, db, describeOpenError, migration, setDb } from '@/db/db';
import { completeSession, getActiveSession, getRotation, startSession } from '@/db/repo';
import { readSnapshot } from '@/lib/backup';
import { completeSet } from '@/lib/session';
import type { DataSnapshot } from '@/lib/types';
import { routine, rotation, session, settings, snapshot } from './fixtures';

// Cópia CONGELADA da declaração `this.version(1).stores(...)` publicada em produção.
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

let n = 0;
const uniqueName = () => `migration-test-${++n}`;

/** Dados representativos de um usuário real (fictícios), incluindo treino em andamento. */
function legacyData(): DataSnapshot {
  const d = snapshot();
  const active = session('ativo', { status: 'active', workoutId: 'r1-B', workoutLabel: 'B', workoutName: 'Treino B', startedAt: 1_700_200_000_000, finishedAt: undefined, durationSec: undefined });
  active.exercises[0].sets.push({ id: 'ativo-s2', type: 'normal', status: 'pending', weight: 60, reps: 8 });
  active.rest = { durationMs: 120_000, endsAt: 1_700_200_120_000, pausedRemainingMs: null, nextLabel: 'Série 2', exerciseId: active.exercises[0].id, setId: 'ativo-s2' };
  d.sessions.push(active);
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
function expectSameData(a: DataSnapshot, b: DataSnapshot) {
  expect(a.settings).toEqual(b.settings);
  expect(byId(a.routines)).toEqual(byId(b.routines));
  expect(byId(a.sessions)).toEqual(byId(b.sessions));
  expect(a.rotations).toEqual(b.rotations);
  expect([...a.overrides].sort((x, y) => x.date.localeCompare(y.date))).toEqual([...b.overrides].sort((x, y) => x.date.localeCompare(y.date)));
  expect(byId(a.bodyEntries)).toEqual(byId(b.bodyEntries));
  expect(byId(a.photos)).toEqual(byId(b.photos));
}

/** Versão hipotética 2, só para testar a infraestrutura de upgrade. */
class IronTrackDBv2 extends IronTrackDB {
  constructor(name: string, upgrade: Parameters<typeof migration>[2]) {
    super(name);
    this.version(2)
      .stores({ sessions: 'id, status, startedAt, workoutId, routineId, finishedAt' })
      .upgrade(migration(2, 'teste: índice finishedAt e campo derivado', upgrade));
  }
}

describe('esquema IndexedDB', () => {
  it('versão 1 permanece idêntica à publicada (não alterar retroativamente)', async () => {
    expect(DB_SCHEMA_VERSION).toBe(1);
    const cur = new IronTrackDB(uniqueName());
    await cur.open();
    expect(cur.verno).toBe(DB_SCHEMA_VERSION);
    const schema = Object.fromEntries(cur.tables.map((t) => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map((i) => i.src)].join(', ')]));
    expect(schema).toEqual(LEGACY_V1_STORES);
    cur.close();
  });
});

describe('abertura de banco legado v1', () => {
  it('abre um banco criado com o esquema v1 e preserva todos os registros', async () => {
    const name = uniqueName();
    const d = legacyData();
    await createLegacyV1(name, d);

    setDb(new IronTrackDB(name));
    await db.open();
    expectSameData(await readSnapshot(), d);
  });

  it('fluxos continuam funcionando sobre o banco legado: treino em andamento, rotação ABC e reabertura', async () => {
    const name = uniqueName();
    const d = legacyData();
    await createLegacyV1(name, d);
    setDb(new IronTrackDB(name));
    await db.open();

    const active = await getActiveSession();
    expect(active?.id).toBe('ativo');
    expect(active?.rest?.setId).toBe('ativo-s2');
    // iniciar outro treino devolve o que está em andamento
    expect((await startSession('r1', 'r1-C')).id).toBe('ativo');
    const done = await completeSession(completeSet(active!, active!.exercises[0].id, 'ativo-s2'), undefined, 1_700_200_500_000);
    expect(done.status).toBe('completed');
    // política threshold 60%: 2 de 1 planejada → avança de B para C
    expect((await getRotation('r1')).nextIndex).toBe(2);

    db.close();
    setDb(new IronTrackDB(name));
    await db.open();
    expect((await db.sessions.get('ativo'))?.status).toBe('completed');
    expect(await db.sessions.count()).toBe(3);
    expect(await db.photos.count()).toBe(2);
  });
});

describe('infraestrutura de migrações (versão 2 hipotética)', () => {
  it('upgrade real v1 → v2 preserva os dados e aplica a transformação', async () => {
    const name = uniqueName();
    const d = legacyData();
    await createLegacyV1(name, d);

    const v2 = new IronTrackDBv2(name, async (tx) => {
      await tx
        .table('sessions')
        .toCollection()
        .modify((s: Record<string, unknown>) => {
          s.migratedFlag = true;
        });
    });
    await v2.open();
    expect(v2.verno).toBe(2);
    const sessions = await v2.table('sessions').toArray();
    expect(sessions).toHaveLength(d.sessions.length);
    expect(sessions.every((s) => s.migratedFlag === true)).toBe(true);
    // o novo índice funciona
    expect(await v2.table('sessions').where('finishedAt').above(0).count()).toBe(2);
    expect(await v2.table('photos').count()).toBe(d.photos.length);
    expect(await v2.table('settings').get('settings')).toEqual(d.settings);
    v2.close();

    // reabertura do banco atualizado
    const again = new IronTrackDBv2(name, () => {
      throw new Error('não deveria rodar de novo');
    });
    await again.open();
    expect(await again.table('sessions').count()).toBe(d.sessions.length);
    again.close();
  });

  it('falha na migração não perde dados: banco continua na v1 e intacto', async () => {
    const name = uniqueName();
    const d = legacyData();
    await createLegacyV1(name, d);

    const broken = new IronTrackDBv2(name, async (tx) => {
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
    expect(msg).toMatch(/versão 2/);
    expect(msg).toMatch(/não foram apagados/);
    broken.close();

    setDb(new IronTrackDB(name));
    await db.open();
    expect(db.verno).toBe(1);
    expectSameData(await readSnapshot(), d);
  });

  it('migration() embrulha o erro com versão e descrição', async () => {
    const fn = migration(3, 'exemplo', () => {
      throw new Error('boom');
    });
    await expect(fn({} as never)).rejects.toBeInstanceOf(MigrationError);
    await expect(fn({} as never)).rejects.toThrow(/versão 3 \(exemplo\): boom/);
  });

  it('app antigo (v1) abre banco já atualizado para v2 sem apagar dados', async () => {
    const name = uniqueName();
    await createLegacyV1(name, snapshot({ routines: [routine()], rotations: [rotation()] }));
    const v2 = new IronTrackDBv2(name, () => undefined);
    await v2.open();
    v2.close();
    // Dexie 4 abre bancos de versão superior em modo compatível (ex.: service worker antigo em cache).
    const old = new IronTrackDB(name);
    await old.open();
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
