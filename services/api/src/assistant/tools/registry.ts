// Registro dos módulos da IA. Um módulo novo (alimentação, hábitos, missões…) entra aqui com as próprias ferramentas e
// handlers de ação; o núcleo (engine.ts) não muda. Módulos `planned` não têm ferramentas: a IA sabe que eles ainda não
// existem e diz isso, em vez de inventar dados.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_MEMORIES, savePreferenceArgsSchema } from '../../../../../shared/assistant/protocol.ts';
import { bodyModule, goalsModule } from './progress.ts';
import { lifeModule } from './life.ts';
import { nutritionModule } from './nutrition.ts';
import { knowledgeModule } from './knowledge.ts';
import { trainingModule } from './training.ts';
import { ToolError, type ActionHandler, type AiModuleDef, type AiTool, type WriteTool } from './types.ts';

const proposePreference: WriteTool<typeof savePreferenceArgsSchema> = {
  kind: 'write',
  name: 'propose_save_preference',
  label: 'Preparando uma preferência para salvar',
  description:
    'Prepara a PROPOSTA de guardar uma preferência explícita da pessoa (ex.: "prefiro treinos de 45 minutos", "tenho dor no ombro esquerdo, evitar desenvolvimento"). Só use quando a pessoa pedir para lembrar algo. A pessoa aprova antes de salvar.',
  parameters: { type: 'object', properties: { content: { type: 'string', description: 'A preferência, curta, em terceira pessoa ou como a pessoa disse.' } }, required: ['content'], additionalProperties: false },
  args: savePreferenceArgsSchema,
  async prepare(ctx, a) {
    const n = await ctx.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM assistant_memories WHERE user_id = $1', [ctx.userId]);
    if ((n.rows[0]?.n ?? 0) >= MAX_MEMORIES) throw new ToolError('memory_limit', 'Limite de preferências salvas atingido.');
    return { kind: 'save_preference', title: 'Salvar uma preferência', rationale: null, payload: { content: a.content }, preview: [{ title: 'Preferência', lines: [{ kind: 'add', text: a.content }] }], targetId: null, baseVersion: null };
  },
};

const preferenceHandler: ActionHandler = {
  kind: 'save_preference',
  async apply(c, ctx, action) {
    const { content } = savePreferenceArgsSchema.parse(action.payload);
    const n = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM assistant_memories WHERE user_id = $1', [ctx.userId]);
    if ((n.rows[0]?.n ?? 0) >= MAX_MEMORIES) throw new ToolError('memory_limit', 'Limite de preferências salvas atingido.');
    const id = randomUUID();
    await c.query("INSERT INTO assistant_memories (id, user_id, content, source) VALUES ($1, $2, $3, 'ai_approved')", [id, ctx.userId, content]);
    return { collection: 'memories', entityId: id, summary: `Preferência salva: "${content}"`, undo: { id } };
  },
  async undo(c, ctx, _a, u) {
    const { id } = u as { id: string };
    await c.query('DELETE FROM assistant_memories WHERE user_id = $1 AND id = $2', [ctx.userId, id]);
    return { summary: 'Preferência removida.' };
  },
};

const memoryModule: AiModuleDef = { id: 'assistant_memory', name: 'Preferências do assistente', status: 'available', scope: 'preferências explícitas que a pessoa pediu para lembrar', tools: [proposePreference], actions: [preferenceHandler] };

/** Contratos dos módulos futuros (sem ferramentas ainda). Ver docs/IA_CENTRAL.md §7. */
const PLANNED: AiModuleDef[] = [
  // Fase 02: alimentação passou a existir (nutritionModule).
  // Fase 01: hábitos, rotinas, missões, XP, níveis e conquistas passaram a existir (lifeModule).
  // Fase 04: leitura e estudos passaram a existir (knowledgeModule).
  { id: 'reflections', name: 'Bíblia, reflexões e metas de longo prazo', status: 'planned', scope: 'planos de leitura bíblica, versículos, reflexões, metas de meses/anos (Fase 05: vai reaproveitar sessões, metas e anotações do Conhecimento)', tools: [], actions: [] },
  // Fase 03: foto de refeição passou a existir (analyze_meal_photo no nutritionModule). Rótulo por foto: planejado.
  { id: 'label_photo', name: 'Leitura de rótulos nutricionais por foto', status: 'planned', scope: 'foto do rótulo → alimento próprio revisado (preparado no contrato de visão, ainda sem ferramenta)', tools: [], actions: [] },
];

export const MODULES: readonly AiModuleDef[] = [trainingModule, goalsModule, bodyModule, lifeModule, nutritionModule, knowledgeModule, memoryModule, ...PLANNED];

const listModules: AiTool = {
  kind: 'read',
  name: 'list_app_modules',
  label: 'Consultando os módulos do app',
  description: 'Lista os módulos do IronTrack e se já estão disponíveis para a IA ou só planejados. Use quando perguntarem sobre algo fora de treino, metas, medidas, RPG, alimentação, leitura e estudos (ex.: Bíblia, foto de rótulo).',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  args: z.object({}).strict(),
  async run() {
    return { modules: MODULES.map((m) => ({ id: m.id, name: m.name, status: m.status, scope: m.scope })), note: 'Módulos "planned" ainda não existem no app: não há registros deles.' };
  },
};

/** Validação do registro na carga do módulo: nomes únicos e cada escrita com handler. */
function build() {
  const tools = new Map<string, AiTool>();
  for (const t of [listModules, ...MODULES.flatMap((m) => m.tools)]) {
    if (tools.has(t.name)) throw new Error(`ferramenta duplicada: ${t.name}`);
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(t.name)) throw new Error(`nome de ferramenta inválido: ${t.name}`);
    tools.set(t.name, t);
  }
  const handlers = new Map<string, ActionHandler>();
  for (const h of MODULES.flatMap((m) => m.actions)) handlers.set(h.kind, h);
  return { tools, handlers };
}

const built = build();
export const TOOLS: ReadonlyMap<string, AiTool> = built.tools;
export const ACTION_HANDLERS: ReadonlyMap<string, ActionHandler> = built.handlers;
