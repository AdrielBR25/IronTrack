-- IronTrack Life — Fase 04: Conhecimento (leitura, estudos, foco e metas). Ver docs/CONHECIMENTO.md.
-- Só tabelas NOVAS, mais a ampliação de CHECKs anteriores (nova origem de XP 'knowledge' e novos tipos de proposta do
-- assistente). Nenhum dado existente é alterado. Tudo pertence a users(id) com ON DELETE CASCADE.
--
-- `module` ('knowledge' hoje; 'bible' reservado para a Fase 05) e `ref` (referência genérica, ex.: capítulo bíblico)
-- permitem que a leitura bíblica reaproveite sessões, metas, anotações e histórico sem nova estrutura.
-- Datas locais (date) usam o fuso da conta (life_profiles.timezone) no momento do registro.

CREATE TABLE knowledge_books (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  author       text CHECK (author IS NULL OR char_length(author) <= 120),
  -- Capa opcional: imagem pequena reduzida no aparelho (data URL). Sem capa, o app gera uma pelo título.
  cover        text CHECK (cover IS NULL OR (char_length(cover) <= 160000 AND cover ~ '^data:image/(jpeg|png|webp);base64,')),
  total_pages  integer CHECK (total_pages IS NULL OR total_pages BETWEEN 1 AND 20000),
  current_page integer NOT NULL DEFAULT 0 CHECK (current_page BETWEEN 0 AND 20000),
  category     text CHECK (category IS NULL OR char_length(category) <= 40),
  started_on   date,
  target_date  date,
  finished_on  date,
  status       text NOT NULL DEFAULT 'want' CHECK (status IN ('want', 'reading', 'done', 'paused')),
  rating       smallint CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  review       text CHECK (review IS NULL OR char_length(review) <= 2000),
  origin       text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'ai')),
  version      integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_books_pages CHECK (total_pages IS NULL OR current_page <= total_pages)
);
CREATE INDEX knowledge_books_user_idx ON knowledge_books (user_id, status);

CREATE TABLE knowledge_subjects (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  description      text CHECK (description IS NULL OR char_length(description) <= 300),
  category         text CHECK (category IS NULL OR char_length(category) <= 40),
  color            text NOT NULL DEFAULT 'lime' CHECK (color IN ('lime', 'sky', 'violet', 'amber', 'rose', 'emerald', 'orange', 'cyan')),
  weekly_goal_min  integer CHECK (weekly_goal_min IS NULL OR weekly_goal_min BETWEEN 10 AND 3000),
  notes            text CHECK (notes IS NULL OR char_length(notes) <= 4000),
  archived         boolean NOT NULL DEFAULT false,
  origin           text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'ai')),
  version          integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_subjects_user_idx ON knowledge_subjects (user_id, archived);

CREATE TABLE knowledge_topics (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id   uuid NOT NULL REFERENCES knowledge_subjects(id) ON DELETE CASCADE,
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  notes        text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'studying', 'done')),
  position     integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 999),
  completed_at timestamptz,
  origin       text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'ai')),
  version      integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_topics_subject_idx ON knowledge_topics (subject_id, position);

-- Sessões concluídas (cronômetro, registro manual ou registro aprovado da IA). active_sec é o tempo que CONTA,
-- calculado pelo servidor (pausas e trechos sem presença acima do limite ficam de fora).
CREATE TABLE knowledge_sessions (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module        text NOT NULL DEFAULT 'knowledge' CHECK (module IN ('knowledge', 'bible')),
  kind          text NOT NULL CHECK (kind IN ('reading', 'study', 'focus')),
  mode          text NOT NULL CHECK (mode IN ('stopwatch', 'countdown', 'pomodoro', 'manual')),
  origin        text NOT NULL CHECK (origin IN ('timer', 'manual', 'ai')),
  book_id       uuid REFERENCES knowledge_books(id) ON DELETE SET NULL,
  subject_id    uuid REFERENCES knowledge_subjects(id) ON DELETE SET NULL,
  topic_id      uuid REFERENCES knowledge_topics(id) ON DELETE SET NULL,
  label         text CHECK (label IS NULL OR char_length(label) <= 80),
  -- Título no momento do registro (o livro/matéria pode ser excluído depois).
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  ref           text CHECK (ref IS NULL OR char_length(ref) <= 120),
  date          date NOT NULL,
  started_at    timestamptz,
  ended_at      timestamptz,
  active_sec    integer NOT NULL CHECK (active_sec BETWEEN 0 AND 36000),
  pause_sec     integer NOT NULL DEFAULT 0 CHECK (pause_sec >= 0),
  excluded_sec  integer NOT NULL DEFAULT 0 CHECK (excluded_sec >= 0),
  focus_blocks  integer NOT NULL DEFAULT 0 CHECK (focus_blocks >= 0),
  page_before   integer,
  page_start    integer CHECK (page_start IS NULL OR page_start BETWEEN 0 AND 20000),
  page_end      integer CHECK (page_end IS NULL OR page_end BETWEEN 0 AND 20000),
  pages_read    integer NOT NULL DEFAULT 0 CHECK (pages_read BETWEEN 0 AND 2000),
  note          text CHECK (note IS NULL OR char_length(note) <= 2000),
  -- Trechos [início, fim] (ms) do cronômetro, para auditoria do cálculo.
  segments      jsonb,
  client_id     uuid,
  version       integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_sessions_day_idx ON knowledge_sessions (user_id, date);
CREATE INDEX knowledge_sessions_book_idx ON knowledge_sessions (user_id, book_id);
CREATE INDEX knowledge_sessions_subject_idx ON knowledge_sessions (user_id, subject_id);
CREATE UNIQUE INDEX knowledge_sessions_client_key ON knowledge_sessions (user_id, client_id) WHERE client_id IS NOT NULL;

-- Cronômetro em andamento: um por conta (o mesmo em todos os aparelhos). Sobrevive a recarregar, trocar de aparelho e
-- ficar sem conexão; vira sessão ao encerrar. Os horários de início/pausa/retomada são do relógio do SERVIDOR.
CREATE TABLE knowledge_timers (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  id           uuid NOT NULL,
  module       text NOT NULL DEFAULT 'knowledge' CHECK (module IN ('knowledge', 'bible')),
  kind         text NOT NULL CHECK (kind IN ('reading', 'study', 'focus')),
  mode         text NOT NULL CHECK (mode IN ('stopwatch', 'countdown', 'pomodoro')),
  book_id      uuid REFERENCES knowledge_books(id) ON DELETE SET NULL,
  subject_id   uuid REFERENCES knowledge_subjects(id) ON DELETE SET NULL,
  topic_id     uuid REFERENCES knowledge_topics(id) ON DELETE SET NULL,
  label        text CHECK (label IS NULL OR char_length(label) <= 80),
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  ref          text CHECK (ref IS NULL OR char_length(ref) <= 120),
  planned_sec  integer CHECK (planned_sec IS NULL OR planned_sec BETWEEN 60 AND 14400),
  pomodoro     jsonb,
  sound        boolean NOT NULL DEFAULT true,
  start_page   integer,
  -- { segments: [{s,e}], seen: [[a,b]], phase, phaseStartedAt, focusDone }
  state        jsonb NOT NULL,
  started_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  version      integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Anotações pessoais: notas, trechos (escritos pela própria pessoa) e reflexões de livros, matérias ou tópicos.
CREATE TABLE knowledge_notes (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module      text NOT NULL DEFAULT 'knowledge' CHECK (module IN ('knowledge', 'bible')),
  book_id     uuid REFERENCES knowledge_books(id) ON DELETE CASCADE,
  subject_id  uuid REFERENCES knowledge_subjects(id) ON DELETE CASCADE,
  topic_id    uuid REFERENCES knowledge_topics(id) ON DELETE CASCADE,
  ref         text CHECK (ref IS NULL OR char_length(ref) <= 120),
  kind        text NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'excerpt', 'reflection')),
  content     text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  page        integer CHECK (page IS NULL OR page BETWEEN 0 AND 20000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_notes_target CHECK (book_id IS NOT NULL OR subject_id IS NOT NULL OR topic_id IS NOT NULL OR ref IS NOT NULL)
);
CREATE INDEX knowledge_notes_book_idx ON knowledge_notes (user_id, book_id);
CREATE INDEX knowledge_notes_subject_idx ON knowledge_notes (user_id, subject_id);

-- Metas: progresso SEMPRE derivado das sessões (nada é contado à mão). Vínculo opcional com um hábito OU uma missão da
-- Fase 01: o vínculo recebe o registro, e a recompensa da meta vira 0 XP quando o hábito vinculado paga a dele.
CREATE TABLE knowledge_goals (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module         text NOT NULL DEFAULT 'knowledge' CHECK (module IN ('knowledge', 'bible')),
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  metric         text NOT NULL CHECK (metric IN ('minutes', 'pages', 'sessions', 'days', 'book_finish')),
  scope          text NOT NULL CHECK (scope IN ('reading', 'study', 'focus', 'any')),
  subject_id     uuid REFERENCES knowledge_subjects(id) ON DELETE CASCADE,
  book_id        uuid REFERENCES knowledge_books(id) ON DELETE CASCADE,
  period         text NOT NULL CHECK (period IN ('daily', 'weekly', 'by_date')),
  target         integer NOT NULL CHECK (target BETWEEN 1 AND 10000),
  days           smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  due_date       date,
  preferred_time text CHECK (preferred_time IS NULL OR preferred_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  habit_id       uuid REFERENCES life_habits(id) ON DELETE SET NULL,
  mission_id     uuid REFERENCES life_missions(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived', 'completed')),
  starts_on      date NOT NULL,
  origin         text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'ai')),
  version        integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_goals_link CHECK (habit_id IS NULL OR mission_id IS NULL),
  CONSTRAINT knowledge_goals_days CHECK (days <@ '{0,1,2,3,4,5,6}'::smallint[] AND cardinality(days) BETWEEN 1 AND 7),
  CONSTRAINT knowledge_goals_due CHECK (period <> 'by_date' OR due_date IS NOT NULL)
);
CREATE INDEX knowledge_goals_user_idx ON knowledge_goals (user_id, status);

-- ------------------------------------------------------------------ RPG: nova origem de XP
ALTER TABLE life_xp_events DROP CONSTRAINT life_xp_events_source_check;
ALTER TABLE life_xp_events ADD CONSTRAINT life_xp_events_source_check CHECK (source IN ('habit', 'mission', 'workout', 'routine', 'achievement', 'legacy', 'nutrition', 'knowledge'));

-- ------------------------------------------------------------------ assistente: propostas do Conhecimento
ALTER TABLE assistant_actions DROP CONSTRAINT assistant_actions_kind_check;
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_kind_check CHECK (kind IN (
  'create_routine', 'update_routine', 'save_preference',
  'create_habit', 'update_habit', 'create_life_routine', 'update_life_routine', 'create_missions', 'update_mission',
  'create_meal', 'update_meal', 'add_meal_items', 'create_food', 'update_nutrition_goals', 'create_meal_plan', 'update_meal_plan',
  'create_book', 'update_book_progress', 'create_subject', 'create_topics', 'create_study_plan', 'update_knowledge_goals', 'schedule_knowledge_routine'
));
