-- IronTrack Life — Fase 02: alimentação (diário, alimentos próprios, refeições salvas, metas, água, planejamento).
-- Ver docs/ALIMENTACAO.md. Só tabelas NOVAS, mais a ampliação de três CHECKs da Fase 01 (nova origem de XP
-- 'nutrition', nova métrica de missão 'nutrition_days') e dos tipos de proposta do assistente. Nenhum dado existente é
-- alterado. Tudo pertence a users(id) com ON DELETE CASCADE.
--
-- O catálogo oficial (TACO 4ª ed.) NÃO fica no banco: é um arquivo versionado da API (src/nutrition/catalog). Itens de
-- refeição guardam uma CÓPIA dos valores por 100 g/ml do alimento no momento do registro, para que corrigir um
-- alimento próprio ou atualizar o catálogo nunca mude o histórico.

-- Alimentos cadastrados pela pessoa (dados do rótulo ou próprios).
CREATE TABLE nutrition_foods (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  brand          text CHECK (brand IS NULL OR char_length(brand) <= 60),
  state          text NOT NULL DEFAULT 'other' CHECK (state IN ('raw', 'cooked', 'prepared', 'packaged', 'other')),
  base_unit      text NOT NULL CHECK (base_unit IN ('g', 'ml')),
  -- Valores por 100 g ou 100 ml (base_unit).
  kcal           numeric(7, 2) NOT NULL CHECK (kcal BETWEEN 0 AND 900),
  protein        numeric(6, 2) NOT NULL CHECK (protein BETWEEN 0 AND 100),
  carbs          numeric(6, 2) NOT NULL CHECK (carbs BETWEEN 0 AND 100),
  fat            numeric(6, 2) NOT NULL CHECK (fat BETWEEN 0 AND 100),
  fiber          numeric(6, 2) CHECK (fiber IS NULL OR fiber BETWEEN 0 AND 100),
  portion_label  text CHECK (portion_label IS NULL OR char_length(portion_label) <= 40),
  portion_amount numeric(7, 2) CHECK (portion_amount IS NULL OR portion_amount BETWEEN 0.1 AND 5000),
  source_note    text CHECK (source_note IS NULL OR char_length(source_note) <= 120),
  origin         text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'ai')),
  archived       boolean NOT NULL DEFAULT false,
  version        integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nutrition_foods_macros CHECK (protein + carbs + fat <= 100.5)
);
CREATE INDEX nutrition_foods_user_idx ON nutrition_foods (user_id, archived);

-- Alimentos favoritos (catálogo ou próprios), por referência estável: taco:<n>, generic:<slug>, custom:<uuid>.
CREATE TABLE nutrition_food_favorites (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  food_ref   text NOT NULL CHECK (char_length(food_ref) <= 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, food_ref)
);

-- Refeições: consumidas (contam no dia) ou planejadas (NUNCA contam como consumo até serem marcadas).
CREATE TABLE nutrition_meals (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Dia local no fuso da conta (life_profiles.timezone) no momento do registro.
  date           date NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('breakfast', 'lunch', 'snack', 'dinner', 'supper', 'custom')),
  name           text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 60),
  time           text CHECK (time IS NULL OR time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  status         text NOT NULL CHECK (status IN ('planned', 'consumed')),
  notes          text CHECK (notes IS NULL OR char_length(notes) <= 300),
  -- 'photo' fica reservado para a Fase 03 (análise de foto sempre revisada antes de salvar).
  origin         text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'ai', 'photo', 'copy', 'saved')),
  -- Totais do planejamento no momento em que a refeição planejada virou consumida (comparação planejado × real).
  planned_totals jsonb,
  consumed_at    timestamptz,
  -- Idempotência de reenvio: o app manda um id de cliente; repetir a requisição devolve a mesma refeição.
  client_id      uuid,
  version        integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nutrition_meals_day_idx ON nutrition_meals (user_id, date);
CREATE UNIQUE INDEX nutrition_meals_client_key ON nutrition_meals (user_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE nutrition_meal_items (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meal_id       uuid NOT NULL REFERENCES nutrition_meals(id) ON DELETE CASCADE,
  position      integer NOT NULL CHECK (position BETWEEN 0 AND 99),
  food_ref      text NOT NULL CHECK (char_length(food_ref) <= 60),
  -- Cópia do alimento no momento do registro.
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  state         text NOT NULL DEFAULT 'other' CHECK (state IN ('raw', 'cooked', 'prepared', 'packaged', 'other')),
  source        text NOT NULL CHECK (char_length(source) <= 120),
  unit          text NOT NULL CHECK (unit IN ('g', 'ml')),
  quantity      numeric(8, 2) NOT NULL CHECK (quantity > 0 AND quantity <= 5000),
  portion_label text CHECK (portion_label IS NULL OR char_length(portion_label) <= 40),
  portion_count numeric(6, 2) CHECK (portion_count IS NULL OR portion_count > 0),
  kcal          numeric(7, 2) NOT NULL CHECK (kcal >= 0),
  protein       numeric(6, 2),
  carbs         numeric(6, 2),
  fat           numeric(6, 2),
  fiber         numeric(6, 2)
);
CREATE INDEX nutrition_meal_items_meal_idx ON nutrition_meal_items (meal_id, position);
CREATE INDEX nutrition_meal_items_food_idx ON nutrition_meal_items (user_id, food_ref);

-- Refeições favoritas ("salvas"): lista de itens reaproveitável em poucos toques.
CREATE TABLE nutrition_saved_meals (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  kind         text NOT NULL CHECK (kind IN ('breakfast', 'lunch', 'snack', 'dinner', 'supper', 'custom')),
  items        jsonb NOT NULL,
  use_count    integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nutrition_saved_meals_user_idx ON nutrition_saved_meals (user_id);

-- Metas pessoais (editáveis; a estimativa é só um ponto de partida explicado).
CREATE TABLE nutrition_goals (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  objective       text NOT NULL CHECK (objective IN ('maintenance', 'muscle_gain', 'fat_loss', 'organization')),
  kcal            integer CHECK (kcal IS NULL OR kcal BETWEEN 800 AND 6000),
  protein         integer CHECK (protein IS NULL OR protein BETWEEN 10 AND 400),
  carbs           integer CHECK (carbs IS NULL OR carbs BETWEEN 0 AND 900),
  fat             integer CHECK (fat IS NULL OR fat BETWEEN 10 AND 300),
  water_ml        integer CHECK (water_ml IS NULL OR water_ml BETWEEN 500 AND 8000),
  meal_times      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Preferências e restrições ditas pela pessoa (ex.: "sem lactose", "não como carne de porco"); a IA respeita.
  preferences     text CHECK (preferences IS NULL OR char_length(preferences) <= 500),
  estimate        jsonb,
  origin          text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'ai')),
  version         integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Água por dia local (total em ml).
CREATE TABLE nutrition_water (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       date NOT NULL,
  ml         integer NOT NULL CHECK (ml BETWEEN 0 AND 10000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date)
);

-- ------------------------------------------------------------------ RPG: nova origem de XP e nova métrica de missão
ALTER TABLE life_xp_events DROP CONSTRAINT life_xp_events_source_check;
ALTER TABLE life_xp_events ADD CONSTRAINT life_xp_events_source_check CHECK (source IN ('habit', 'mission', 'workout', 'routine', 'achievement', 'legacy', 'nutrition'));
ALTER TABLE life_missions DROP CONSTRAINT life_missions_metric_check;
ALTER TABLE life_missions ADD CONSTRAINT life_missions_metric_check CHECK (metric IN ('habit_completions', 'habit', 'workouts', 'active_days', 'routine_completions', 'manual', 'nutrition_days'));

-- ------------------------------------------------------------------ assistente: propostas de alimentação
ALTER TABLE assistant_actions DROP CONSTRAINT assistant_actions_kind_check;
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_kind_check CHECK (kind IN (
  'create_routine', 'update_routine', 'save_preference',
  'create_habit', 'update_habit', 'create_life_routine', 'update_life_routine', 'create_missions', 'update_mission',
  'create_meal', 'update_meal', 'add_meal_items', 'create_food', 'update_nutrition_goals', 'create_meal_plan', 'update_meal_plan'
));
