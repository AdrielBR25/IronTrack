-- IronTrack Life — Fase 03: reconhecimento de refeições por foto (docs/ALIMENTACAO_FOTO.md).
-- Só colunas NOVAS com valor padrão; nenhum dado existente é alterado. As fotos NÃO são guardadas em lugar nenhum:
--  - assistant_settings: aceite do aviso de envio de fotos à OpenAI (separado do aviso do chat);
--  - assistant_usage_daily.photos: contador diário de análises (limite de custo por conta);
--  - assistant_messages.attachments: só a MARCA de que a mensagem teve foto ([{"type":"image","stored":false}]),
--    nunca a imagem.
ALTER TABLE assistant_settings
  ADD COLUMN photo_notice_version     integer,
  ADD COLUMN photo_notice_accepted_at timestamptz;

ALTER TABLE assistant_usage_daily
  ADD COLUMN photos integer NOT NULL DEFAULT 0 CHECK (photos >= 0);

ALTER TABLE assistant_messages
  ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
