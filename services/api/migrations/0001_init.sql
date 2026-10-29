-- IronTrack — esquema inicial da nuvem (Prompt 21). Ver docs/NUVEM_ARQUITETURA.md §2.2.
-- Regras: todo dado privado pertence a users(id) com ON DELETE CASCADE; o ID do cliente é preservado (PK user_id+id);
-- o registro completo do app fica em `doc` e as colunas tipadas são extraídas e validadas pelo servidor.
-- Arquivo imutável depois de aplicado (o executor confere o checksum). Mudanças = novo arquivo.

CREATE TABLE users (
  id               uuid PRIMARY KEY,
  email            text NOT NULL,
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  password_hash    text NOT NULL,
  email_verified_at timestamptz,
  data_profile_id  uuid NOT NULL UNIQUE,
  -- Contador do cursor de sincronização da conta. Incrementado sob o bloqueio da linha: as gravações da mesma conta
  -- ficam em série e a sequência nunca "pula" uma alteração ainda não confirmada.
  sync_seq         bigint NOT NULL DEFAULT 0,
  terms_accepted_at timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_normalized CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 254)
);
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE auth_sessions (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 do token opaco do cookie. O token em si nunca é gravado.
  token_hash    bytea NOT NULL UNIQUE,
  device_label  text NOT NULL DEFAULT '' CHECK (char_length(device_label) <= 80),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('logout', 'logout_others', 'password_changed', 'password_reset', 'account_deleted', 'admin'))
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE email_verification_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,
  email       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX email_verification_tokens_user_idx ON email_verification_tokens (user_id);

CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);

-- Limites de taxa persistidos (valem com várias instâncias e sobrevivem a reinícios). A chave já vem com hash
-- quando deriva de IP ou e-mail: nada pessoal em texto puro.
CREATE TABLE rate_limits (
  bucket        text PRIMARY KEY CHECK (char_length(bucket) <= 200),
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL
);

-- ------------------------------------------------------------------ dados do app (uma tabela por coleção)
-- Colunas comuns: user_id, id (ID do app), doc (registro completo; '{}' quando excluído), version (sobe a cada
-- gravação aceita), server_seq (posição no cursor da conta), deleted (marca de exclusão para os outros aparelhos).

CREATE TABLE user_settings (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (id = 'settings'),
  doc jsonb NOT NULL, version integer NOT NULL CHECK (version > 0), server_seq bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false, device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE routines (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 200),
  name text,
  doc jsonb NOT NULL, version integer NOT NULL CHECK (version > 0), server_seq bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false, device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE workout_sessions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 200),
  status text CHECK (status IN ('active', 'completed', 'discarded')),
  routine_id text, workout_id text,
  started_at timestamptz, finished_at timestamptz,
  doc jsonb NOT NULL, version integer NOT NULL CHECK (version > 0), server_seq bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false, device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id),
  CONSTRAINT workout_sessions_live_fields CHECK (deleted OR (status IS NOT NULL AND started_at IS NOT NULL))
);
CREATE INDEX workout_sessions_started_idx ON workout_sessions (user_id, started_at DESC) WHERE NOT deleted;

-- Projeção relacional dos treinos: reescrita na MESMA transação de cada gravação do treino.
CREATE TABLE workout_exercises (
  user_id uuid NOT NULL,
  session_id text NOT NULL,
  id text NOT NULL,
  position integer NOT NULL,
  exercise_key text NOT NULL,
  template_id text, catalog_id text, custom_exercise_id text,
  name text NOT NULL, muscle_group text,
  PRIMARY KEY (user_id, session_id, id),
  FOREIGN KEY (user_id, session_id) REFERENCES workout_sessions (user_id, id) ON DELETE CASCADE
);
CREATE INDEX workout_exercises_key_idx ON workout_exercises (user_id, exercise_key);

CREATE TABLE workout_sets (
  user_id uuid NOT NULL,
  session_id text NOT NULL,
  exercise_id text NOT NULL,
  id text NOT NULL,
  position integer NOT NULL,
  type text NOT NULL CHECK (type IN ('warmup', 'normal', 'drop')),
  status text NOT NULL CHECK (status IN ('pending', 'done', 'skipped')),
  weight_kg numeric, reps integer, duration_sec integer, distance_m numeric,
  completed_at timestamptz,
  PRIMARY KEY (user_id, session_id, exercise_id, id),
  FOREIGN KEY (user_id, session_id, exercise_id) REFERENCES workout_exercises (user_id, session_id, id) ON DELETE CASCADE
);

CREATE TABLE rotation_states (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 200),
  next_index integer,
  doc jsonb NOT NULL, version integer NOT NULL CHECK (version > 0), server_seq bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false, device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE day_overrides (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 200),
  routine_id text, date date, kind text CHECK (kind IN ('rest', 'workout')),
  doc jsonb NOT NULL, version integer NOT NULL CHECK (version > 0), server_seq bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false, device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE body_measurements (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 200),
  date date,
  doc jsonb NOT NULL, version integer NOT NULL CHECK (version > 0), server_seq bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false, device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE goals (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 200),
  type text, status text CHECK (status IN ('active', 'paused', 'archived')),
  doc jsonb NOT NULL, version integer NOT NULL CHECK (version > 0), server_seq bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false, device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE plan_entries (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 200),
  scope text CHECK (scope IN ('weekly', 'date')), weekday smallint CHECK (weekday BETWEEN 0 AND 6), date date,
  doc jsonb NOT NULL, version integer NOT NULL CHECK (version > 0), server_seq bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false, device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE calendar_decisions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 200),
  conflict_id text, date date,
  doc jsonb NOT NULL, version integer NOT NULL CHECK (version > 0), server_seq bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false, device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE custom_exercises (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 200),
  name text, archived boolean,
  doc jsonb NOT NULL, version integer NOT NULL CHECK (version > 0), server_seq bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false, device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE exercise_favorites (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 200),
  target text,
  doc jsonb NOT NULL, version integer NOT NULL CHECK (version > 0), server_seq bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false, device_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

-- Índices do cursor de sincronização (download por conta em ordem de server_seq).
CREATE INDEX user_settings_seq_idx ON user_settings (user_id, server_seq);
CREATE INDEX routines_seq_idx ON routines (user_id, server_seq);
CREATE INDEX workout_sessions_seq_idx ON workout_sessions (user_id, server_seq);
CREATE INDEX rotation_states_seq_idx ON rotation_states (user_id, server_seq);
CREATE INDEX day_overrides_seq_idx ON day_overrides (user_id, server_seq);
CREATE INDEX body_measurements_seq_idx ON body_measurements (user_id, server_seq);
CREATE INDEX goals_seq_idx ON goals (user_id, server_seq);
CREATE INDEX plan_entries_seq_idx ON plan_entries (user_id, server_seq);
CREATE INDEX calendar_decisions_seq_idx ON calendar_decisions (user_id, server_seq);
CREATE INDEX custom_exercises_seq_idx ON custom_exercises (user_id, server_seq);
CREATE INDEX exercise_favorites_seq_idx ON exercise_favorites (user_id, server_seq);

-- Versões substituídas (resolução de conflito, substituição por importação, exclusão): nada some sem rastro.
CREATE TABLE record_revisions (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection  text NOT NULL,
  entity_id   text NOT NULL,
  version     integer NOT NULL,
  doc         jsonb NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('conflict_resolution', 'import_replace', 'delete')),
  device_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX record_revisions_entity_idx ON record_revisions (user_id, collection, entity_id, id DESC);

-- Idempotência: o resultado de cada operação fica gravado; reenviar o mesmo op_id devolve o mesmo resultado.
CREATE TABLE sync_operations (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  op_id       uuid NOT NULL,
  device_id   uuid NOT NULL,
  collection  text NOT NULL,
  entity_id   text NOT NULL,
  result      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, op_id)
);
CREATE INDEX sync_operations_created_idx ON sync_operations (created_at);

-- Importação (backup ou perfil local): itens ficam na área de preparo e são efetivados numa única transação.
CREATE TABLE import_jobs (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_kind        text NOT NULL CHECK (source_kind IN ('backup_file', 'local_profile')),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  source_profile_id  text,
  policy             text NOT NULL CHECK (policy IN ('merge', 'replace')),
  status             text NOT NULL CHECK (status IN ('staging', 'committed', 'cancelled')),
  expected_items     integer NOT NULL CHECK (expected_items >= 0),
  report             jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  committed_at       timestamptz
);
CREATE INDEX import_jobs_user_idx ON import_jobs (user_id, created_at DESC);

CREATE TABLE import_job_items (
  job_id      uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  collection  text NOT NULL,
  entity_id   text NOT NULL,
  doc         jsonb NOT NULL,
  hash        text NOT NULL,
  PRIMARY KEY (job_id, collection, entity_id)
);

-- IA: cota diária por conta (reserva antes da chamada, acerto depois) e eventos só com metadados.
CREATE TABLE ai_usage_daily (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day         date NOT NULL,
  tokens      bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  requests    integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  PRIMARY KEY (user_id, day)
);

CREATE TABLE ai_usage_events (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  model         text NOT NULL,
  status        text NOT NULL,
  input_tokens  integer,
  output_tokens integer,
  duration_ms   integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_events_user_idx ON ai_usage_events (user_id, created_at DESC);
