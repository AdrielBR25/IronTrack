// Motor de sincronização (Prompt 21): dois aparelhos (dois bancos IndexedDB) contra um servidor em memória que aplica
// as mesmas regras do PostgreSQL (versão base, idempotência por opId, cursor por conta).
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '@shared/canonical.ts';
import type { SyncCollection } from '@shared/sync/collections.ts';
import type { PullResponse, PushResponse, ServerRecord, SyncOp, SyncOpResult } from '@shared/sync/protocol.ts';
import { AccountDB } from '@/cloud/accountDb';
import { ApiClientError } from '@/cloud/api';
import { SyncEngine, listConflicts, resolveConflict, runSyncCycle, scanLocalChanges, type SyncTransport } from '@/cloud/syncEngine';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const PROFILE = '22222222-2222-4222-8222-222222222222';

class FakeServer {
  rows = new Map<string, ServerRecord>();
  ops = new Map<string, SyncOpResult>();
  seq = 0;
  pushes = 0;
  failNext: unknown = null;
  push(ops: SyncOp[]): PushResponse {
    this.pushes++;
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const results = ops.map((op): SyncOpResult => {
      const prev = this.ops.get(op.opId);
      if (prev) return prev.status === 'applied' ? { ...prev, replayed: true } : prev;
      const key = `${op.collection}:${op.entityId}`;
      const cur = this.rows.get(key);
      const curVersion = cur?.version ?? 0;
      if (op.baseVersion !== curVersion) return { opId: op.opId, status: 'conflict', server: { version: curVersion, deleted: cur?.deleted ?? true, doc: cur?.doc ?? null } };
      const rec: ServerRecord = { collection: op.collection, entityId: op.entityId, version: curVersion + 1, deleted: op.kind === 'delete', doc: op.kind === 'delete' ? null : (JSON.parse(canonicalJson(op.doc)) as Record<string, unknown>), seq: ++this.seq };
      this.rows.set(key, rec);
      const r: SyncOpResult = { opId: op.opId, status: 'applied', version: rec.version, seq: rec.seq };
      this.ops.set(op.opId, r);
      return r;
    });
    return { protocol: 'irontrack.sync.v1', results };
  }
  pull(cursor: string): PullResponse {
    const c = Number(cursor);
    const changes = [...this.rows.values()].filter((r) => r.seq > c).sort((a, b) => a.seq - b.seq);
    return { protocol: 'irontrack.sync.v1', cursor: String(changes.at(-1)?.seq ?? c), hasMore: false, changes };
  }
  doc(c: SyncCollection, id: string) {
    return this.rows.get(`${c}:${id}`);
  }
}

const transport = (s: FakeServer): SyncTransport => ({ push: async (ops) => structuredClone(s.push(structuredClone(ops))), pull: async (cur) => structuredClone(s.pull(cur)) });

let n = 0;
const opened: AccountDB[] = [];
async function device(): Promise<AccountDB> {
  const d = new AccountDB(ACCOUNT, PROFILE, `acct-test-${++n}`);
  await d.open();
  opened.push(d);
  return d;
}
afterEach(() => {
  opened.splice(0).forEach((d) => d.close());
});

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  profileId: PROFILE,
  routineId: 'r1',
  workoutId: 'w1',
  status: 'active',
  startedAt: 1000,
  exercises: [
    { id: 'e1', name: 'Supino', sets: [{ id: 's1', type: 'normal', status: 'pending', weight: 60, reps: 10 }, { id: 's2', type: 'normal', status: 'pending', weight: 60, reps: 10 }] },
    { id: 'e2', name: 'Crucifixo', sets: [{ id: 's3', type: 'normal', status: 'pending', weight: 14, reps: 12 }] },
  ],
  ...extra,
});

async function edit(d: AccountDB, id: string, fn: (s: Record<string, any>) => void) {
  const s = (await d.sessions.get(id)) as unknown as Record<string, any>;
  fn(s);
  await d.sessions.put(s as never);
}

describe('sincronização entre dois aparelhos', () => {
  it('cria, envia, baixa no outro aparelho; repetir não duplica nada', async () => {
    const srv = new FakeServer();
    const [a, b] = [await device(), await device()];
    await a.bodyEntries.add({ id: 'b1', date: '2026-10-01', weightKg: 80, createdAt: 1 } as never);
    await runSyncCycle(a, transport(srv));
    expect(srv.doc('bodyEntries', 'b1')?.version).toBe(1);
    expect(await a.syncOutbox.count()).toBe(0);
    await runSyncCycle(b, transport(srv));
    expect(await b.bodyEntries.get('b1')).toMatchObject({ weightKg: 80, profileId: PROFILE });
    await runSyncCycle(b, transport(srv));
    await runSyncCycle(a, transport(srv));
    expect(srv.doc('bodyEntries', 'b1')?.version).toBe(1);
    expect(await b.syncOutbox.count()).toBe(0);
  });

  it('mesmo treino editado nos dois aparelhos em séries diferentes: mescla sozinho', async () => {
    const srv = new FakeServer();
    const [a, b] = [await device(), await device()];
    await a.sessions.add(session('t1') as never);
    await runSyncCycle(a, transport(srv));
    await runSyncCycle(b, transport(srv));
    await edit(a, 't1', (s) => Object.assign(s.exercises[0].sets[0], { status: 'done', weight: 62.5 }));
    await edit(b, 't1', (s) => Object.assign(s.exercises[1].sets[0], { status: 'done', reps: 11 }));
    await runSyncCycle(a, transport(srv));
    await runSyncCycle(b, transport(srv));
    await runSyncCycle(a, transport(srv));
    const sa = (await a.sessions.get('t1')) as any;
    const sb = (await b.sessions.get('t1')) as any;
    expect(canonicalJson(sa)).toBe(canonicalJson(sb));
    expect(sa.exercises[0].sets[0]).toMatchObject({ status: 'done', weight: 62.5 });
    expect(sa.exercises[1].sets[0]).toMatchObject({ status: 'done', reps: 11 });
    expect(await listConflicts(b)).toEqual([]);
  });

  it('mesma série alterada de formas diferentes: conflito explícito, nada sobrescrito, resolução manual', async () => {
    const srv = new FakeServer();
    const [a, b] = [await device(), await device()];
    await a.sessions.add(session('t1') as never);
    await runSyncCycle(a, transport(srv));
    await runSyncCycle(b, transport(srv));
    await edit(a, 't1', (s) => (s.exercises[0].sets[0].weight = 70));
    await edit(b, 't1', (s) => (s.exercises[0].sets[0].weight = 65));
    await runSyncCycle(a, transport(srv));
    await runSyncCycle(b, transport(srv));
    const [c] = await listConflicts(b);
    expect(c).toMatchObject({ collection: 'sessions', entityId: 't1', paths: ['exercises[e1].sets[s1].weight'] });
    // os dois lados preservados
    expect(((await b.sessions.get('t1')) as any).exercises[0].sets[0].weight).toBe(65);
    expect((srv.doc('sessions', 't1')!.doc as any).exercises[0].sets[0].weight).toBe(70);
    // novos ciclos não resolvem sozinhos
    await runSyncCycle(b, transport(srv));
    expect(await listConflicts(b)).toHaveLength(1);
    await resolveConflict(b, c.key, 'keep_local');
    await runSyncCycle(b, transport(srv));
    expect((srv.doc('sessions', 't1')!.doc as any).exercises[0].sets[0].weight).toBe(65);
    await runSyncCycle(a, transport(srv));
    expect(((await a.sessions.get('t1')) as any).exercises[0].sets[0].weight).toBe(65);
  });

  it('treino finalizado num aparelho e retomado/alterado no outro: conflito (guarda de status)', async () => {
    const srv = new FakeServer();
    const [a, b] = [await device(), await device()];
    await a.sessions.add(session('t1') as never);
    await runSyncCycle(a, transport(srv));
    await runSyncCycle(b, transport(srv));
    await edit(a, 't1', (s) => Object.assign(s, { status: 'completed', finishedAt: 5000 }));
    await edit(b, 't1', (s) => (s.exercises[1].sets[0].status = 'done'));
    await runSyncCycle(a, transport(srv));
    await runSyncCycle(b, transport(srv));
    const [c] = await listConflicts(b);
    expect(c.paths).toEqual(['status']);
    // manter os dois: a cópia local vira um treino separado e o original segue a versão finalizada
    await resolveConflict(b, c.key, 'keep_both');
    await runSyncCycle(b, transport(srv));
    const all = (await b.sessions.toArray()) as any[];
    expect(all).toHaveLength(2);
    expect(all.find((s) => s.id === 't1').status).toBe('completed');
    expect(all.find((s) => s.id !== 't1').exercises[1].sets[0].status).toBe('done');
    expect(srv.rows.size).toBe(2);
  });

  it('exercício substituído nos dois aparelhos (de formas diferentes): conflito', async () => {
    const srv = new FakeServer();
    const [a, b] = [await device(), await device()];
    await a.sessions.add(session('t1') as never);
    await runSyncCycle(a, transport(srv));
    await runSyncCycle(b, transport(srv));
    // substituição no app: mesmo item do treino, outro exercício (ver substituteExercise)
    await edit(a, 't1', (s) => Object.assign(s.exercises[1], { name: 'Voador', substitutedFrom: 'Crucifixo' }));
    await edit(b, 't1', (s) => Object.assign(s.exercises[1], { name: 'Crossover', substitutedFrom: 'Crucifixo' }));
    await runSyncCycle(a, transport(srv));
    await runSyncCycle(b, transport(srv));
    expect((await listConflicts(b))[0].paths).toEqual(['exercises[e2].name']);
    await resolveConflict(b, (await listConflicts(b))[0].key, 'use_server');
    expect(((await b.sessions.get('t1')) as any).exercises[1].name).toBe('Voador');
    expect(await b.syncOutbox.count()).toBe(0);
  });

  it('série removida num aparelho e editada no outro: conflito', async () => {
    const srv = new FakeServer();
    const [a, b] = [await device(), await device()];
    await a.sessions.add(session('t1') as never);
    await runSyncCycle(a, transport(srv));
    await runSyncCycle(b, transport(srv));
    await edit(a, 't1', (s) => s.exercises[0].sets.splice(1, 1));
    await edit(b, 't1', (s) => (s.exercises[0].sets[1].reps = 8));
    await runSyncCycle(a, transport(srv));
    await runSyncCycle(b, transport(srv));
    expect((await listConflicts(b))[0].paths[0]).toMatch(/s2.*removido em outro aparelho/);
  });

  it('excluído num aparelho e alterado no outro: conflito; excluído nos dois: resolve sozinho', async () => {
    const srv = new FakeServer();
    const [a, b] = [await device(), await device()];
    await a.bodyEntries.bulkAdd([{ id: 'x', date: '2026-10-01', weightKg: 80, createdAt: 1 }, { id: 'y', date: '2026-10-02', weightKg: 81, createdAt: 1 }] as never);
    await runSyncCycle(a, transport(srv));
    await runSyncCycle(b, transport(srv));
    await a.bodyEntries.bulkDelete(['x', 'y']);
    await b.bodyEntries.update('x', { weightKg: 79 });
    await b.bodyEntries.delete('y');
    await runSyncCycle(a, transport(srv));
    await runSyncCycle(b, transport(srv));
    const cs = await listConflicts(b);
    expect(cs.map((c) => c.entityId)).toEqual(['x']);
    expect(cs[0].server).toBeNull();
    expect(srv.doc('bodyEntries', 'y')?.deleted).toBe(true);
  });

  it('download nunca sobrescreve alteração local ainda não varrida', async () => {
    const srv = new FakeServer();
    const [a, b] = [await device(), await device()];
    await a.bodyEntries.add({ id: 'x', date: '2026-10-01', weightKg: 80, createdAt: 1 } as never);
    await runSyncCycle(a, transport(srv));
    await runSyncCycle(b, transport(srv));
    await a.bodyEntries.update('x', { weightKg: 85 });
    await runSyncCycle(a, transport(srv));
    // b altera e baixa ANTES de varrer (sem ciclo completo)
    await b.bodyEntries.update('x', { weightKg: 77 });
    const t = transport(srv);
    await runSyncCycle(b, { push: t.push, pull: t.pull });
    expect(((await b.bodyEntries.get('x')) as any).weightKg).toBe(77);
    expect(await listConflicts(b)).toHaveLength(1);
  });

  it('desconexão no meio do treino: fila guarda tudo e reenvia depois sem duplicar (idempotência)', async () => {
    const srv = new FakeServer();
    const a = await device();
    await a.sessions.add(session('t1') as never);
    srv.failNext = new ApiClientError('network', 0, 'sem rede');
    await expect(runSyncCycle(a, transport(srv))).rejects.toMatchObject({ code: 'network' });
    await edit(a, 't1', (s) => (s.exercises[0].sets[0].status = 'done'));
    await scanLocalChanges(a);
    expect(await a.syncOutbox.count()).toBe(1);
    // resposta perdida: o servidor aplicou mas o aparelho não soube; reenviar o mesmo opId é repetição
    const [op] = await a.syncOutbox.toArray();
    srv.push([{ opId: op.opId, collection: 'sessions', entityId: 't1', kind: 'put', baseVersion: 0, doc: op.doc! }]);
    await runSyncCycle(a, transport(srv));
    expect(srv.doc('sessions', 't1')?.version).toBe(1);
    expect(await a.syncOutbox.count()).toBe(0);
  });

  it('sessão expirada durante a sincronização: nada perdido, estado "entrar de novo"', async () => {
    const srv = new FakeServer();
    const a = await device();
    await a.bodyEntries.add({ id: 'x', date: '2026-10-01', weightKg: 80, createdAt: 1 } as never);
    srv.failNext = new ApiClientError('unauthenticated', 401, 'Sessão expirada.');
    let asked = 0;
    const eng = new SyncEngine(a, transport(srv), { onAuthRequired: () => asked++ });
    await eng.syncNow();
    expect(eng.getStatus().state).toBe('auth_required');
    expect(eng.getStatus().pending).toBe(1);
    expect(asked).toBe(1);
    await eng.syncNow();
    expect(eng.getStatus()).toMatchObject({ state: 'synced', pending: 0 });
    eng.stop();
  });

  it('"Sincronizado" só depois da confirmação do servidor', async () => {
    const srv = new FakeServer();
    const a = await device();
    const seen: string[] = [];
    const eng = new SyncEngine(a, transport(srv));
    eng.subscribe(() => seen.push(eng.getStatus().state));
    await a.bodyEntries.add({ id: 'x', date: '2026-10-01', weightKg: 80, createdAt: 1 } as never);
    srv.failNext = new ApiClientError('network', 0, 'sem rede');
    await eng.syncNow();
    expect(eng.getStatus().state).toBe('offline');
    expect(seen).not.toContain('synced');
    await eng.syncNow();
    expect(eng.getStatus().state).toBe('synced');
    eng.stop();
  });

  it('backup restaurado com operações pendentes: tudo vira alteração normal, sem perder pendências', async () => {
    const srv = new FakeServer();
    const [a, b] = [await device(), await device()];
    await a.bodyEntries.add({ id: 'x', date: '2026-10-01', weightKg: 80, createdAt: 1 } as never);
    await runSyncCycle(a, transport(srv));
    await runSyncCycle(b, transport(srv));
    await b.bodyEntries.update('x', { weightKg: 90 }); // remoto
    await runSyncCycle(b, transport(srv));
    await a.bodyEntries.add({ id: 'p', date: '2026-10-03', weightKg: 1, createdAt: 2 } as never); // pendente
    await scanLocalChanges(a);
    // "restaurar backup" antigo: substitui a tabela
    await a.bodyEntries.clear();
    await a.bodyEntries.bulkAdd([{ id: 'x', date: '2026-10-01', weightKg: 75, createdAt: 1 }, { id: 'z', date: '2026-10-05', weightKg: 76, createdAt: 3 }] as never);
    await runSyncCycle(a, transport(srv));
    expect(srv.doc('bodyEntries', 'z')?.version).toBe(1); // novo do backup enviado
    expect(srv.doc('bodyEntries', 'p')).toBeUndefined(); // criado e apagado antes de sair do aparelho
    expect((await listConflicts(a)).map((c) => c.entityId)).toEqual(['x']); // 75 (backup) x 90 (outro aparelho)
    expect((srv.doc('bodyEntries', 'x')!.doc as any).weightKg).toBe(90);
  });
});
