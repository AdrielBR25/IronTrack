-- IronTrack — Assistente IA central (Fase 00). Ver docs/IA_CENTRAL.md.
-- Só tabelas NOVAS: nenhuma tabela existente é alterada e nenhum dado existente é migrado.
-- Tudo pertence a users(id) com ON DELETE CASCADE (excluir a conta apaga conversas, memórias e propostas).

-- Aviso de processamento de dados aceito pela conta (versão do texto) e preferências do assistente.
CREATE TABLE assistant_settings (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notice_version      integer,
  notice_accepted_at  timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assistant_conversations (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  title_source  text NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto', 'user')),
  -- Resumo das mensagens antigas, gerado pela IA (contexto de conversas longas; NÃO é registro do app).
  summary       text CHECK (summary IS NULL OR char_length(summary) <= 6000),
  -- Última mensagem (seq) coberta pelo resumo.
  summary_upto  bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_conversations_user_idx ON assistant_conversations (user_id, updated_at DESC);

CREATE TABLE assistant_messages (
  seq              bigserial PRIMARY KEY,
  id               uuid NOT NULL UNIQUE,
  conversation_id  uuid NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- user: escrita pela pessoa; assistant: gerada pela IA; event: registro do próprio app (ex.: proposta aprovada).
  role             text NOT NULL CHECK (role IN ('user', 'assistant', 'event')),
  content          text NOT NULL CHECK (char_length(content) <= 40000),
  status           text NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'error', 'cancelled')),
  model            text,
  -- Ferramentas usadas na resposta: só nomes e se deram certo (nunca os dados devolvidos).
  tools            jsonb NOT NULL DEFAULT '[]'::jsonb,
  action_ids       jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_tokens     integer,
  output_tokens    integer,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_messages_conv_idx ON assistant_messages (conversation_id, seq);
CREATE INDEX assistant_messages_user_idx ON assistant_messages (user_id);

-- Preferências explícitas que a pessoa pediu para lembrar (separadas dos registros e das sugestões da IA).
CREATE TABLE assistant_memories (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content     text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 500),
  source      text NOT NULL CHECK (source IN ('user', 'ai_approved')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_memories_user_idx ON assistant_memories (user_id, created_at);

-- Propostas de escrita da IA. Nada é aplicado sem a aprovação explícita da pessoa (POST .../approve).
CREATE TABLE assistant_actions (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('create_routine', 'update_routine', 'save_preference')),
  status           text NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'expired', 'failed')),
  title            text NOT NULL CHECK (char_length(title) <= 200),
  rationale        text CHECK (rationale IS NULL OR char_length(rationale) <= 600),
  -- Argumentos já validados da ferramenta (reaplicados e revalidados na aprovação).
  payload          jsonb NOT NULL,
  preview          jsonb NOT NULL,
  target_id        text,
  -- Versão do registro quando a proposta foi feita: se mudou, a aprovação é recusada (nada de sobrescrever).
  base_version     integer,
  result           jsonb,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  decided_at       timestamptz
);
CREATE INDEX assistant_actions_user_idx ON assistant_actions (user_id, created_at DESC);
CREATE INDEX assistant_actions_conv_idx ON assistant_actions (conversation_id);

-- Cota diária do assistente por conta (separada da cota da IA anterior).
CREATE TABLE assistant_usage_daily (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day       date NOT NULL,
  tokens    bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  messages  integer NOT NULL DEFAULT 0 CHECK (messages >= 0),
  PRIMARY KEY (user_id, day)
);
