// Motor de sincronização do app (Prompt 21, docs/NUVEM_SINCRONIZACAO.md). Offline primeiro: o app grava sempre no
// IndexedDB da conta e este motor leva as alterações ao servidor quando há conexão.
// Ciclo: varrer (detecta o que mudou desde a última versão conhecida do servidor) → enviar → baixar.
// Regras que não podem ser quebradas:
// - nunca "a última gravação vence": cada envio leva a versão em que se baseia; se o servidor mudou, há mesclagem de
//   três vias automática SÓ quando as alterações não se sobrepõem; senão o registro fica em conflito, os dois lados são
//   preservados e a pessoa decide;
// - o download nunca sobrescreve uma alteração local ainda não enviada;
// - "Sincronizado" só aparece depois que o servidor confirmou tudo (nada pendente, nada sem varrer).
import Dexie from 'dexie';
import { useSyncExternalStore } from 'react';
import { canonicalJson } from '@shared/canonical.ts';
import { SYNC_COLLECTIONS, dexieKeyOf, entityIdOf, type SyncCollection } from '@shared/sync/collections.ts';
import { threeWayMerge } from '@shared/sync/merge.ts';
import { SYNC_LIMITS, type PullResponse, type PushResponse, type SyncOp } from '@shared/sync/protocol.ts';
import type { AccountDB, OutboxEntry, SyncMeta } from './accountDb';
import { ApiClientError, isAuthError, isNetworkError } from './api';

type Doc = Record<string, unknown>;

export interface SyncTransport {
  push(ops: SyncOp[], signal?: AbortSignal): Promise<PushResponse>;
  pull(cursor: string, signal?: AbortSignal): Promise<PullResponse & { reset?: boolean }>;
}

export type SyncPhase = 'idle' | 'syncing';
export type SyncState = 'synced' | 'syncing' | 'offline' | 'pending' | 'conflict' | 'error' | 'auth_required' | 'account_mismatch';

export interface SyncStatus {
  state: SyncState;
  pending: number;
  conflicts: number;
  rejected: number;
  lastSyncAt: number | null;
  /** Mensagem do último erro (sem dados pessoais). */
  error: string | null;
  /** Próxima tentativa automática depois de falha (ms desde a época). */
  retryAt: number | null;
}

const keyOf = (c: SyncCollection, id: string) => `${c}:${id}`;
const newOpId = () => globalThis.crypto.randomUUID();
const byteLen = (s: string) => new TextEncoder().encode(s).length;

/** Registro local atual de uma entidade (ou undefined se não existe neste aparelho). */
async function readLocal(d: AccountDB, c: SyncCollection, entityId: string): Promise<Doc | undefined> {
  return (await d.table(c).get(dexieKeyOf(c, entityId) as never)) as Doc | undefined;
}

async function writeLocal(d: AccountDB, c: SyncCollection, entityId: string, doc: Doc | null): Promise<void> {
  if (doc) await d.table(c).put(doc);
  else await d.table(c).delete(dexieKeyOf(c, entityId) as never);
}

const tablesFor = (d: AccountDB) => [...SYNC_COLLECTIONS.map((c) => d.table(c)), d.syncMeta, d.syncOutbox];

/**
 * Varredura: compara cada registro local com a última versão do servidor conhecida (`syncMeta`) e com a fila.
 * Cria/atualiza no máximo UMA operação por entidade (a mais recente). Registros sem identidade válida são ignorados.
 */
export async function scanLocalChanges(d: AccountDB, now = Date.now()): Promise<number> {
  return d.transaction('rw', tablesFor(d), async () => {
    const metas = new Map((await d.syncMeta.toArray()).map((m) => [m.key, m]));
    const outbox = new Map((await d.syncOutbox.toArray()).map((o) => [o.key, o]));
    const seen = new Set<string>();
    let changed = 0;
    const upsert = async (c: SyncCollection, entityId: string, kind: 'put' | 'delete', doc: Doc | undefined, json: string) => {
      const key = keyOf(c, entityId);
      const meta = metas.get(key);
      const prev = outbox.get(key);
      if (prev) {
        if (prev.json === json && prev.kind === kind) return;
        // Conflito aberto: guarda o conteúdo mais recente deste aparelho e continua aguardando a decisão.
        if (prev.state === 'conflict') {
          await d.syncOutbox.put({ ...prev, kind, json, ...(doc ? { doc } : { doc: undefined }) });
          changed++;
          return;
        }
      }
      if (meta && kind === 'put' && meta.baseJson === json) {
        // Voltou a ser igual ao servidor antes de sair do aparelho: a operação pendente perde o sentido.
        if (!prev) return;
        if (prev.attempts === 0 && prev.state === 'pending') {
          await d.syncOutbox.delete(prev.opId);
          changed++;
          return;
        }
      }
      const entry: OutboxEntry = {
        opId: newOpId(),
        key,
        collection: c,
        entityId,
        kind,
        baseVersion: meta?.version ?? 0,
        json,
        createdAt: prev?.createdAt ?? now,
        attempts: 0,
        state: 'pending',
        ...(doc ? { doc } : {}),
        ...(prev?.reason ? { reason: prev.reason } : {}),
      };
      if (prev) await d.syncOutbox.delete(prev.opId);
      await d.syncOutbox.put(entry);
      changed++;
    };
    for (const c of SYNC_COLLECTIONS) {
      const rows = (await d.table(c).toArray()) as Doc[];
      for (const r of rows) {
        const id = entityIdOf(c, r);
        if (!id) continue;
        seen.add(keyOf(c, id));
        const json = canonicalJson(r);
        await upsert(c, id, 'put', JSON.parse(json) as Doc, json);
      }
    }
    // Conhecido do servidor e ausente aqui: excluído neste aparelho.
    for (const m of metas.values()) if (!seen.has(m.key)) await upsert(m.collection, m.entityId, 'delete', undefined, 'null');
    // Na fila como "put" e ausente aqui sem nunca ter ido ao servidor: criado e apagado antes de sincronizar.
    for (const o of outbox.values()) if (!seen.has(o.key) && !metas.has(o.key) && o.kind === 'put' && o.state !== 'conflict') {
      await d.syncOutbox.delete(o.opId);
      changed++;
    }
    return changed;
  });
}

/** Separa a fila em lotes que respeitam os limites do protocolo. */
function batches(entries: OutboxEntry[]): OutboxEntry[][] {
  const out: OutboxEntry[][] = [];
  let cur: OutboxEntry[] = [];
  let bytes = 0;
  const budget = SYNC_LIMITS.maxPushBytes - 64 * 1024;
  for (const e of entries) {
    const size = byteLen(e.json) + 300;
    if (cur.length && (cur.length >= SYNC_LIMITS.maxOpsPerPush || bytes + size > budget)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(e);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

const toOp = (e: OutboxEntry): SyncOp => ({
  opId: e.opId,
  collection: e.collection,
  entityId: e.entityId,
  kind: e.kind,
  baseVersion: e.baseVersion,
  ...(e.kind === 'put' ? { doc: e.doc } : {}),
  clientTime: e.createdAt,
  ...(e.reason ? { reason: e.reason } : {}),
});

/** Resultado de um envio aplicado a este aparelho (em transação com a fila e as bases). */
async function applyResults(d: AccountDB, sent: OutboxEntry[], res: PushResponse): Promise<void> {
  const byOp = new Map(res.results.map((r) => [r.opId, r]));
  await d.transaction('rw', tablesFor(d), async () => {
    for (const e of sent) {
      const r = byOp.get(e.opId);
      const current = await d.syncOutbox.get(e.opId);
      if (!r) continue;
      if (r.status === 'applied') {
        if (e.kind === 'delete') await d.syncMeta.delete(e.key);
        else await d.syncMeta.put({ key: e.key, collection: e.collection, entityId: e.entityId, version: r.version, baseJson: e.json });
        if (current) await d.syncOutbox.delete(e.opId);
        else {
          // Alterado de novo durante o envio: a operação nova passa a se basear na versão que acabou de ser gravada.
          const newer = await d.syncOutbox.where('key').equals(e.key).first();
          if (newer) await d.syncOutbox.put({ ...newer, baseVersion: r.version });
        }
        continue;
      }
      if (r.status === 'rejected') {
        if (current) await d.syncOutbox.put({ ...current, state: 'rejected', error: r.message, attempts: current.attempts + 1 });
        continue;
      }
      // Conflito: o servidor mudou desde a base deste aparelho.
      const entry = current ?? (await d.syncOutbox.where('key').equals(e.key).first());
      if (!entry) continue;
      const meta = await d.syncMeta.get(e.key);
      const server = r.server;
      const resolved = await resolveAutomatically(d, entry, meta, server);
      if (!resolved) await d.syncOutbox.put({ ...entry, state: 'conflict', server, conflictPaths: conflictPathsOf(entry, meta, server) });
    }
  });
}

function conflictPathsOf(entry: OutboxEntry, meta: SyncMeta | undefined, server: { deleted: boolean; doc: Doc | null }): string[] {
  if (entry.kind === 'delete') return ['(excluído neste aparelho e alterado em outro)'];
  if (server.deleted || !server.doc) return ['(excluído em outro aparelho e alterado neste)'];
  const m = threeWayMerge(entry.collection, meta ? (JSON.parse(meta.baseJson) as Doc) : null, entry.doc!, server.doc);
  return m.ok ? [] : m.conflicts;
}

/**
 * Tenta resolver sem perguntar: lados iguais, exclusão dos dois lados ou mesclagem de três vias sem sobreposição.
 * Devolve true se resolveu (a fila e o registro local já foram atualizados).
 */
async function resolveAutomatically(d: AccountDB, entry: OutboxEntry, meta: SyncMeta | undefined, server: { version: number; deleted: boolean; doc: Doc | null }): Promise<boolean> {
  const serverJson = server.deleted || !server.doc ? 'null' : canonicalJson(server.doc);
  // Os dois aparelhos chegaram ao mesmo resultado.
  if (serverJson === entry.json || (entry.kind === 'delete' && server.deleted)) {
    if (server.deleted) await d.syncMeta.delete(entry.key);
    else await d.syncMeta.put({ key: entry.key, collection: entry.collection, entityId: entry.entityId, version: server.version, baseJson: serverJson });
    await d.syncOutbox.delete(entry.opId);
    return true;
  }
  if (entry.kind === 'delete' || server.deleted || !server.doc || !entry.doc) return false;
  const merged = threeWayMerge(entry.collection, meta ? (JSON.parse(meta.baseJson) as Doc) : null, entry.doc, server.doc);
  if (!merged.ok) return false;
  // Alterado de novo neste aparelho durante o envio: não grava nada; a próxima varredura gera a operação com o conteúdo
  // novo sobre a mesma base, e a mesclagem é refeita com ele (nada se perde de nenhum lado).
  const local = await readLocal(d, entry.collection, entry.entityId);
  if (!local || canonicalJson(local) !== entry.json) return true;
  const mergedJson = canonicalJson(merged.merged);
  await d.syncMeta.put({ key: entry.key, collection: entry.collection, entityId: entry.entityId, version: server.version, baseJson: serverJson });
  await writeLocal(d, entry.collection, entry.entityId, JSON.parse(mergedJson) as Doc);
  await d.syncOutbox.delete(entry.opId);
  if (mergedJson !== serverJson)
    await d.syncOutbox.put({ ...entry, opId: newOpId(), baseVersion: server.version, doc: JSON.parse(mergedJson) as Doc, json: mergedJson, attempts: 0, state: 'pending', server: undefined, conflictPaths: undefined });
  return true;
}

/** Aplica uma página do download sem nunca sobrescrever alteração local pendente. */
async function applyPull(d: AccountDB, page: PullResponse): Promise<void> {
  await d.transaction('rw', tablesFor(d), async () => {
    for (const ch of page.changes) {
      const key = keyOf(ch.collection, ch.entityId);
      const meta = await d.syncMeta.get(key);
      if (meta && ch.version <= meta.version) continue; // eco do próprio envio ou repetição
      const pending = await d.syncOutbox.where('key').equals(key).first();
      if (pending) {
        // Mantém a alteração local; o envio vai encontrar o conflito (ou mesclar). Conflito aberto: atualiza o lado do servidor.
        if (pending.state === 'conflict') await d.syncOutbox.put({ ...pending, server: { version: ch.version, deleted: ch.deleted, doc: ch.doc } });
        continue;
      }
      const local = await readLocal(d, ch.collection, ch.entityId);
      const localJson = local ? canonicalJson(local) : null;
      const serverJson = ch.deleted || !ch.doc ? null : canonicalJson(ch.doc);
      // Alterado aqui depois da última varredura: não toca; a próxima varredura cria a operação (e o conflito, se houver).
      const untouched = meta ? localJson === meta.baseJson : localJson === null || localJson === serverJson;
      if (!untouched) continue;
      if (serverJson === null) {
        await writeLocal(d, ch.collection, ch.entityId, null);
        await d.syncMeta.delete(key);
      } else {
        if (localJson !== serverJson) await writeLocal(d, ch.collection, ch.entityId, JSON.parse(serverJson) as Doc);
        await d.syncMeta.put({ key, collection: ch.collection, entityId: ch.entityId, version: ch.version, baseJson: serverJson });
      }
    }
  });
}

async function kvGet<T extends string | number>(d: AccountDB, k: 'deviceId' | 'cursor' | 'lastSyncAt'): Promise<T | undefined> {
  return (await d.syncKv.get(k))?.v as T | undefined;
}

export async function deviceIdOf(d: AccountDB): Promise<string> {
  return d.transaction('rw', d.syncKv, async () => {
    const cur = await kvGet<string>(d, 'deviceId');
    if (cur) return cur;
    const id = newOpId();
    await d.syncKv.put({ k: 'deviceId', v: id });
    return id;
  });
}

export interface CycleResult {
  pushed: number;
  pulled: number;
}

/** Um ciclo completo (varrer → enviar → baixar). Lança ApiClientError em falha de rede/sessão. */
export async function runSyncCycle(d: AccountDB, t: SyncTransport, signal?: AbortSignal): Promise<CycleResult> {
  await scanLocalChanges(d);
  let pushed = 0;
  // Envia o que está pendente (inclusive mesclagens automáticas geradas no meio), com limite de voltas.
  for (let round = 0; round < 5; round++) {
    const pending = await d.syncOutbox.where('state').equals('pending').toArray();
    if (!pending.length) break;
    pending.sort((a, b) => a.createdAt - b.createdAt);
    for (const group of batches(pending)) {
      await d.transaction('rw', d.syncOutbox, async () => {
        for (const e of group) {
          const cur = await d.syncOutbox.get(e.opId);
          if (cur) await d.syncOutbox.put({ ...cur, attempts: cur.attempts + 1 });
        }
      });
      const res = await t.push(group.map(toOp), signal);
      await applyResults(d, group, res);
      pushed += group.length;
    }
  }
  let pulled = 0;
  let cursor = (await kvGet<string>(d, 'cursor')) ?? '0';
  for (let page = 0; page < 1000; page++) {
    const res = await t.pull(cursor, signal);
    if (res.reset) {
      // Cursor à frente do servidor (ex.: banco restaurado): recomeça do zero; nada local é apagado por isso.
      cursor = '0';
      await d.syncKv.put({ k: 'cursor', v: '0' });
      continue;
    }
    await applyPull(d, res);
    pulled += res.changes.length;
    cursor = res.cursor;
    await d.syncKv.put({ k: 'cursor', v: cursor });
    if (!res.hasMore) break;
  }
  await d.syncKv.put({ k: 'lastSyncAt', v: Date.now() });
  return { pushed, pulled };
}

// ---------------------------------------------------------------- resolução manual de conflitos

export interface ConflictView {
  key: string;
  collection: SyncCollection;
  entityId: string;
  local: Doc | null;
  server: Doc | null;
  serverVersion: number;
  paths: string[];
}

export async function listConflicts(d: AccountDB): Promise<ConflictView[]> {
  const rows = await d.syncOutbox.where('state').equals('conflict').toArray();
  return rows.map((e) => ({
    key: e.key,
    collection: e.collection,
    entityId: e.entityId,
    local: e.kind === 'put' ? (e.doc ?? null) : null,
    server: e.server && !e.server.deleted ? e.server.doc : null,
    serverVersion: e.server?.version ?? 0,
    paths: e.conflictPaths ?? [],
  }));
}

export type Resolution = 'keep_local' | 'use_server' | 'keep_both';

/** Coleções em que "manter os dois" faz sentido (cópia com outro ID, sem conflito de identidade). */
export const KEEP_BOTH: readonly SyncCollection[] = ['sessions', 'routines', 'bodyEntries', 'goals', 'customExercises'];

/**
 * Resolve um conflito por decisão explícita. A versão substituída no servidor fica guardada (`record_revisions`) e a
 * versão do servidor substituída neste aparelho continua disponível pela exportação da conta até o próximo envio.
 */
export async function resolveConflict(d: AccountDB, key: string, how: Resolution): Promise<void> {
  await d.transaction('rw', tablesFor(d), async () => {
    const e = await d.syncOutbox.where('key').equals(key).first();
    if (!e || e.state !== 'conflict' || !e.server) return;
    const server = e.server;
    const serverDoc = server.deleted ? null : server.doc;
    if (how === 'keep_local') {
      await d.syncOutbox.delete(e.opId);
      await d.syncOutbox.put({ ...e, opId: newOpId(), baseVersion: server.version, reason: 'conflict_resolution', state: 'pending', attempts: 0, server: undefined, conflictPaths: undefined });
      return;
    }
    if (how === 'keep_both') {
      if (!KEEP_BOTH.includes(e.collection) || !e.doc) throw new Error('Este tipo de registro não pode ser duplicado.');
      const copy = { ...e.doc, id: newOpId() } as Doc;
      if (e.collection === 'sessions' && typeof copy.status === 'string' && copy.status === 'active') copy.status = 'completed';
      await d.table(e.collection).add(copy);
    }
    // use_server (e o original de keep_both): o aparelho passa a ter a versão do servidor.
    await writeLocal(d, e.collection, e.entityId, serverDoc);
    if (serverDoc) await d.syncMeta.put({ key, collection: e.collection, entityId: e.entityId, version: server.version, baseJson: canonicalJson(serverDoc) });
    else await d.syncMeta.delete(key);
    await d.syncOutbox.delete(e.opId);
  });
}

/** Descarta um registro recusado pelo servidor: o aparelho volta à última versão confirmada. */
export async function discardRejected(d: AccountDB, key: string): Promise<void> {
  await d.transaction('rw', tablesFor(d), async () => {
    const e = await d.syncOutbox.where('key').equals(key).first();
    if (!e || e.state !== 'rejected') return;
    const meta = await d.syncMeta.get(key);
    await writeLocal(d, e.collection, e.entityId, meta ? (JSON.parse(meta.baseJson) as Doc) : null);
    await d.syncOutbox.delete(e.opId);
  });
}

/** Tenta de novo um registro recusado (ex.: depois de corrigir os dados). */
export async function retryRejected(d: AccountDB, key: string): Promise<void> {
  const e = await d.syncOutbox.where('key').equals(key).first();
  if (e?.state === 'rejected') await d.syncOutbox.put({ ...e, state: 'pending', error: undefined, attempts: 0 });
}

// ---------------------------------------------------------------- agendamento e estado observável

export interface EngineOptions {
  /** Atraso depois de uma alteração local (agrupa gravações seguidas). */
  debounceMs?: number;
  /** Intervalo de verificação de mudanças de outros aparelhos. */
  pollMs?: number;
  onAuthRequired?: () => void;
}

const BACKOFF = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

export class SyncEngine {
  readonly db: AccountDB;
  private readonly transport: SyncTransport;
  private readonly opts: Required<Omit<EngineOptions, 'onAuthRequired'>> & Pick<EngineOptions, 'onAuthRequired'>;
  private status: SyncStatus = { state: 'pending', pending: 0, conflicts: 0, rejected: 0, lastSyncAt: null, error: null, retryAt: null };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private dirty = true;
  private failures = 0;
  private stopped = false;
  private ctrl: AbortController | null = null;
  private cleanup: (() => void)[] = [];

  constructor(db: AccountDB, transport: SyncTransport, opts: EngineOptions = {}) {
    this.db = db;
    this.transport = transport;
    this.opts = { debounceMs: opts.debounceMs ?? 1500, pollMs: opts.pollMs ?? 60_000, onAuthRequired: opts.onAuthRequired };
  }

  getStatus = (): SyncStatus => this.status;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(next: Partial<SyncStatus>) {
    this.status = { ...this.status, ...next };
    this.listeners.forEach((l) => l());
  }

  /** Começa a observar alterações locais, a conexão e a visibilidade da página. */
  start(): void {
    const onMutated = (parts: Record<string, unknown>) => {
      // Só reage a alterações deste banco nas tabelas de dados (não às do próprio motor).
      const prefix = `idb://${this.db.name}/`;
      const touched = Object.keys(parts).some((k) => k.startsWith(prefix) && SYNC_COLLECTIONS.some((c) => k.startsWith(`${prefix}${c}/`)));
      if (!touched) return;
      this.dirty = true;
      if (this.status.state === 'synced') this.set({ state: 'pending' });
      this.schedule(this.opts.debounceMs);
    };
    Dexie.on('storagemutated', onMutated);
    this.cleanup.push(() => Dexie.on('storagemutated').unsubscribe(onMutated));
    const onOnline = () => this.schedule(0);
    const onOffline = () => void this.scanOffline();
    const onVisible = () => {
      if (document.visibilityState === 'visible') this.schedule(0);
    };
    globalThis.addEventListener?.('online', onOnline);
    globalThis.addEventListener?.('offline', onOffline);
    globalThis.document?.addEventListener?.('visibilitychange', onVisible);
    this.cleanup.push(() => {
      globalThis.removeEventListener?.('online', onOnline);
      globalThis.removeEventListener?.('offline', onOffline);
      globalThis.document?.removeEventListener?.('visibilitychange', onVisible);
    });
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ctrl?.abort();
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
  }

  /** Pede uma sincronização agora (botão "Sincronizar agora" ou depois de resolver conflito). */
  syncNow(): Promise<void> {
    this.failures = 0;
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.run();
  }

  /** Depois de entrar de novo (sessão expirada), retoma. */
  resume(): void {
    this.failures = 0;
    this.schedule(0);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }

  private run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.cycle();
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async cycle(): Promise<void> {
    if (this.stopped) return;
    if (globalThis.navigator && navigator.onLine === false) {
      await this.scanOffline();
      return;
    }
    this.set({ state: 'syncing', error: null });
    this.dirty = false;
    this.ctrl = new AbortController();
    const work = () => runSyncCycle(this.db, this.transport, this.ctrl!.signal);
    try {
      // Várias abas: um ciclo por vez (Web Locks quando houver).
      const locks = (globalThis.navigator as Navigator | undefined)?.locks;
      if (locks?.request) await locks.request(`irontrack-sync-${this.db.accountId}`, work);
      else await work();
      this.failures = 0;
      const lastSyncAt = Date.now();
      await this.refreshCounts(null, lastSyncAt);
      if (!this.stopped) this.schedule(this.dirty ? this.opts.debounceMs : this.opts.pollMs);
    } catch (e) {
      await this.handleError(e);
    } finally {
      this.ctrl = null;
    }
  }

  /** Offline: só a varredura local, para a fila (e o aviso ao sair) contar o que ainda não subiu. */
  private async scanOffline() {
    try {
      await scanLocalChanges(this.db);
      this.dirty = false;
    } catch {
      /* banco fechado (troca de conta): a próxima varredura conta */
    }
    await this.refreshCounts('offline');
  }

  private async handleError(e: unknown) {
    if (this.stopped) return;
    if (isAuthError(e)) {
      await this.refreshCounts('auth_required', undefined, 'Sua sessão expirou. Entre de novo para continuar sincronizando; nada deste aparelho foi perdido.');
      this.opts.onAuthRequired?.();
      return; // retoma com resume() depois do login
    }
    if (e instanceof ApiClientError && e.code === 'account_mismatch') {
      await this.refreshCounts('account_mismatch', undefined, e.message);
      return;
    }
    const delay = BACKOFF[Math.min(this.failures, BACKOFF.length - 1)];
    this.failures++;
    const jitter = Math.round(delay * 0.2 * Math.random());
    const offline = isNetworkError(e) || (globalThis.navigator && navigator.onLine === false);
    const msg = e instanceof ApiClientError ? e.message : 'Falha inesperada ao sincronizar.';
    await this.refreshCounts(offline ? 'offline' : 'error', undefined, msg, Date.now() + delay + jitter);
    this.schedule(delay + jitter);
  }

  /** Recalcula os contadores e decide o estado mostrado. `forced` = estado de erro/rede/sessão. */
  private async refreshCounts(forced: SyncState | null, lastSyncAt?: number, error: string | null = null, retryAt: number | null = null) {
    let pending = 0;
    let conflicts = 0;
    let rejected = 0;
    try {
      [pending, conflicts, rejected] = await Promise.all([
        this.db.syncOutbox.where('state').equals('pending').count(),
        this.db.syncOutbox.where('state').equals('conflict').count(),
        this.db.syncOutbox.where('state').equals('rejected').count(),
      ]);
    } catch {
      /* banco fechado (troca de conta) */
    }
    let state: SyncState;
    if (forced) state = forced;
    else if (conflicts) state = 'conflict';
    else if (rejected) state = 'error';
    else if (pending || this.dirty) state = 'pending';
    else state = 'synced';
    this.set({ state, pending, conflicts, rejected, error: forced ? error : rejected ? 'Alguns registros foram recusados pelo servidor.' : null, retryAt, ...(lastSyncAt ? { lastSyncAt } : {}) });
  }
}

// ---------------------------------------------------------------- instância do app

let engine: SyncEngine | null = null;
export const setSyncEngine = (e: SyncEngine | null) => {
  engine = e;
  engineListeners.forEach((l) => l());
};
export const getSyncEngine = () => engine;
const engineListeners = new Set<() => void>();

/** Estado da sincronização para a interface (null fora do modo conta). */
export function useSyncStatus(): SyncStatus | null {
  return useSyncExternalStore(
    (l) => {
      engineListeners.add(l);
      const un = engine?.subscribe(l);
      return () => {
        engineListeners.delete(l);
        un?.();
      };
    },
    () => (engine ? engine.getStatus() : null),
    () => null,
  );
}
