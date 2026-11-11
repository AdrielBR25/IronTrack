-- IronTrack Life — Fase 05: Bíblia (leitura, versículo do dia, planos, reflexões). Ver docs/BIBLIA.md.
-- Só tabelas NOVAS e colunas NOVAS anuláveis, mais a ampliação de CHECKs anteriores (origem de XP 'bible', métricas de
-- metas bíblicas e tipos de proposta do assistente). Nenhum dado existente é alterado.
--
-- O texto bíblico NÃO fica no banco: vem dos arquivos da tradução empacotados com o app (shared/bible/data). Aqui ficam só
-- os registros da pessoa, sempre com referências no formato do índice da tradução ("JHN", capítulo, versículos).
-- Sessões e cronômetro reaproveitam knowledge_sessions/knowledge_timers (module = 'bible', ref = "JHN.3" ou
-- "JHN.3-JHN.5"); metas reaproveitam knowledge_goals (module = 'bible').

-- Preferências da área Bíblia (uma linha por conta, criada no primeiro uso).
CREATE TABLE bible_prefs (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  translation        text NOT NULL DEFAULT 'BPM' CHECK (translation IN ('BPM')),
  show_on_home       boolean NOT NULL DEFAULT true,
  verse_mode         text NOT NULL DEFAULT 'daily' CHECK (verse_mode IN ('daily', 'on_open', 'interval', 'on_request')),
  verse_interval_min integer NOT NULL DEFAULT 180 CHECK (verse_interval_min BETWEEN 30 AND 720),
  font_size          smallint NOT NULL DEFAULT 18 CHECK (font_size BETWEEN 14 AND 30),
  spacing            text NOT NULL DEFAULT 'normal' CHECK (spacing IN ('compact', 'normal', 'relaxed')),
  reading_theme      text NOT NULL DEFAULT 'dark' CHECK (reading_theme IN ('dark', 'sepia', 'light')),
  -- [{kind: verse|reading|plan|reflection, enabled, time: "HH:MM", days: [0..6]}] (validado na API, até 8)
  reminders          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(reminders) = 'array'),
  quiet_start        text CHECK (quiet_start IS NULL OR quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_end          text CHECK (quiet_end IS NULL OR quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  share_ai           boolean NOT NULL DEFAULT true,
  -- "Continuar de onde parei": última passagem aberta no leitor.
  last_ref           text CHECK (last_ref IS NULL OR last_ref ~ '^[1-3A-Z]{3}\.[0-9]{1,3}(\.[0-9]{1,3})?$'),
  last_read_at       timestamptz,
  version            integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Favoritos e destaques (versículo ou intervalo de versículos de UM capítulo).
CREATE TABLE bible_marks (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('favorite', 'highlight')),
  translation text NOT NULL DEFAULT 'BPM',
  book        text NOT NULL CHECK (book ~ '^[1-3A-Z]{3}$'),
  chapter     smallint NOT NULL CHECK (chapter BETWEEN 1 AND 200),
  verse_start smallint NOT NULL CHECK (verse_start BETWEEN 1 AND 200),
  verse_end   smallint NOT NULL CHECK (verse_end BETWEEN 1 AND 200),
  color       text CHECK (color IS NULL OR color IN ('lime', 'amber', 'sky', 'rose', 'violet')),
  tags        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 8),
  origin      text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'ai')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bible_marks_range CHECK (verse_end >= verse_start)
);
CREATE UNIQUE INDEX bible_marks_unique ON bible_marks (user_id, kind, book, chapter, verse_start, verse_end);
CREATE INDEX bible_marks_chapter_idx ON bible_marks (user_id, book, chapter);

-- Diário espiritual: reflexões, momentos de gratidão e anotações (opcionalmente ligadas a uma passagem). PRIVADO: nunca
-- entra em relatórios/compartilhamentos; a IA só lê sob pedido explícito da pessoa.
CREATE TABLE bible_reflections (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'reflection' CHECK (kind IN ('reflection', 'gratitude', 'note')),
  date        date NOT NULL,
  title       text CHECK (title IS NULL OR char_length(title) <= 120),
  content     text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 8000),
  book        text CHECK (book IS NULL OR book ~ '^[1-3A-Z]{3}$'),
  chapter     smallint CHECK (chapter IS NULL OR chapter BETWEEN 1 AND 200),
  verse_start smallint CHECK (verse_start IS NULL OR verse_start BETWEEN 1 AND 200),
  verse_end   smallint CHECK (verse_end IS NULL OR verse_end BETWEEN 1 AND 200),
  tags        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 8),
  favorite    boolean NOT NULL DEFAULT false,
  origin      text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'ai')),
  client_id   uuid,
  version     integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bible_reflections_ref CHECK ((book IS NULL) = (chapter IS NULL))
);
CREATE INDEX bible_reflections_user_idx ON bible_reflections (user_id, date DESC);
CREATE UNIQUE INDEX bible_reflections_client_key ON bible_reflections (user_id, client_id) WHERE client_id IS NOT NULL;

-- Planos de leitura. O cronograma é gravado na criação (lista de dias, cada um com chaves de capítulo "JHN.3"): mudar o
-- modelo depois não altera planos em andamento.
CREATE TABLE bible_plans (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template     text NOT NULL CHECK (template IN ('knowing', 'gospels', 'psalms', 'proverbs', 'daily15', 'd30', 'd90', 'whole', 'custom')),
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  description  text CHECK (description IS NULL OR char_length(description) <= 300),
  translation  text NOT NULL DEFAULT 'BPM',
  schedule     jsonb NOT NULL CHECK (jsonb_typeof(schedule) = 'array' AND jsonb_array_length(schedule) BETWEEN 1 AND 400),
  start_date   date NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  paused_on    date,
  completed_on date,
  origin       text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'ai')),
  version      integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bible_plans_user_idx ON bible_plans (user_id, status);

-- Dias concluídos de cada plano (histórico: pausar/reorganizar nunca apaga).
CREATE TABLE bible_plan_days (
  plan_id      uuid NOT NULL REFERENCES bible_plans(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day          smallint NOT NULL CHECK (day BETWEEN 0 AND 399),
  completed_on date NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, day)
);
CREATE INDEX bible_plan_days_user_idx ON bible_plan_days (user_id, completed_on);

-- Capítulos lidos (um registro por capítulo por dia: reenviar não duplica). session_id/plan_id dizem de onde veio.
CREATE TABLE bible_chapter_logs (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book        text NOT NULL CHECK (book ~ '^[1-3A-Z]{3}$'),
  chapter     smallint NOT NULL CHECK (chapter BETWEEN 1 AND 200),
  date        date NOT NULL,
  source      text NOT NULL CHECK (source IN ('reader', 'session', 'plan', 'manual', 'ai')),
  session_id  uuid,
  plan_id     uuid REFERENCES bible_plans(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bible_chapter_logs_day ON bible_chapter_logs (user_id, book, chapter, date);
CREATE INDEX bible_chapter_logs_date_idx ON bible_chapter_logs (user_id, date);
CREATE INDEX bible_chapter_logs_session_idx ON bible_chapter_logs (user_id, session_id) WHERE session_id IS NOT NULL;

-- Histórico do versículo do dia (seq 0 = principal; 1… = "outra passagem"). A escolha é determinística; o registro
-- guarda o que foi mostrado.
CREATE TABLE bible_daily_verses (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       date NOT NULL,
  seq        smallint NOT NULL CHECK (seq BETWEEN 0 AND 20),
  ref        text NOT NULL CHECK (ref ~ '^[1-3A-Z]{3}\.[0-9]{1,3}(\.[0-9]{1,3}(-[0-9]{1,3})?)?$'),
  theme      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date, seq)
);

-- ------------------------------------------------------------------ metas: métricas bíblicas e filtros novos
ALTER TABLE knowledge_goals ADD COLUMN ref text CHECK (ref IS NULL OR ref ~ '^[1-3A-Z]{3}$');
ALTER TABLE knowledge_goals ADD COLUMN plan_id uuid REFERENCES bible_plans(id) ON DELETE CASCADE;
ALTER TABLE knowledge_goals DROP CONSTRAINT knowledge_goals_metric_check;
ALTER TABLE knowledge_goals ADD CONSTRAINT knowledge_goals_metric_check CHECK (metric IN ('minutes', 'pages', 'sessions', 'days', 'book_finish', 'chapters', 'plan_finish'));
ALTER TABLE knowledge_goals ADD CONSTRAINT knowledge_goals_bible_metric CHECK (module = 'bible' OR metric NOT IN ('chapters', 'plan_finish'));

-- ------------------------------------------------------------------ RPG: nova origem de XP
ALTER TABLE life_xp_events DROP CONSTRAINT life_xp_events_source_check;
ALTER TABLE life_xp_events ADD CONSTRAINT life_xp_events_source_check CHECK (source IN ('habit', 'mission', 'workout', 'routine', 'achievement', 'legacy', 'nutrition', 'knowledge', 'bible'));

-- ------------------------------------------------------------------ assistente: propostas da Bíblia
ALTER TABLE assistant_actions DROP CONSTRAINT assistant_actions_kind_check;
ALTER TABLE assistant_actions ADD CONSTRAINT assistant_actions_kind_check CHECK (kind IN (
  'create_routine', 'update_routine', 'save_preference',
  'create_habit', 'update_habit', 'create_life_routine', 'update_life_routine', 'create_missions', 'update_mission',
  'create_meal', 'update_meal', 'add_meal_items', 'create_food', 'update_nutrition_goals', 'create_meal_plan', 'update_meal_plan',
  'create_book', 'update_book_progress', 'create_subject', 'create_topics', 'create_study_plan', 'update_knowledge_goals', 'schedule_knowledge_routine',
  'create_bible_plan', 'update_bible_plan', 'create_bible_goal', 'add_bible_favorite', 'save_bible_reflection'
));
