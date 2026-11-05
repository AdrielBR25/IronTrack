-- IronTrack Life — Fase 06: integração entre módulos ("Minha Semana", painel inicial personalizável, IA multimódulo,
-- planejamento com vários módulos e preferências persistentes). Ver docs/INTEGRACAO_LIFE.md.
-- Só tabelas NOVAS, colunas NOVAS com valor padrão e a ampliação de CHECKs. Nenhum registro existente é alterado:
-- as memórias antigas continuam "confirmadas" (foram escritas pela pessoa ou aprovadas por ela).
--
-- A agenda NÃO duplica registros: treinos, refeições, hábitos, missões, metas de estudo e planos bíblicos continuam nas
-- tabelas de cada módulo. Aqui ficam só atividades personalizadas e ajustes de exibição dos itens derivados.

-- Atividades personalizadas da agenda (ou planejadas pela IA e aprovadas pela pessoa). Não geram XP.
CREATE TABLE planner_items (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          date NOT NULL,
  start_time    text CHECK (start_time IS NULL OR start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  duration_min  integer CHECK (duration_min IS NULL OR duration_min BETWEEN 5 AND 720),
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  category      text NOT NULL DEFAULT 'custom' CHECK (category IN ('custom', 'study', 'reading', 'bible', 'workout', 'meal', 'rest', 'free')),
  notes         text CHECK (notes IS NULL OR char_length(notes) <= 300),
  -- Marcado pela PESSOA (nunca pelo relógio).
  status        text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'done', 'missed', 'paused')),
  position      integer NOT NULL DEFAULT 500 CHECK (position BETWEEN 0 AND 999),
  origin        text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'ai')),
  -- Idempotência: o app manda um id de cliente; a IA usa uma chave derivada (data|hora|título) para não duplicar.
  client_id     uuid,
  dedupe_key    text CHECK (dedupe_key IS NULL OR char_length(dedupe_key) <= 200),
  version       integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX planner_items_day_idx ON planner_items (user_id, date);
CREATE UNIQUE INDEX planner_items_client_key ON planner_items (user_id, client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX planner_items_dedupe_key ON planner_items (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Ajustes de um item DERIVADO numa data (horário, duração, ordem, "não realizado"/"pausado"). O registro original não
-- muda. Apagar o ajuste volta ao que o módulo de origem diz.
CREATE TABLE planner_overrides (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key      text NOT NULL CHECK (char_length(item_key) BETWEEN 3 AND 120),
  date          date NOT NULL,
  start_time    text CHECK (start_time IS NULL OR start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  duration_min  integer CHECK (duration_min IS NULL OR duration_min BETWEEN 5 AND 720),
  position      integer CHECK (position IS NULL OR position BETWEEN 0 AND 999),
  status        text CHECK (status IS NULL OR status IN ('missed', 'paused')),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_key, date)
);

-- Cartões do painel inicial (ordem e visibilidade), por conta: o mesmo em todos os aparelhos.
CREATE TABLE life_home_layout (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cards       jsonb NOT NULL CHECK (jsonb_typeof(cards) = 'array'),
  version     integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ preferências persistentes da IA (Fase 00 evoluída)
-- category: para a IA e a tela de preferências organizarem; confirmed=false = inferência da IA guardada com aprovação,
-- mostrada como "inferida" até a pessoa confirmar. expires_on: prioridades da semana deixam de valer sozinhas.
ALTER TABLE assistant_memories ADD COLUMN category text NOT NULL DEFAULT 'other'
  CHECK (category IN ('goal', 'food', 'schedule', 'training', 'study', 'week_priority', 'habit', 'health', 'other'));
ALTER TABLE assistant_memories ADD COLUMN confirmed boolean NOT NULL DEFAULT true;
ALTER TABLE assistant_memories ADD COLUMN expires_on date;
ALTER TABLE assistant_memories ADD COLUMN updated_at timestamptz;

-- ------------------------------------------------------------------ assistente: planejamento multimódulo
-- 'partial' = parte das etapas aplicada e parte não (o app NUNCA diz que o plano inteiro foi salvo).
ALTER TABLE assistant_actions DROP CONSTRAINT assistant_actions_status_check;
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_status_check CHECK (status IN ('pending', 'applied', 'rejected', 'expired', 'failed', 'reverted', 'partial'));

ALTER TABLE assistant_actions DROP CONSTRAINT assistant_actions_kind_check;
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_kind_check CHECK (kind IN (
  'create_routine', 'update_routine', 'save_preference',
  'create_habit', 'update_habit', 'create_life_routine', 'update_life_routine', 'create_missions', 'update_mission',
  'create_meal', 'update_meal', 'add_meal_items', 'create_food', 'update_nutrition_goals', 'create_meal_plan', 'update_meal_plan',
  'create_book', 'update_book_progress', 'create_subject', 'create_topics', 'create_study_plan', 'update_knowledge_goals', 'schedule_knowledge_routine',
  'create_bible_plan', 'update_bible_plan', 'create_bible_goal', 'add_bible_favorite', 'save_bible_reflection',
  'create_planner_items', 'apply_life_plan'
));
