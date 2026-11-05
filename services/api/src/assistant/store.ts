// Persistência do assistente no PostgreSQL: conversas, mensagens, memórias, propostas e cota. Toda consulta filtra
// pela conta da sessão (`user_id`); um ID de outra conta simplesmente "não existe".
import { randomUUID } from 'node:crypto';
import { UNDO_WINDOW_HOURS, type ActionCollection, type ActionKind, type ActionStatus, type ActionView, type ConversationSummaryView, type MemoryView, type MessageRole, type MessageView, type PreviewSection, type ToolUseView } from '../../../../shared/assistant/protocol.ts';
import type { Pool, PoolClient } from '../db/pool.ts';

type Q = Pick<Pool | PoolClient, 'query'>;

interface ConvRow {
  id: string;
  title: string;
  title_source: string;
  summary: string | null;
  summary_upto: number;
  created_at: Date;
  updated_at: Date;
  message_count?: number;
}

interface MsgRow {
  seq: number;
  id: string;
  role: MessageRole;
  content: string;
  status: MessageView['status'];
  model: string | null;
  tools: ToolUseView[];
  action_ids: string[];
  attachments?: unknown[];
  created_at: Date;
}

export interface ActionRow {
  id: string;
  conversation_id: string | null;
  kind: ActionKind;
  status: ActionStatus;
  title: string;
  rationale: string | null;
  payload: unknown;
  preview: PreviewSection[];
  target_id: string | null;
  base_version: number | null;
  result: { collection: ActionCollection; entityId: string } | null;
  error: string | null;
  undo_data: unknown;
  reverted_at: Date | null;
  created_at: Date;
  expires_at: Date;
  decided_at: Date | null;
}

export const convView = (r: ConvRow): ConversationSummaryView => ({ id: r.id, title: r.title, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), messageCount: r.message_count ?? 0 });
export const msgView = (r: MsgRow): MessageView => ({ id: r.id, role: r.role, content: r.content, status: r.status, createdAt: r.created_at.toISOString(), model: r.model, tools: r.tools ?? [], actionIds: r.action_ids ?? [], attachments: Array.isArray(r.attachments) ? r.attachments.map(() => ({ type: 'image' as const, stored: false as const })) : [] });
export function actionView(r: ActionRow, now: number): ActionView {
  const expired = r.status === 'pending' && r.expires_at.getTime() <= now;
  return {
    id: r.id,
    kind: r.kind,
    status: expired ? 'expired' : r.status,
    title: r.title,
    rationale: r.rationale,
    preview: r.preview,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    decidedAt: r.decided_at?.toISOString() ?? null,
    result: r.result ? { collection: r.result.collection, entityId: r.result.entityId } : null,
    error: r.error,
    undoable: r.status === 'applied' && r.undo_data != null && !!r.decided_at && now - r.decided_at.getTime() < UNDO_WINDOW_HOURS * 3_600_000,
    revertedAt: r.reverted_at?.toISOString() ?? null,
  };
}

export async function listConversations(q: Q, userId: string, limit = 100): Promise<ConversationSummaryView[]> {
  const r = await q.query<ConvRow>(
    `SELECT c.*, (SELECT count(*)::int FROM assistant_messages m WHERE m.conversation_id = c.id) AS message_count
       FROM assistant_conversations c WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT $2`,
    [userId, limit],
  );
  return r.rows.map(convView);
}

export async function getConversation(q: Q, userId: string, id: string): Promise<ConvRow | null> {
  if (!isUuid(id)) return null;
  const r = await q.query<ConvRow>('SELECT * FROM assistant_conversations WHERE user_id = $1 AND id = $2', [userId, id]);
  return r.rows[0] ?? null;
}

export async function createConversation(q: Q, userId: string, title: string): Promise<ConvRow> {
  const r = await q.query<ConvRow>('INSERT INTO assistant_conversations (id, user_id, title) VALUES ($1, $2, $3) RETURNING *', [randomUUID(), userId, title]);
  return r.rows[0];
}

export async function messages(q: Q, userId: string, conversationId: string, afterSeq = 0, limit = 500): Promise<(MsgRow & { input_tokens?: number })[]> {
  const r = await q.query<MsgRow>('SELECT * FROM assistant_messages WHERE user_id = $1 AND conversation_id = $2 AND seq > $3 ORDER BY seq LIMIT $4', [userId, conversationId, afterSeq, limit]);
  return r.rows;
}

/** As `limit` mensagens mais recentes, em ordem cronológica. */
export async function recentMessages(q: Q, userId: string, conversationId: string, limit: number): Promise<MsgRow[]> {
  const r = await q.query<MsgRow>('SELECT * FROM (SELECT * FROM assistant_messages WHERE user_id = $1 AND conversation_id = $2 ORDER BY seq DESC LIMIT $3) t ORDER BY seq', [userId, conversationId, limit]);
  return r.rows;
}

export async function insertMessage(
  q: Q,
  m: { userId: string; conversationId: string; role: MessageRole; content: string; status?: MessageView['status']; model?: string | null; tools?: ToolUseView[]; actionIds?: string[]; inputTokens?: number; outputTokens?: number; photos?: number },
): Promise<MsgRow> {
  // Fase 03: só a MARCA de que houve foto (nunca a imagem).
  const att = Array.from({ length: m.photos ?? 0 }, () => ({ type: 'image', stored: false }));
  const r = await q.query<MsgRow>(
    `INSERT INTO assistant_messages (id, conversation_id, user_id, role, content, status, model, tools, action_ids, input_tokens, output_tokens, attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [randomUUID(), m.conversationId, m.userId, m.role, m.content.slice(0, 40_000), m.status ?? 'complete', m.model ?? null, JSON.stringify(m.tools ?? []), JSON.stringify(m.actionIds ?? []), m.inputTokens ?? null, m.outputTokens ?? null, JSON.stringify(att)],
  );
  await q.query('UPDATE assistant_conversations SET updated_at = now() WHERE id = $1 AND user_id = $2', [m.conversationId, m.userId]);
  return r.rows[0];
}

export async function insertAction(
  q: Q,
  a: { userId: string; conversationId: string; kind: ActionKind; title: string; rationale: string | null; payload: unknown; preview: PreviewSection[]; targetId: string | null; baseVersion: number | null; ttlHours: number },
): Promise<ActionRow> {
  const r = await q.query<ActionRow>(
    `INSERT INTO assistant_actions (id, user_id, conversation_id, kind, status, title, rationale, payload, preview, target_id, base_version, expires_at)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, now() + make_interval(hours => $11)) RETURNING *`,
    [randomUUID(), a.userId, a.conversationId, a.kind, a.title.slice(0, 200), a.rationale?.slice(0, 600) ?? null, JSON.stringify(a.payload), JSON.stringify(a.preview), a.targetId, a.baseVersion, a.ttlHours],
  );
  return r.rows[0];
}

export async function getAction(q: Q, userId: string, id: string, lock = false): Promise<ActionRow | null> {
  if (!isUuid(id)) return null;
  const r = await q.query<ActionRow>(`SELECT * FROM assistant_actions WHERE user_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [userId, id]);
  return r.rows[0] ?? null;
}

export async function conversationActions(q: Q, userId: string, conversationId: string): Promise<ActionRow[]> {
  const r = await q.query<ActionRow>('SELECT * FROM assistant_actions WHERE user_id = $1 AND conversation_id = $2 ORDER BY created_at', [userId, conversationId]);
  return r.rows;
}

export async function listMemories(q: Q, userId: string): Promise<MemoryView[]> {
  const r = await q.query<{ id: string; content: string; source: MemoryView['source']; created_at: Date }>('SELECT id, content, source, created_at FROM assistant_memories WHERE user_id = $1 ORDER BY created_at', [userId]);
  return r.rows.map((x) => ({ id: x.id, content: x.content, source: x.source, createdAt: x.created_at.toISOString() }));
}

// ------------------------------------------------------------------ cota diária (por conta, persistida)

/** Conta uma mensagem do dia; false se passou do limite (a contagem não sobe). */
export async function countMessage(q: Q, userId: string, day: string, max: number): Promise<boolean> {
  const r = await q.query(
    `INSERT INTO assistant_usage_daily (user_id, day, messages) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET messages = assistant_usage_daily.messages + 1 WHERE assistant_usage_daily.messages < $3`,
    [userId, day, max],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Reserva tokens antes de uma chamada ao provedor; false se a cota do dia não comporta. */
export async function reserveTokens(q: Q, userId: string, day: string, amount: number, budget: number): Promise<boolean> {
  const r = await q.query(
    `INSERT INTO assistant_usage_daily (user_id, day, tokens) SELECT $1::uuid, $2::date, $3::bigint WHERE $3::bigint <= $4::bigint
     ON CONFLICT (user_id, day) DO UPDATE SET tokens = assistant_usage_daily.tokens + $3::bigint WHERE assistant_usage_daily.tokens + $3::bigint <= $4::bigint`,
    [userId, day, amount, budget],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function settleTokens(q: Q, userId: string, day: string, reserved: number, actual: number): Promise<void> {
  await q.query('UPDATE assistant_usage_daily SET tokens = GREATEST(0, tokens - $3 + $4) WHERE user_id = $1 AND day = $2', [userId, day, reserved, actual]);
}

export async function usageOf(q: Q, userId: string, day: string): Promise<{ messages: number; tokens: number }> {
  const r = await q.query<{ messages: number; tokens: number }>('SELECT messages, tokens FROM assistant_usage_daily WHERE user_id = $1 AND day = $2', [userId, day]);
  return { messages: r.rows[0]?.messages ?? 0, tokens: r.rows[0]?.tokens ?? 0 };
}

export const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
