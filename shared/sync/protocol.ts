// Protocolo de sincronização `irontrack.sync.v1` (Prompt 21). Contrato único entre o app e a API; detalhes e
// exemplos em docs/NUVEM_SINCRONIZACAO.md. Validação estrita: campos desconhecidos são recusados.
import { z } from 'zod';
import { MAX_ENTITY_ID, SYNC_COLLECTIONS } from './collections.ts';

export const SYNC_PROTOCOL = 'irontrack.sync.v1';

/** Limites do protocolo (o servidor aplica; o app respeita para não ser recusado). */
export const SYNC_LIMITS = {
  /** Operações por envio. */
  maxOpsPerPush: 100,
  /** Tamanho máximo do JSON de um registro (bytes UTF-8). */
  maxDocBytes: 512 * 1024,
  /** Corpo máximo de um envio. */
  maxPushBytes: 4 * 1024 * 1024,
  /** Alterações por página no download. */
  maxPullPage: 500,
} as const;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'uuid');
const entityId = z.string().min(1).max(MAX_ENTITY_ID);
const collection = z.enum(SYNC_COLLECTIONS);

export const syncOpSchema = z
  .object({
    /** ID único da operação (idempotência: reenviar o mesmo ID devolve o mesmo resultado). */
    opId: uuid,
    collection,
    entityId,
    kind: z.enum(['put', 'delete']),
    /** Versão do servidor em que a alteração se baseia (0 = entidade nova para este aparelho). */
    baseVersion: z.number().int().min(0),
    /** Registro completo (só em `put`). */
    doc: z.record(z.unknown()).optional(),
    /** Horário do aparelho: apenas informativo (nunca decide conflito). */
    clientTime: z.number().int().nonnegative().optional(),
    /** Gravação feita para resolver um conflito: o servidor guarda a versão substituída. */
    reason: z.literal('conflict_resolution').optional(),
  })
  .strict()
  .refine((o) => (o.kind === 'put' ? o.doc !== undefined : o.doc === undefined), { message: 'doc' });
export type SyncOp = z.infer<typeof syncOpSchema>;

export const pushRequestSchema = z
  .object({
    protocol: z.literal(SYNC_PROTOCOL),
    deviceId: uuid,
    /** Conta a que a fila deste aparelho pertence. O servidor recusa se não for a conta da sessão. */
    accountId: uuid,
    ops: z.array(z.unknown()).min(1).max(SYNC_LIMITS.maxOpsPerPush),
  })
  .strict();

export interface ServerRecord {
  collection: (typeof SYNC_COLLECTIONS)[number];
  entityId: string;
  version: number;
  deleted: boolean;
  /** null quando excluído. */
  doc: Record<string, unknown> | null;
  /** Posição no cursor do servidor. */
  seq: number;
}

export type SyncOpResult =
  | { opId: string; status: 'applied'; version: number; seq: number; replayed?: boolean }
  | { opId: string; status: 'conflict'; server: { version: number; deleted: boolean; doc: Record<string, unknown> | null } }
  | { opId: string; status: 'rejected'; code: string; message: string };

export interface PushResponse {
  protocol: typeof SYNC_PROTOCOL;
  results: SyncOpResult[];
}

export interface PullResponse {
  protocol: typeof SYNC_PROTOCOL;
  /** Cursor opaco a enviar no próximo download. */
  cursor: string;
  hasMore: boolean;
  changes: ServerRecord[];
}
