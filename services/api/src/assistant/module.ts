// Rotas do Assistente IA central (Fase 00): /api/v1/assistant/*. Acesso só pela sessão da conta; a chave da OpenAI
// fica no servidor (OPENAI_API_KEY) e nunca aparece numa resposta ou log. Ver docs/IA_CENTRAL.md.
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { GatewayError, isGatewayError, type GatewayErrorCode } from '../../../ai-gateway/src/errors.ts';
import {
  ASSISTANT_ERROR_MESSAGES,
  ASSISTANT_NOTICE_VERSION,
  ASSISTANT_PROTOCOL,
  UNDO_WINDOW_HOURS,
  MAX_MEMORY_CHARS,
  MAX_MEMORIES,
  MAX_TITLE_CHARS,
  MAX_USER_MESSAGE_CHARS,
  sendMessageSchema,
  type AssistantAvailability,
  type AssistantStatusView,
  type StreamEvent,
} from '../../../../shared/assistant/protocol.ts';
import type { ApiConfig } from '../config.ts';
import { withTx, type Pool } from '../db/pool.ts';
import { ApiError, isApiError, readJson, type RequestCtx, type Router } from '../http/core.ts';
import type { Logger } from '../lib/log.ts';
import { loadAssistantConfig, openAiKeyFormatOk, type AssistantConfig } from './config.ts';
import { runTurn, summarize, utcDay, type EngineDeps } from './engine.ts';
import { openAiProvider } from './providers/openai.ts';
import type { ChatProvider, FetchLike } from './providers/types.ts';
import * as S from './store.ts';
import { ACTION_HANDLERS, MODULES } from './tools/registry.ts';
import { isValidTimezone } from './tools/time.ts';
import { ToolError } from './tools/types.ts';
import { StaleError } from './tools/training.ts';

export interface AssistantDeps {
  cfg: ApiConfig;
  pool: Pool;
  log: Logger;
  env: Record<string, string | undefined>;
  fetch?: FetchLike;
  provider?: ChatProvider;
  now?: () => number;
}

export interface AssistantModule {
  register(router: Router): void;
  describe(): string[];
  available(): boolean;
}

type Health = 'unverified' | 'ok' | 'auth_failed' | 'forbidden' | 'billing' | 'rate_limited' | 'network';
const HEALTH_OF: Partial<Record<GatewayErrorCode, Health>> = {
  provider_auth_failed: 'auth_failed',
  provider_forbidden: 'forbidden',
  provider_billing: 'billing',
  provider_rate_limited: 'rate_limited',
  provider_unreachable: 'network',
};

/** Erro do assistente em JSON (antes de o streaming começar). */
const fail = (code: string, status: number, headers?: Record<string, string>) => ({ status, body: { error: { code, message: ASSISTANT_ERROR_MESSAGES[code] ?? ASSISTANT_ERROR_MESSAGES.internal_error } }, ...(headers ? { headers } : {}) });

const DEFAULT_TZ = 'America/Sao_Paulo';

export function createAssistantModule(d: AssistantDeps): AssistantModule {
  const loaded = loadAssistantConfig(d.env);
  const config: AssistantConfig | null = loaded.config;
  const now = d.now ?? Date.now;
  const provider = d.provider ?? openAiProvider;
  const fetchFn: FetchLike = d.fetch ?? ((url, init) => fetch(url, init));
  const inFlight = new Map<string, number>();
  let total = 0;
  let health: { status: Health; at: string } | null = null;
  const modelHealth = new Map<string, 'ok' | 'unavailable'>();

  const rawKey = () => {
    const v = config ? d.env[config.apiKeyEnv] : undefined;
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const availability = (): AssistantAvailability => {
    if (!config || !config.enabled) return 'disabled';
    const k = rawKey();
    if (!k) return 'missing_key';
    if (!openAiKeyFormatOk(k)) return 'invalid_key_format';
    if (health?.status === 'auth_failed') return 'auth_failed';
    return 'ok';
  };
  const record = (outcome: 'ok' | GatewayErrorCode, model: string, source: 'turn' | 'test') => {
    const at = new Date(now()).toISOString();
    if (outcome === 'ok') {
      // O teste sem custo não confere créditos.
      if (!(source === 'test' && health?.status === 'billing')) health = { status: 'ok', at };
      modelHealth.set(model, 'ok');
    } else if (outcome === 'model_unavailable') modelHealth.set(model, 'unavailable');
    else if (HEALTH_OF[outcome]) health = { status: HEALTH_OF[outcome]!, at };
  };
  const leaks = (text: string) => {
    const k = rawKey();
    return !!k && text.includes(k);
  };

  async function settings(userId: string) {
    const r = await d.pool.query<{ notice_version: number | null; notice_accepted_at: Date | null }>('SELECT notice_version, notice_accepted_at FROM assistant_settings WHERE user_id = $1', [userId]);
    return r.rows[0] ?? null;
  }

  async function statusView(ctx: RequestCtx): Promise<AssistantStatusView> {
    const a = ctx.auth!;
    const s = await settings(a.userId);
    let av = availability();
    if (av === 'ok' && d.cfg.ai.requireVerifiedEmail && !a.emailVerified) av = 'email_not_verified';
    const usage = await S.usageOf(d.pool, a.userId, utcDay(now()));
    return {
      protocol: ASSISTANT_PROTOCOL,
      availability: av,
      provider: config ? { id: config.provider, displayName: config.displayName, health: availability() === 'ok' ? (health?.status ?? 'unverified') : availability(), checkedAt: health?.at ?? null } : null,
      models: config ? config.models.filter((m) => modelHealth.get(m.id) !== 'unavailable').map((m) => ({ id: m.id, displayName: m.displayName, description: m.description })) : [],
      defaultModel: config?.defaultModel ?? null,
      notice: { version: ASSISTANT_NOTICE_VERSION, acceptedVersion: s?.notice_version ?? null, acceptedAt: s?.notice_accepted_at?.toISOString() ?? null },
      limits: { messagesPerDay: config?.limits.messagesPerDay ?? 0, tokensPerDay: config?.limits.tokensPerDay ?? 0, messagesPerMinute: config?.limits.messagesPerMinute ?? 0, maxMessageChars: MAX_USER_MESSAGE_CHARS },
      usage: { day: utcDay(now()), messages: usage.messages, tokens: usage.tokens },
      modules: MODULES.filter((m) => m.id !== 'assistant_memory').map((m) => ({ id: m.id, name: m.name, status: m.status })),
    };
  }

  async function bodyOf(ctx: RequestCtx, max: number): Promise<Record<string, unknown>> {
    const b = await readJson(ctx, max);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ApiError('bad_request');
    return b as Record<string, unknown>;
  }

  /** POST /api/v1/assistant/conversations/:id/messages (id = "new" cria a conversa). Resposta em text/event-stream. */
  async function send(ctx: RequestCtx) {
    const a = ctx.auth!;
    if (!config || !config.enabled) return fail('assistant_disabled', 503);
    if (d.cfg.ai.requireVerifiedEmail && !a.emailVerified) return fail('email_not_verified', 403);
    const av = availability();
    if (av !== 'ok') return fail(av === 'auth_failed' ? 'provider_auth_failed' : 'provider_unavailable', 503);
    const parsed = sendMessageSchema.safeParse(await bodyOf(ctx, 64 * 1024));
    if (!parsed.success) return fail('message_too_long', 400);
    const content = parsed.data.content.trim();
    if (!content) return fail('message_empty', 400);
    if (content.length > MAX_USER_MESSAGE_CHARS) return fail('message_too_long', 400);
    const model = config.models.find((m) => m.id === (parsed.data.model ?? config.defaultModel));
    if (!model) return fail('model_not_allowed', 400);
    const s = await settings(a.userId);
    if ((s?.notice_version ?? 0) < ASSISTANT_NOTICE_VERSION) return fail('notice_required', 409);
    const timezone = isValidTimezone(parsed.data.timezone) ? parsed.data.timezone : DEFAULT_TZ;

    let conv = ctx.params.id === 'new' ? null : await S.getConversation(d.pool, a.userId, ctx.params.id);
    if (ctx.params.id !== 'new' && !conv) return fail('not_found', 404);

    // Limites: por minuto, simultaneidade (processo) e por dia (PostgreSQL).
    const lim = config.limits;
    const rpm = await d.pool.query<{ count: number }>(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, now(), 1)
       ON CONFLICT (bucket) DO UPDATE SET
         window_start = CASE WHEN rate_limits.window_start <= now() - interval '60 seconds' THEN now() ELSE rate_limits.window_start END,
         count = CASE WHEN rate_limits.window_start <= now() - interval '60 seconds' THEN 1 ELSE rate_limits.count + 1 END
       RETURNING count`,
      [`assistant-rpm:${a.userId}`],
    );
    if ((rpm.rows[0]?.count ?? 1) > lim.messagesPerMinute) return fail('rate_limited', 429, { 'retry-after': '60' });
    if ((inFlight.get(a.userId) ?? 0) >= lim.maxConcurrentPerUser) return fail('busy', 409);
    if (total >= lim.maxConcurrentTotal) return fail('rate_limited', 429, { 'retry-after': '10' });
    if (!(await S.countMessage(d.pool, a.userId, utcDay(now()), lim.messagesPerDay))) return fail('daily_limit', 429);

    inFlight.set(a.userId, (inFlight.get(a.userId) ?? 0) + 1);
    total++;
    const res = ctx.res;
    const started = now();
    try {
      let created = false;
      if (!conv) {
        conv = await S.createConversation(d.pool, a.userId, autoTitle(content));
        created = true;
      }
      const userMsg = await S.insertMessage(d.pool, { userId: a.userId, conversationId: conv.id, role: 'user', content });
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders();
      const emit = (ev: StreamEvent) => writeEvent(res, ev, leaks);
      emit({ type: 'start', conversationId: conv.id, userMessage: S.msgView(userMsg), title: conv.title, created });

      const turnCtrl = new AbortController();
      const onAbort = () => turnCtrl.abort(new GatewayError('cancelled'));
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      const turnTimer = setTimeout(() => turnCtrl.abort(new GatewayError('timeout')), lim.turnTimeoutMs);
      const deps: EngineDeps = { pool: d.pool, cfg: config, provider, fetch: fetchFn, apiKey: rawKey()!, now, log: d.log };
      let out;
      try {
        out = await runTurn(deps, { userId: a.userId, dataProfileId: a.dataProfileId, conversationId: conv.id, summary: conv.summary, model, timezone, signal: turnCtrl.signal, emit }, Number(conv.summary_upto));
      } finally {
        clearTimeout(turnTimer);
        ctx.signal.removeEventListener('abort', onAbort);
      }
      if (out.providerOutcome) record(out.providerOutcome, model.id, 'turn');
      const saved = (await S.messages(d.pool, a.userId, conv.id, Number(userMsg.seq))).find((m) => m.id === out.messageId);
      if (out.status === 'complete') emit({ type: 'done', message: S.msgView(saved!), usage: out.usage });
      else {
        const code = out.code ?? 'internal_error';
        emit({ type: 'error', code, message: ASSISTANT_ERROR_MESSAGES[code] ?? ASSISTANT_ERROR_MESSAGES.internal_error, message_id: out.messageId });
      }
      if (!res.writableEnded) res.end();
      d.log.event('assistant.turn', { model: model.id, status: out.status, code: out.code ?? '', in: out.usage.inputTokens, out: out.usage.outputTokens, ms: now() - started });
      void maybeSummarize(deps, a.userId, conv.id);
      return { status: 200 };
    } catch (e) {
      d.log.error('assistant.send', e);
      if (res.headersSent) {
        writeEvent(res, { type: 'error', code: 'internal_error', message: ASSISTANT_ERROR_MESSAGES.internal_error }, leaks);
        if (!res.writableEnded) res.end();
        return { status: 200 };
      }
      return fail('internal_error', 500);
    } finally {
      const n = (inFlight.get(a.userId) ?? 1) - 1;
      if (n <= 0) inFlight.delete(a.userId);
      else inFlight.set(a.userId, n);
      total--;
    }
  }

  async function maybeSummarize(deps: EngineDeps, userId: string, conversationId: string) {
    try {
      const conv = await S.getConversation(d.pool, userId, conversationId);
      if (!conv || !config) return;
      const rows = await S.messages(d.pool, userId, conversationId, Number(conv.summary_upto));
      const keep = config.limits.historyMessages;
      if (rows.length < config.limits.summarizeAfterMessages) return;
      const older = rows.slice(0, rows.length - keep);
      const r = await summarize(deps, userId, conv.summary, older);
      if (r) await d.pool.query('UPDATE assistant_conversations SET summary = $3, summary_upto = $4 WHERE user_id = $1 AND id = $2 AND summary_upto < $4', [userId, conversationId, r.summary, r.upto]);
    } catch (e) {
      d.log.error('assistant.summary', e);
    }
  }

  /** Aprovação: revalida dono, estado, prazo e versão do registro; aplica numa transação e registra o resultado. */
  async function decide(ctx: RequestCtx, approve: boolean) {
    const a = ctx.auth!;
    const result = await withTx(d.pool, async (c) => {
      const row = await S.getAction(c, a.userId, ctx.params.id, true);
      if (!row) return { err: fail('not_found', 404) };
      if (row.status !== 'pending' || row.expires_at.getTime() <= now()) {
        if (row.status === 'pending') await c.query("UPDATE assistant_actions SET status = 'expired', decided_at = now() WHERE id = $1", [row.id]);
        return { err: fail('action_not_pending', 409) };
      }
      if (!approve) {
        await c.query("UPDATE assistant_actions SET status = 'rejected', decided_at = now() WHERE id = $1", [row.id]);
        if (row.conversation_id) await S.insertMessage(c, { userId: a.userId, conversationId: row.conversation_id, role: 'event', content: `A pessoa cancelou a proposta "${row.title}". Nada foi alterado.` });
        return { row: (await S.getAction(c, a.userId, row.id))! };
      }
      const handler = ACTION_HANDLERS.get(row.kind);
      if (!handler) return { err: fail('action_invalid', 422) };
      await c.query('SAVEPOINT apply');
      try {
        const applied = await handler.apply(c, { pool: d.pool, userId: a.userId, dataProfileId: a.dataProfileId, timezone: DEFAULT_TZ, now: now() }, { id: row.id, kind: row.kind, payload: row.payload, targetId: row.target_id, baseVersion: row.base_version });
        await c.query('RELEASE SAVEPOINT apply');
        await c.query("UPDATE assistant_actions SET status = 'applied', decided_at = now(), result = $2, undo_data = $3 WHERE id = $1", [row.id, JSON.stringify({ collection: applied.collection, entityId: applied.entityId }), applied.undo === undefined || !handler.undo ? null : JSON.stringify(applied.undo)]);
        if (row.conversation_id) await S.insertMessage(c, { userId: a.userId, conversationId: row.conversation_id, role: 'event', content: `A pessoa aprovou e o app aplicou: ${applied.summary}` });
        return { row: (await S.getAction(c, a.userId, row.id))! };
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT apply');
        const code = e instanceof StaleError ? 'action_stale' : e instanceof ToolError && e.code === 'memory_limit' ? 'memory_limit' : e instanceof ToolError || isZod(e) || isRecordError(e) || isApiError(e) ? 'action_invalid' : null;
        if (!code) throw e;
        await c.query("UPDATE assistant_actions SET status = 'failed', decided_at = now(), error = $2 WHERE id = $1", [row.id, ASSISTANT_ERROR_MESSAGES[code]]);
        return { err: fail(code, code === 'action_stale' ? 409 : 422) };
      }
    });
    if ('err' in result) return result.err!;
    return { status: 200, body: { action: S.actionView(result.row, now()) } };
  }

  /** Desfazer (Fase 01): só propostas aplicadas, dentro do prazo, com handler e sem mudanças posteriores no item. */
  async function undo(ctx: RequestCtx) {
    const a = ctx.auth!;
    const result = await withTx(d.pool, async (c) => {
      const row = await S.getAction(c, a.userId, ctx.params.id, true);
      if (!row) return { err: fail('not_found', 404) };
      const handler = ACTION_HANDLERS.get(row.kind);
      if (row.status !== 'applied' || row.undo_data == null || !handler?.undo || !row.decided_at || now() - row.decided_at.getTime() >= UNDO_WINDOW_HOURS * 3_600_000) return { err: fail('action_not_undoable', 409) };
      await c.query('SAVEPOINT undo');
      try {
        const r = await handler.undo(c, { pool: d.pool, userId: a.userId, dataProfileId: a.dataProfileId, timezone: DEFAULT_TZ, now: now() }, { id: row.id, kind: row.kind, payload: row.payload, targetId: row.target_id, baseVersion: row.base_version }, row.undo_data);
        await c.query('RELEASE SAVEPOINT undo');
        await c.query("UPDATE assistant_actions SET status = 'reverted', reverted_at = now() WHERE id = $1", [row.id]);
        if (row.conversation_id) await S.insertMessage(c, { userId: a.userId, conversationId: row.conversation_id, role: 'event', content: `A pessoa desfez a alteração "${row.title}". ${r.summary}` });
        return { row: (await S.getAction(c, a.userId, row.id))! };
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT undo');
        if (e instanceof StaleError) return { err: fail('action_undo_stale', 409) };
        if (e instanceof ToolError && e.code === 'action_undo_blocked') return { err: fail('action_undo_blocked', 409) };
        if (e instanceof ToolError || isApiError(e) || isZod(e) || isRecordError(e)) return { err: fail('action_not_undoable', 409) };
        throw e;
      }
    });
    if ('err' in result) return result.err!;
    return { status: 200, body: { action: S.actionView(result.row, now()) } };
  }

  async function test(ctx: RequestCtx) {
    const a = ctx.auth!;
    if (!config || !config.enabled) return fail('assistant_disabled', 503);
    const av = availability();
    if (av === 'missing_key' || av === 'invalid_key_format') return { status: 200, body: { result: 'provider_unavailable', availability: av, paid: false } };
    const b = await bodyOf(ctx, 1024);
    const model = config.models.find((m) => m.id === (b.model ?? config.defaultModel));
    if (!model) return fail('model_not_allowed', 400);
    const n = await d.pool.query<{ count: number }>(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, now(), 1)
       ON CONFLICT (bucket) DO UPDATE SET window_start = CASE WHEN rate_limits.window_start <= now() - interval '60 seconds' THEN now() ELSE rate_limits.window_start END,
         count = CASE WHEN rate_limits.window_start <= now() - interval '60 seconds' THEN 1 ELSE rate_limits.count + 1 END RETURNING count`,
      [`assistant-test:${a.userId}`],
    );
    if ((n.rows[0]?.count ?? 1) > 5) return fail('rate_limited', 429, { 'retry-after': '60' });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    let outcome: 'ok' | GatewayErrorCode = 'ok';
    try {
      await provider.check(model.id, { apiKey: rawKey()!, fetch: fetchFn, signal: ctrl.signal, baseUrl: config.baseUrl ?? provider.defaultBaseUrl, maxResponseBytes: 65_536 });
    } catch (e) {
      outcome = ctrl.signal.aborted ? 'timeout' : isGatewayError(e) ? e.code : 'internal_error';
    } finally {
      clearTimeout(timer);
    }
    record(outcome, model.id, 'test');
    return { status: 200, body: { result: outcome, model: model.id, health: health?.status ?? 'unverified', paid: false } };
  }

  return {
    available: () => availability() === 'ok',
    describe() {
      if (loaded.errors.length) return [`Assistente: configuração inválida (${loaded.errors.join('; ')}).`];
      if (!config || !config.enabled) return ['Assistente: desativado.'];
      const av = availability();
      const what =
        av === 'missing_key'
          ? `variável ${config.apiKeyEnv} AUSENTE neste serviço (configure-a no irontrack-api e implante)`
          : av === 'invalid_key_format'
            ? `variável ${config.apiKeyEnv} presente, mas o valor não tem o formato de uma chave de API da OpenAI (sk-…)`
            : `chave em ${config.apiKeyEnv} configurada; ainda não validada (use "Testar" no app)`;
      return [`Assistente: ${config.displayName} — ${what}; modelos: ${config.models.map((m) => m.id).join(', ')}.`];
    },
    register(router) {
      const P = '/api/v1/assistant';
      router.add({ method: 'GET', path: `${P}/status`, auth: 'session', handler: async (ctx) => ({ status: 200, body: await statusView(ctx) }) });
      router.add({
        method: 'POST',
        path: `${P}/notice`,
        auth: 'session',
        handler: async (ctx) => {
          const b = await bodyOf(ctx, 256);
          if (b.version !== ASSISTANT_NOTICE_VERSION) throw new ApiError('bad_request');
          await d.pool.query(
            'INSERT INTO assistant_settings (user_id, notice_version, notice_accepted_at) VALUES ($1, $2, now()) ON CONFLICT (user_id) DO UPDATE SET notice_version = $2, notice_accepted_at = now(), updated_at = now()',
            [ctx.auth!.userId, ASSISTANT_NOTICE_VERSION],
          );
          return { status: 200, body: await statusView(ctx) };
        },
      });
      router.add({ method: 'POST', path: `${P}/test`, auth: 'session', handler: test });
      router.add({ method: 'GET', path: `${P}/conversations`, auth: 'session', handler: async (ctx) => ({ status: 200, body: { conversations: await S.listConversations(d.pool, ctx.auth!.userId) } }) });
      router.add({ method: 'DELETE', path: `${P}/conversations`, auth: 'session', handler: async (ctx) => {
        const r = await d.pool.query('DELETE FROM assistant_conversations WHERE user_id = $1', [ctx.auth!.userId]);
        await d.pool.query("UPDATE assistant_actions SET status = 'expired', decided_at = now() WHERE user_id = $1 AND status = 'pending'", [ctx.auth!.userId]);
        return { status: 200, body: { deleted: r.rowCount ?? 0 } };
      } });
      router.add({
        method: 'GET',
        path: `${P}/conversations/:id`,
        auth: 'session',
        handler: async (ctx) => {
          const u = ctx.auth!.userId;
          const c = await S.getConversation(d.pool, u, ctx.params.id);
          if (!c) return fail('not_found', 404);
          const [msgs, acts] = await Promise.all([S.messages(d.pool, u, c.id), S.conversationActions(d.pool, u, c.id)]);
          return { status: 200, body: { conversation: { ...S.convView({ ...c, message_count: msgs.length }), summary: c.summary, messages: msgs.map(S.msgView), actions: acts.map((x) => S.actionView(x, now())) } } };
        },
      });
      router.add({
        method: 'PATCH',
        path: `${P}/conversations/:id`,
        auth: 'session',
        handler: async (ctx) => {
          const b = await bodyOf(ctx, 1024);
          const title = typeof b.title === 'string' ? b.title.replace(/\s+/g, ' ').trim() : '';
          if (!title || title.length > MAX_TITLE_CHARS) throw new ApiError('validation_failed', { title: `Use de 1 a ${MAX_TITLE_CHARS} caracteres.` });
          if (!S.isUuid(ctx.params.id)) return fail('not_found', 404);
          const r = await d.pool.query("UPDATE assistant_conversations SET title = $3, title_source = 'user' WHERE user_id = $1 AND id = $2", [ctx.auth!.userId, ctx.params.id, title]);
          return r.rowCount ? { status: 200, body: { title } } : fail('not_found', 404);
        },
      });
      router.add({
        method: 'DELETE',
        path: `${P}/conversations/:id`,
        auth: 'session',
        handler: async (ctx) => {
          if (!S.isUuid(ctx.params.id)) return fail('not_found', 404);
          const r = await d.pool.query('DELETE FROM assistant_conversations WHERE user_id = $1 AND id = $2', [ctx.auth!.userId, ctx.params.id]);
          return r.rowCount ? { status: 204 } : fail('not_found', 404);
        },
      });
      // O streaming tem tempo próprio (turnTimeoutMs); o limite geral da requisição fica acima dele.
      router.add({ method: 'POST', path: `${P}/conversations/:id/messages`, auth: 'session', maxBody: 64 * 1024, timeoutMs: (config?.limits.turnTimeoutMs ?? 80_000) + 10_000, handler: send });
      router.add({ method: 'GET', path: `${P}/actions/:id`, auth: 'session', handler: async (ctx) => {
        const r = await S.getAction(d.pool, ctx.auth!.userId, ctx.params.id);
        return r ? { status: 200, body: { action: S.actionView(r, now()) } } : fail('not_found', 404);
      } });
      router.add({ method: 'POST', path: `${P}/actions/:id/approve`, auth: 'session', handler: (ctx) => decide(ctx, true) });
      router.add({ method: 'POST', path: `${P}/actions/:id/reject`, auth: 'session', handler: (ctx) => decide(ctx, false) });
      router.add({ method: 'POST', path: `${P}/actions/:id/undo`, auth: 'session', handler: undo });
      router.add({ method: 'GET', path: `${P}/memories`, auth: 'session', handler: async (ctx) => ({ status: 200, body: { memories: await S.listMemories(d.pool, ctx.auth!.userId), max: MAX_MEMORIES } }) });
      router.add({
        method: 'POST',
        path: `${P}/memories`,
        auth: 'session',
        handler: async (ctx) => {
          const b = await bodyOf(ctx, 2048);
          const content = typeof b.content === 'string' ? b.content.replace(/\s+/g, ' ').trim() : '';
          if (!content || content.length > MAX_MEMORY_CHARS) throw new ApiError('validation_failed', { content: `Use de 1 a ${MAX_MEMORY_CHARS} caracteres.` });
          const u = ctx.auth!.userId;
          const n = await d.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM assistant_memories WHERE user_id = $1', [u]);
          if ((n.rows[0]?.n ?? 0) >= MAX_MEMORIES) return fail('memory_limit', 409);
          await d.pool.query("INSERT INTO assistant_memories (id, user_id, content, source) VALUES ($1, $2, $3, 'user')", [randomUUID(), u, content]);
          return { status: 201, body: { memories: await S.listMemories(d.pool, u) } };
        },
      });
      router.add({ method: 'DELETE', path: `${P}/memories`, auth: 'session', handler: async (ctx) => {
        const r = await d.pool.query('DELETE FROM assistant_memories WHERE user_id = $1', [ctx.auth!.userId]);
        return { status: 200, body: { deleted: r.rowCount ?? 0 } };
      } });
      router.add({ method: 'DELETE', path: `${P}/memories/:id`, auth: 'session', handler: async (ctx) => {
        if (!S.isUuid(ctx.params.id)) return fail('not_found', 404);
        const r = await d.pool.query('DELETE FROM assistant_memories WHERE user_id = $1 AND id = $2', [ctx.auth!.userId, ctx.params.id]);
        return r.rowCount ? { status: 204 } : fail('not_found', 404);
      } });
    },
  };
}

const isZod = (e: unknown) => !!e && typeof e === 'object' && (e as { name?: string }).name === 'ZodError';
const isRecordError = (e: unknown) => !!e && typeof e === 'object' && (e as { name?: string }).name === 'RecordError';

export function autoTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= 60 ? t : `${t.slice(0, 57).trimEnd()}…`;
}

function writeEvent(res: ServerResponse, ev: StreamEvent, leaks: (s: string) => boolean): void {
  if (res.writableEnded || res.destroyed) return;
  let data = JSON.stringify(ev);
  // Nenhuma chave sai, aconteça o que acontecer.
  if (leaks(data)) data = JSON.stringify({ type: 'error', code: 'internal_error', message: ASSISTANT_ERROR_MESSAGES.internal_error });
  res.write(`data: ${data}\n\n`);
}

