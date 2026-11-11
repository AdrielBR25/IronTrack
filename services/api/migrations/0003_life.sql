-- IronTrack Life — Fase 01: RPG de desenvolvimento pessoal (perfil, hábitos, rotinas, missões, XP e conquistas).
-- Ver docs/RPG_DESENVOLVIMENTO.md. Só tabelas NOVAS, mais a ampliação das propostas do assistente (novos tipos e
-- desfazer). Nenhum dado existente é alterado ou migrado. Tudo pertence a users(id) com ON DELETE CASCADE.
--
-- Datas "locais" (day, date, starts_on…) são do fuso da conta (life_profiles.timezone) no momento do registro e ficam
-- gravadas como date: trocar o fuso depois não recalcula nem duplica nada.

CREATE TABLE life_profiles (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone       text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 64),
  -- Treinos concluídos ANTES desta data não geram XP (entram só no bônus de histórico e nas conquistas).
  activated_at   timestamptz NOT NULL DEFAULT now(),
  total_xp       bigint NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
  level          integer NOT NULL DEFAULT 1 CHECK (level >= 1),
  selected_title text CHECK (selected_title IS NULL OR char_length(selected_title) <= 60),
  -- Meta semanal de treinos usada nas missões semanais (null = calcula pelo histórico).
  weekly_workout_target smallint CHECK (weekly_workout_target IS NULL OR weekly_workout_target BETWEEN 1 AND 7),
  tz_changed_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE life_attributes (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attribute  text NOT NULL CHECK (attribute IN ('strength', 'knowledge', 'discipline', 'health', 'spirituality')),
  xp         bigint NOT NULL DEFAULT 0 CHECK (xp >= 0),
  PRIMARY KEY (user_id, attribute)
);

CREATE TABLE life_habits (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  description    text CHECK (description IS NULL OR char_length(description) <= 300),
  attribute      text NOT NULL CHECK (attribute IN ('strength', 'knowledge', 'discipline', 'health', 'spirituality')),
  -- Tipo de atividade (para conquistas e módulos futuros: leitura, Bíblia, estudo…).
  tag            text NOT NULL DEFAULT 'other' CHECK (tag IN ('reading', 'bible', 'study', 'water', 'sleep', 'workout', 'nutrition', 'routine', 'other')),
  icon           text NOT NULL DEFAULT 'check' CHECK (char_length(icon) <= 30),
  frequency      text NOT NULL CHECK (frequency IN ('daily', 'weekly')),
  -- Dias da semana (0 = domingo … 6 = sábado) quando a frequência é diária.
  days           smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  times_per_week smallint CHECK (times_per_week IS NULL OR times_per_week BETWEEN 1 AND 7),
  goal_kind      text NOT NULL CHECK (goal_kind IN ('check', 'count', 'duration')),
  goal_target    integer NOT NULL CHECK (goal_target BETWEEN 1 AND 1440),
  goal_unit      text CHECK (goal_unit IS NULL OR char_length(goal_unit) <= 20),
  preferred_time text CHECK (preferred_time IS NULL OR preferred_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  xp             integer NOT NULL CHECK (xp BETWEEN 5 AND 50),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  start_date     date NOT NULL,
  origin         text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'ai')),
  version        integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT life_habits_weekly CHECK (frequency <> 'weekly' OR times_per_week IS NOT NULL),
  CONSTRAINT life_habits_days CHECK (days <@ '{0,1,2,3,4,5,6}'::smallint[] AND cardinality(days) BETWEEN 1 AND 7)
);
CREATE INDEX life_habits_user_idx ON life_habits (user_id, status);

-- Um registro por hábito e dia local: quanto foi feito e se a meta do dia foi cumprida.
CREATE TABLE life_habit_logs (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  habit_id    uuid NOT NULL REFERENCES life_habits(id) ON DELETE CASCADE,
  date        date NOT NULL,
  amount      integer NOT NULL CHECK (amount BETWEEN 0 AND 10000),
  completed   boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, habit_id, date)
);
CREATE INDEX life_habit_logs_date_idx ON life_habit_logs (user_id, date);

CREATE TABLE life_routines (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  kind        text NOT NULL CHECK (kind IN ('morning', 'study', 'training', 'night', 'custom')),
  days        smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  origin      text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'ai')),
  version     integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT life_routines_days CHECK (days <@ '{0,1,2,3,4,5,6}'::smallint[] AND cardinality(days) BETWEEN 1 AND 7)
);
CREATE INDEX life_routines_user_idx ON life_routines (user_id, status);

CREATE TABLE life_missions (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('daily', 'weekly', 'custom', 'special')),
  origin       text NOT NULL CHECK (origin IN ('system', 'user', 'ai')),
  -- Missões automáticas: modelo + início do período (uma por período, nunca duplicada).
  template     text CHECK (template IS NULL OR char_length(template) <= 40),
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  description  text CHECK (description IS NULL OR char_length(description) <= 300),
  -- Como o progresso é medido: contagem de eventos válidos (derivada) ou registros manuais.
  metric       text NOT NULL CHECK (metric IN ('habit_completions', 'habit', 'workouts', 'active_days', 'routine_completions', 'manual')),
  habit_id     uuid REFERENCES life_habits(id) ON DELETE SET NULL,
  routine_id   uuid REFERENCES life_routines(id) ON DELETE SET NULL,
  unit         text NOT NULL DEFAULT 'times' CHECK (unit IN ('times', 'minutes', 'pages', 'chapters', 'check')),
  tag          text NOT NULL DEFAULT 'other' CHECK (tag IN ('reading', 'bible', 'study', 'water', 'sleep', 'workout', 'nutrition', 'routine', 'other')),
  target       integer NOT NULL CHECK (target BETWEEN 1 AND 100000),
  progress     integer NOT NULL DEFAULT 0 CHECK (progress >= 0),
  attribute    text NOT NULL CHECK (attribute IN ('strength', 'knowledge', 'discipline', 'health', 'spirituality')),
  xp           integer NOT NULL CHECK (xp BETWEEN 5 AND 300),
  starts_on    date NOT NULL,
  ends_on      date NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired', 'paused', 'cancelled')),
  completed_at timestamptz,
  version      integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT life_missions_period CHECK (ends_on >= starts_on)
);
CREATE INDEX life_missions_user_idx ON life_missions (user_id, status, ends_on);
CREATE UNIQUE INDEX life_missions_template_key ON life_missions (user_id, template, starts_on) WHERE template IS NOT NULL;

CREATE TABLE life_routine_items (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  routine_id    uuid NOT NULL REFERENCES life_routines(id) ON DELETE CASCADE,
  position      integer NOT NULL CHECK (position BETWEEN 0 AND 99),
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  start_time    text CHECK (start_time IS NULL OR start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  duration_min  integer CHECK (duration_min IS NULL OR duration_min BETWEEN 1 AND 600),
  -- Vínculo opcional: marcar a atividade registra o hábito (o XP é o do hábito, nunca em dobro) ou soma à missão.
  habit_id      uuid REFERENCES life_habits(id) ON DELETE SET NULL,
  mission_id    uuid REFERENCES life_missions(id) ON DELETE SET NULL
);
CREATE INDEX life_routine_items_routine_idx ON life_routine_items (routine_id, position);

-- Atividades de rotina marcadas no dia (as sem vínculo; as vinculadas usam o registro do hábito/missão).
CREATE TABLE life_routine_checks (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    uuid NOT NULL REFERENCES life_routine_items(id) ON DELETE CASCADE,
  date       date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id, date)
);

-- Registros manuais de progresso de missão (cada um pode ser desfeito). source_key evita somar duas vezes a mesma
-- atividade de rotina.
CREATE TABLE life_mission_entries (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_id  uuid NOT NULL REFERENCES life_missions(id) ON DELETE CASCADE,
  date        date NOT NULL,
  amount      integer NOT NULL CHECK (amount BETWEEN 1 AND 10000),
  note        text CHECK (note IS NULL OR char_length(note) <= 200),
  source_key  text CHECK (source_key IS NULL OR char_length(source_key) <= 120),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX life_mission_entries_mission_idx ON life_mission_entries (mission_id, date);
CREATE UNIQUE INDEX life_mission_entries_source_key ON life_mission_entries (user_id, source_key) WHERE source_key IS NOT NULL;

-- Dias de descanso: não quebram a sequência e pausam as missões diárias do dia.
CREATE TABLE life_day_marks (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       date NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('rest')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date)
);

-- Livro-razão de XP (auditável). Uma concessão (grant) por chave de origem enquanto não for revertida; a reversão é
-- outro lançamento (negativo) que aponta para a concessão. Nada é apagado: o total é a soma dos lançamentos.
CREATE TABLE life_xp_events (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('grant', 'reversal')),
  source      text NOT NULL CHECK (source IN ('habit', 'mission', 'workout', 'routine', 'achievement', 'legacy')),
  -- Identidade do evento recompensado (ex.: habit:<id>:<data>, workout:<sessão>, mission:<id>).
  source_key  text NOT NULL CHECK (char_length(source_key) <= 200),
  source_id   text,
  attribute   text CHECK (attribute IS NULL OR attribute IN ('strength', 'knowledge', 'discipline', 'health', 'spirituality')),
  -- XP efetivamente lançado (concessão ≥ 0, já com os limites; reversão ≤ 0) e o pedido antes dos limites.
  amount      integer NOT NULL,
  requested   integer NOT NULL,
  day         date NOT NULL,
  reason      text NOT NULL CHECK (char_length(reason) <= 200),
  reverses    uuid REFERENCES life_xp_events(id),
  reversed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT life_xp_events_sign CHECK ((kind = 'grant' AND amount >= 0 AND reverses IS NULL) OR (kind = 'reversal' AND amount <= 0 AND reverses IS NOT NULL))
);
-- Idempotência: no máximo uma concessão ativa por origem; uma reversão por concessão.
CREATE UNIQUE INDEX life_xp_events_active_key ON life_xp_events (user_id, source_key) WHERE kind = 'grant' AND reversed_at IS NULL;
CREATE UNIQUE INDEX life_xp_events_reverses_key ON life_xp_events (reverses) WHERE reverses IS NOT NULL;
CREATE INDEX life_xp_events_day_idx ON life_xp_events (user_id, day);
CREATE INDEX life_xp_events_created_idx ON life_xp_events (user_id, created_at DESC);

CREATE TABLE life_achievements (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code        text NOT NULL CHECK (char_length(code) <= 40),
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  xp_event_id uuid REFERENCES life_xp_events(id),
  PRIMARY KEY (user_id, code)
);

-- ------------------------------------------------------------------ assistente: novos tipos de proposta e desfazer
ALTER TABLE assistant_actions DROP CONSTRAINT assistant_actions_kind_check;
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_kind_check CHECK (kind IN (
  'create_routine', 'update_routine', 'save_preference',
  'create_habit', 'update_habit', 'create_life_routine', 'update_life_routine', 'create_missions', 'update_mission'
));
ALTER TABLE assistant_actions DROP CONSTRAINT assistant_actions_status_check;
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_status_check CHECK (status IN ('pending', 'applied', 'rejected', 'expired', 'failed', 'reverted'));
-- O necessário para desfazer uma proposta aplicada (estado anterior + versão gravada). Desfazer é recusado se o
-- registro mudou depois.
ALTER TABLE assistant_actions ADD COLUMN undo_data jsonb;
ALTER TABLE assistant_actions ADD COLUMN reverted_at timestamptz;
