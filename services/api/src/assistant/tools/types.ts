// Ferramentas da IA (Fase 00). Cada módulo do IronTrack registra as próprias ferramentas:
//  - leitura (`read`): consultam registros da conta autenticada e devolvem só o necessário para a pergunta;
//  - escrita (`write`): NUNCA gravam. Preparam uma proposta estruturada com prévia; a gravação só acontece quando a
//    pessoa aprova (POST /api/v1/assistant/actions/:id/approve), pelo `ActionHandler` do mesmo tipo, revalidando tudo.
// Não existe ferramenta genérica (SQL livre, comando, URL): só as funções registradas aqui, com argumentos validados.
import type { z } from 'zod';
import type { ActionCollection, ActionKind, PreviewSection } from '../../../../../shared/assistant/protocol.ts';
import type { Pool, PoolClient } from '../../db/pool.ts';
import type { PhotoAnalysisView } from '../../../../../shared/nutrition/vision.ts';

export interface ToolContext {
  pool: Pool;
  /** Conta da sessão. Toda consulta filtra por ela; nenhum argumento da IA escolhe a conta. */
  userId: string;
  dataProfileId: string;
  /** Fuso da pessoa (validado) para datas locais. */
  timezone: string;
  now: number;
  /**
   * Fase 03: foto anexada à mensagem ATUAL (só existe durante esta resposta; nunca é gravada). `analyze` chama a
   * visão uma única vez por resposta (resultado em cache), com os mesmos limites da tela Alimentação.
   */
  photo?: { analyze: () => Promise<PhotoAnalysisView> };
}

interface ToolBase<S extends z.ZodTypeAny> {
  name: string;
  /** Rótulo curto mostrado no app enquanto a ferramenta roda (pt-BR). */
  label: string;
  description: string;
  /** JSON Schema enviado ao modelo. */
  parameters: Record<string, unknown>;
  /** Validação real dos argumentos (o modelo pode errar ou ser induzido a errar). */
  args: S;
}

export interface ReadTool<S extends z.ZodTypeAny = z.ZodTypeAny> extends ToolBase<S> {
  kind: 'read';
  run(ctx: ToolContext, args: z.infer<S>): Promise<unknown>;
}

export interface Proposal {
  kind: ActionKind;
  title: string;
  rationale: string | null;
  payload: unknown;
  preview: PreviewSection[];
  targetId: string | null;
  baseVersion: number | null;
}

export interface WriteTool<S extends z.ZodTypeAny = z.ZodTypeAny> extends ToolBase<S> {
  kind: 'write';
  /** Confere os dados atuais e devolve a proposta (nada é gravado nos registros). */
  prepare(ctx: ToolContext, args: z.infer<S>): Promise<Proposal>;
}

export type AiTool = ReadTool | WriteTool;

export interface StoredAction {
  id: string;
  kind: ActionKind;
  payload: unknown;
  targetId: string | null;
  baseVersion: number | null;
}

/** Aplica uma proposta aprovada dentro da transação da aprovação. Lança ToolError para recusar. */
export interface ActionHandler {
  kind: ActionKind;
  /** `undo` = o necessário para desfazer depois (estado anterior + versão gravada). */
  apply(c: PoolClient, ctx: ToolContext, action: StoredAction): Promise<{ collection: ActionCollection; entityId: string; summary: string; undo?: unknown }>;
  /** Desfaz uma aplicação (Fase 01). Lança StaleError se o registro mudou depois; ToolError para recusar. */
  undo?(c: PoolClient, ctx: ToolContext, action: StoredAction, undo: unknown): Promise<{ summary: string }>;
}

export interface AiModuleDef {
  id: string;
  name: string;
  status: 'available' | 'planned';
  /** O que o módulo cobre (para a IA saber o que existe e o que ainda não existe). */
  scope: string;
  tools: AiTool[];
  actions: ActionHandler[];
}

/** Erro de ferramenta com mensagem para o MODELO (sem dados internos). */
export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
  }
}
