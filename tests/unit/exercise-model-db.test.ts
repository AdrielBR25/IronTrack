// Modelo de exercícios v3 (P10) no banco e no backup: migração (sem upgrade físico), preservação de IDs e
// relações, perfis, fotos, volume grande, falha com rollback e backup v3. Dados fictícios apenas.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { DB_SCHEMA_VERSION, IronTrackDB, db, migration, setDb } from '@/db/db';
import { addRoutine, completeSession, completedSessions, getActiveSession, getRotation, saveSession, startSession } from '@/db/repo';
import {
  BACKUP_SCHEMA_VERSION,
  BackupRestoreError,
  STALE_PREVIEW_MESSAGE,
  assignOwner,
  exportBackup,
  parseBackup,
  previewRestore,
  readLocalState,
  readSnapshot,
  restoreBackupMerge,
  restoreBackupReplace,
  type BackupFile,
} from '@/lib/backup';
import { createTrainingAnalytics } from '@/modules/analytics';
import { completeSet, updateSet } from '@/modules/training';
import type { DataSnapshot, WorkoutSession } from '@/lib/types';
import { backupOf, entry, photo, session, snapshot } from './fixtures';
import { modelRoutine, modelSession, modelSnapshot } from './modelFixtures';

const V1_STORES = {
  settings: 'id',
  routines: 'id, updatedAt',
  sessions: 'id, status, startedAt, workoutId, routineId',
  rotations: 'routineId',
  overrides: '[routineId+date], routineId, date',
  bodyEntries: 'id, date',
  photos: 'id, entryId',
};
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
const P1 = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Principal', isDefault: true, createdAt: 1_600_000_000_000, updatedAt: 1_600_000_000_000 };
const P2 = { id: '22222222-2222-4222-8222-222222222222', displayName: 'Segundo', isDefault: false, createdAt: 1_650_000_000_000, updatedAt: 1_650_000_000_000 };

let n = 0;
const name = () => `model-v3-${++n}`;
afterEach(() => vi.restoreAllMocks());

async function createRaw(dbName: string, version: 1 | 2, d: DataSnapshot, profiles: object[] = []) {
  const raw = new Dexie(dbName);
  raw.version(version).stores(version === 1 ? V1_STORES : V2_STORES);
  await raw.open();
  await raw.transaction('rw', raw.tables, async () => {
    if (d.settings) await raw.table('settings').put(d.settings);
    if (version === 2) await raw.table('profiles').bulkPut(profiles);
    for (const t of ['routines', 'sessions', 'rotations', 'overrides', 'bodyEntries', 'photos'] as const) await raw.table(t).bulkPut(d[t]);
  });
  raw.close();
}

async function rawDump(dbName: string) {
  const raw = new Dexie(dbName);
  await raw.open();
  const out: Record<string, unknown[]> = {};
  for (const t of raw.tables) out[t.name] = await t.toArray();
  const verno = raw.verno;
  raw.close();
  return { verno, tables: out };
}

async function openApp(dbName: string) {
  setDb(new IronTrackDB(dbName));
  await db.open();
  return db;
}

const byId = <T extends { id: string }>(a: T[]) => [...a].sort((x, y) => x.id.localeCompare(y.id));
const noOwner = <T extends { profileId?: string }>(a: T[]) => a.map(({ profileId: _p, ...r }) => r);

describe('migração: o modelo v3 não exige upgrade físico do IndexedDB', () => {
  it('o modelo não criou índices: rotinas e treinos mantêm a declaração v2 (a v3 do P12 só acrescenta metas) e o backup passou a v3 (hoje v6)', async () => {
    // P12/P13/P16: o esquema físico subiu (3: `goals`; 4: `planEntries`; 5: `calendarDecisions`), não por causa do
    // modelo de exercícios.
    expect(DB_SCHEMA_VERSION).toBe(5);
    expect(BACKUP_SCHEMA_VERSION).toBe(6);
    const cur = new IronTrackDB(name());
    await cur.open();
    const schema = Object.fromEntries(cur.tables.map((t) => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map((i) => i.src)].join(', ')]));
    for (const t of Object.keys(V2_STORES) as (keyof typeof V2_STORES)[]) expect(schema[t]).toBe(V2_STORES[t]);
    cur.close();
  });

  it('banco v1 → atual: registros antigos intactos e registros com os campos novos preservados no upgrade', async () => {
    const dbName = name();
    const d = modelSnapshot();
    await createRaw(dbName, 1, d);
    await openApp(dbName);
    expect(db.verno).toBe(DB_SCHEMA_VERSION);
    const after = await readSnapshot();
    // Mesmos registros, mesmos IDs, mesmos campos (inclusive os novos); só o dono foi atribuído.
    expect(byId(noOwner(after.sessions))).toEqual(byId(d.sessions));
    expect(byId(noOwner(after.routines))).toEqual(byId(d.routines));
    expect(byId(noOwner(after.photos))).toEqual(byId(d.photos));
    expect(new Set([...after.routines, ...after.sessions].map((r) => r.profileId))).toEqual(new Set([db.currentProfileId]));
    const m1 = after.sessions.find((s) => s.id === 'm1')!;
    expect(m1.exercises[0].sets[1].durationSec).toBe(60);
    expect(m1.exercises[2].sets.map((s) => s.side)).toEqual(['direito', 'esquerdo']);
    db.close();
  });

  it('banco v2 → atual: nada é reescrito (dump idêntico antes e depois de abrir) e o app anterior continua abrindo', async () => {
    const dbName = name();
    const d = assignOwner(modelSnapshot(), P1.id);
    await createRaw(dbName, 2, d, [P1]);
    const before = await rawDump(dbName);
    await openApp(dbName);
    expect(db.currentProfileId).toBe(P1.id);
    db.close();
    const after = await rawDump(dbName);
    // P12/P13/P16: abrir cria só as tabelas de metas, planejamento e decisões, vazias (v5); nada existente é reescrito.
    expect(after.verno).toBe(5);
    expect(after.tables.goals).toEqual([]);
    expect(after.tables.planEntries).toEqual([]);
    expect(after.tables.calendarDecisions).toEqual([]);
    const { goals: _g, planEntries: _p, calendarDecisions: _c, ...rest } = after.tables;
    expect(rest).toEqual(before.tables);
    // O app do P09 declara só o esquema v2: o Dexie 4 abre o banco v3 com os dados novos sem VersionError.
    const p09 = new Dexie(dbName);
    p09.version(2).stores(V2_STORES);
    await p09.open();
    expect(await p09.table('sessions').count()).toBe(d.sessions.length);
    p09.close();
  });

  it('banco novo: grava e lê rotina e treino com os campos novos (fluxo real de treino)', async () => {
    await openApp(name());
    const r = modelRoutine();
    await addRoutine(r, true);
    let s = await startSession(r.id, r.workouts[0].id);
    const plank = s.exercises[1];
    s = updateSet(s, plank.id, plank.sets[0].id, { durationSec: 50 });
    s = completeSet(s, plank.id, plank.sets[0].id);
    const lunge = s.exercises[3];
    s = updateSet(s, lunge.id, lunge.sets[0].id, { side: 'esquerdo', reps: 10, weight: 16 });
    s = completeSet(s, lunge.id, lunge.sets[0].id);
    await saveSession(s);
    // "Recarregar": nova instância do banco, treino em andamento retomado com os dados.
    db.close();
    await openApp(db.name);
    const resumed = (await getActiveSession())!;
    expect(resumed.exercises[1].sets[0]).toMatchObject({ status: 'done', durationSec: 50, reps: null });
    expect(resumed.exercises[3].sets[0]).toMatchObject({ status: 'done', side: 'esquerdo', reps: 10, weight: 16 });
    expect(resumed.exercises[3].sets[1].side).toBeUndefined();
    const done = await completeSession(resumed);
    expect(done.status).toBe('completed');
    expect((await getRotation(r.id)).nextIndex).toBe(1);
    expect((await db.routines.get(r.id))!.workouts[0].exercises[2]).toMatchObject({ modality: 'cardio', distanceUnit: 'km', targetDistance: 5000 });
    db.close();
  });

  it('múltiplos perfis: donos, perfis e relações preservados; nenhum registro muda de perfil', async () => {
    const dbName = name();
    const mine = assignOwner(modelSnapshot(), P1.id);
    const theirs = assignOwner(
      snapshot({ routines: [{ ...modelRoutine('r9') }], sessions: [modelSession('o1', 1_700_300_000_000, { routineId: 'r9', workoutId: 'r9-A' })], rotations: [], overrides: [], bodyEntries: [entry('ob')], photos: [photo('op', 'ob')] }),
      P2.id,
    );
    const d: DataSnapshot = { ...mine, routines: [...mine.routines, ...theirs.routines], sessions: [...mine.sessions, ...theirs.sessions], bodyEntries: [...mine.bodyEntries, ...theirs.bodyEntries], photos: [...mine.photos, ...theirs.photos] };
    await createRaw(dbName, 2, d, [P1, P2]);
    await openApp(dbName);
    const { data, profiles } = await readLocalState();
    expect(byId(profiles)).toEqual(byId([P1, P2]));
    expect(data.sessions.find((s) => s.id === 'o1')).toEqual(d.sessions.find((s) => s.id === 'o1'));
    expect(data.photos.find((p) => p.id === 'op')).toMatchObject({ profileId: P2.id, entryId: 'ob' });
    expect(data.routines.find((r) => r.id === 'r9')!.profileId).toBe(P2.id);
    db.close();
  });

  it('2 000 sessões (antigas e novas) com fotos: contagem, IDs e campos preservados', async () => {
    const dbName = name();
    const d = snapshot();
    for (let i = 0; i < 2000; i++)
      d.sessions.push(i % 2 ? session(`old-${i}`, { startedAt: 1_600_000_000_000 + i * 86_400_000 }) : modelSession(`new-${i}`, 1_600_000_000_000 + i * 86_400_000));
    for (let i = 0; i < 20; i++) d.photos.push(photo(`ph-${i}`, 'b1'));
    await createRaw(dbName, 1, d);
    // Sem limite de tempo aqui: o fake-indexeddb dos testes é muito mais lento que o IndexedDB do navegador.
    await openApp(dbName);
    expect(await db.sessions.count()).toBe(d.sessions.length);
    expect(await db.photos.count()).toBe(d.photos.length);
    expect(noOwner([(await db.sessions.get('new-1998'))!])[0]).toEqual(d.sessions.find((s) => s.id === 'new-1998'));
    // O analytics aguenta o volume e lê os dados novos.
    const a = createTrainingAnalytics(await completedSessions());
    expect(a.history('prancha')!.points).toHaveLength(1000);
    db.close();
  }, 120_000);

  it('registros antigos incompletos continuam abrindo, sem campos inventados', async () => {
    const dbName = name();
    const partial = session('parcial', { finishedAt: undefined, durationSec: undefined, notes: undefined });
    partial.exercises[0].sets.push({ id: 'p-s2', type: 'normal', status: 'done', weight: null, reps: null });
    delete (partial.exercises[0] as Partial<typeof partial.exercises[0]>).equipment;
    const d = snapshot({ sessions: [partial] });
    await createRaw(dbName, 1, d);
    await openApp(dbName);
    const got = noOwner(await db.sessions.toArray())[0];
    expect(got).toEqual(partial);
    expect(got.exercises[0].sets[1]).not.toHaveProperty('durationSec');
    expect(() => createTrainingAnalytics([got as WorkoutSession]).report('all', '2026-01-01')).not.toThrow();
    db.close();
  });

  it('falha numa futura migração com dados do modelo v3: rollback completo (inclusive das v3 e v4 do P12/P13), banco continua v2 e intacto', async () => {
    const dbName = name();
    await createRaw(dbName, 2, assignOwner(modelSnapshot(), P1.id), [P1]);
    const before = await rawDump(dbName);
    class FailingV5 extends IronTrackDB {
      constructor(n: string) {
        super(n);
        this.version(5)
          .stores({})
          .upgrade(
            migration(5, 'teste: falha no meio', async (tx) => {
              await tx.table('sessions').toCollection().modify((s: Record<string, unknown>) => {
                s.tocado = true;
              });
              throw new Error('falha simulada');
            }),
          );
      }
    }
    const broken = new FailingV5(dbName);
    await expect(broken.open()).rejects.toThrow();
    broken.close();
    expect(await rawDump(dbName)).toEqual(before);
  });

  it('IDs e relações (rotina → treino → exercício da ficha → sessão, foto → avaliação) intactos', async () => {
    const dbName = name();
    const d = modelSnapshot();
    await createRaw(dbName, 1, d);
    await openApp(dbName);
    const after = await readSnapshot();
    const r = after.routines[0];
    for (const s of after.sessions.filter((x) => x.id.startsWith('m'))) {
      expect(s.routineId).toBe(r.id);
      expect(r.workouts.some((w) => w.id === s.workoutId)).toBe(true);
      const tplIds = new Set(r.workouts.flatMap((w) => w.exercises.map((e) => e.id)));
      expect(s.exercises.every((e) => tplIds.has(e.templateId!))).toBe(true);
    }
    expect(after.photos.map((p) => [p.id, p.entryId]).sort()).toEqual(d.photos.map((p) => [p.id, p.entryId]).sort());
    db.close();
  });
});

describe('backup v3 (lido como v5 desde o P13)', () => {
  const parse = (o: unknown): BackupFile => {
    const r = parseBackup(JSON.stringify(o));
    if (!r.ok) throw new Error(r.errors.join('\n'));
    return r.value;
  };
  async function seeded(d: DataSnapshot) {
    await openApp(name());
    const owned = assignOwner(d, db.currentProfileId!);
    await db.transaction('rw', db.tables, async () => {
      if (owned.settings) await db.settings.put(owned.settings);
      await db.routines.bulkPut(owned.routines);
      await db.sessions.bulkPut(owned.sessions);
      await db.rotations.bulkPut(owned.rotations);
      await db.overrides.bulkPut(owned.overrides);
      await db.bodyEntries.bulkPut(owned.bodyEntries);
      await db.photos.bulkPut(owned.photos);
    });
  }

  it('exporta (v6) com os campos novos e reimporta sem perder nada (substituir)', async () => {
    await seeded(modelSnapshot());
    const before = await readSnapshot();
    const file = await exportBackup();
    expect(file.schemaVersion).toBe(6);
    const text = JSON.stringify(file);
    for (const k of ['"modality":"timed"', '"durationSec":45', '"distance":5000', '"side":"direito"', '"assistanceKg":25', '"loadMode":"adicional"', '"secondaryMuscles":["Glúteos"]', '"distanceUnit":"km"'])
      expect(text).toContain(k);
    await db.sessions.clear();
    await restoreBackupReplace(parse(JSON.parse(text)));
    expect(await readSnapshot()).toEqual(before);
  });

  it('importa v0, v1, v2, v3, v4, v5 e v6', async () => {
    const d = modelSnapshot();
    const v0 = parse({ app: 'irontrack', exportedAt: '2025-01-01T00:00:00.000Z', ...d });
    const v1 = parse(backupOf(d));
    const v2 = parse({ ...backupOf(assignOwner(d, P1.id)), schemaVersion: 2, profile: { id: P1.id, displayName: 'P' } });
    const v3 = parse({ ...backupOf(assignOwner(d, P1.id)), schemaVersion: 3, profile: { id: P1.id, displayName: 'P' } });
    const v4 = parse({ ...backupOf(assignOwner(d, P1.id)), schemaVersion: 4, profile: { id: P1.id, displayName: 'P' } });
    const v5 = parse({ ...backupOf(assignOwner(d, P1.id)), schemaVersion: 5, profile: { id: P1.id, displayName: 'P' } });
    const v6 = parse({ ...backupOf(assignOwner(d, P1.id)), schemaVersion: 6, profile: { id: P1.id, displayName: 'P' } });
    for (const b of [v0, v1, v2, v3, v4, v5, v6]) {
      expect(b.schemaVersion).toBe(6);
      expect(b.data.planEntries).toEqual([]);
      expect(b.data.calendarDecisions).toEqual([]);
      expect(b.data.goals).toEqual([]);
      expect(b.data.sessions.find((s) => s.id === 'm1')!.exercises[1].sets[0]).toMatchObject({ durationSec: 1500, distance: 5000 });
    }
    expect([v0.profile, v1.profile]).toEqual([null, null]);
    expect(v2.profile?.id).toBe(P1.id);
  });

  it('versão incompatível (futura) e arquivo malformado são recusados sem gravar', async () => {
    const future = parseBackup(JSON.stringify({ ...backupOf(modelSnapshot()), schemaVersion: 7, profile: null }));
    expect(!future.ok && future.errors[0]).toMatch(/versão mais nova/);
    const malformed = parseBackup('{"app":"irontrack","kind":"backup","schemaVersion":3,"exportedAt":"x","profile":null,"data":{"sessions":"oops"}}');
    expect(malformed.ok).toBe(false);
  });

  it('dados de modalidade inválidos: restauração bloqueada (substituir e mesclar), nada é descartado nem gravado', async () => {
    await seeded(snapshot());
    const before = await readSnapshot();
    const bad = modelSnapshot();
    bad.sessions.find((s) => s.id === 'm2')!.exercises[1].sets[0].distance = -10;
    bad.routines[0].workouts[0].exercises[1].modality = 'yoga' as never;
    const b = parse(backupOf(bad));
    const p = await previewRestore(b);
    expect(p.blocked).toBe(true);
    expect(p.integrity.issues.filter((i) => i.code === 'INVALID_MODALITY_FIELD').map((i) => i.id).sort()).toEqual(['m2', 'r1']);
    await expect(restoreBackupReplace(b)).rejects.toBeInstanceOf(BackupRestoreError);
    await expect(restoreBackupMerge(b)).rejects.toBeInstanceOf(BackupRestoreError);
    expect(await readSnapshot()).toEqual(before);
  });

  it('combinação contraditória é avisada e preservada como está na restauração', async () => {
    await seeded(snapshot({ sessions: [] }));
    const d = modelSnapshot();
    d.sessions.find((s) => s.id === 'm1')!.exercises[3].sets[0].weight = 5; // assistência + carga
    const b = parse(backupOf(d));
    const p = await previewRestore(b);
    expect(p.blocked).toBe(false);
    expect(p.integrity.issues.some((i) => i.code === 'MODALITY_CONTRADICTION' && i.id === 'm1')).toBe(true);
    await restoreBackupMerge(b, { acceptPartial: true });
    expect((await db.sessions.get('m1'))!.exercises[3].sets[0]).toMatchObject({ weight: 5, assistanceKg: 25 });
  });

  it('mesclagem: adiciona treinos com os campos novos, mantém locais e informa conflitos (mesclagem parcial autorizada)', async () => {
    await seeded(snapshot());
    const local = (await db.sessions.get('s1'))!;
    const d = modelSnapshot();
    d.sessions[0] = { ...d.sessions[0], notes: 'versão diferente' };
    const b = parse(backupOf(d));
    const p = await previewRestore(b);
    expect(p.merge.totals.conflict).toBeGreaterThan(0);
    await expect(restoreBackupMerge(b)).rejects.toThrow(/Confirme explicitamente/);
    await restoreBackupMerge(b, { acceptPartial: true, expectedLocalFingerprint: p.localFingerprint });
    expect(await db.sessions.get('s1')).toEqual(local);
    expect((await db.sessions.get('m2'))!.exercises[2].sets[1]).toMatchObject({ side: 'esquerdo', reps: 9 });
  });

  it('restauração cancelada (dados mudaram desde a prévia) e falha no meio: nada muda', async () => {
    await seeded(snapshot());
    const b = parse(backupOf(modelSnapshot()));
    const p = await previewRestore(b);
    await db.sessions.put({ ...(await db.sessions.get('s2'))!, notes: 'mudou em outra aba' });
    const before = await readSnapshot();
    await expect(restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow(STALE_PREVIEW_MESSAGE);
    vi.spyOn(db.photos, 'bulkPut').mockRejectedValueOnce(new Error('disco cheio (simulado)'));
    await expect(restoreBackupReplace(b)).rejects.toThrow(/disco cheio/);
    expect(await readSnapshot()).toEqual(before);
  });

  it('referências inválidas continuam tratadas como antes (foto órfã aviso, treino de rotina excluída informativo)', async () => {
    await seeded(snapshot({ sessions: [], photos: [] }));
    const d = modelSnapshot();
    d.photos.push(photo('orfa', 'nao-existe'));
    d.sessions.push(modelSession('hist', 1_690_000_000_000, { routineId: 'rotina-excluida' }));
    const p = await previewRestore(parse(backupOf(d)));
    expect(p.blocked).toBe(false);
    expect(p.integrity.issues.find((i) => i.id === 'orfa')?.code).toBe('PHOTO_ORPHAN');
    expect(p.integrity.issues.find((i) => i.id === 'hist')?.code).toBe('SESSION_HISTORICAL_REFERENCE');
  });

  it('substituição por backup de outro perfil continua exigindo a confirmação de transferência', async () => {
    await seeded(snapshot());
    const other = parse({ ...backupOf(assignOwner(modelSnapshot(), P2.id)), schemaVersion: 3, profile: { id: P2.id, displayName: 'Outro' } });
    await expect(restoreBackupReplace(other)).rejects.toThrow(/Confirme explicitamente/);
    await restoreBackupReplace(other, { acceptProfileTransfer: true });
    const s = (await db.sessions.get('m1'))!;
    expect(s.profileId).toBe(db.currentProfileId);
    expect(s.exercises[0].sets[1].durationSec).toBe(60);
  });
});
