-- Журнал запросов «Обмена с сайтом». Применяется и автоматически при старте
-- приёмника (PgExchangeLog), и вручную: psql "$DATABASE_URL" -f migrations/001_exchange_log.sql
CREATE TABLE IF NOT EXISTS exchange_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL,
  type        text NOT NULL,
  mode        text NOT NULL,
  filename    text,
  body_bytes  bigint NOT NULL DEFAULT 0,
  result      text NOT NULL,
  detail      text
);
CREATE INDEX IF NOT EXISTS exchange_log_at_idx ON exchange_log (at);
