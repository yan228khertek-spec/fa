// Схема бегущей строки. Источник истины — migrations/009_site_ticker.sql:
// тест admin-schema.test.ts сверяет эту константу с файлом миграции.
export const SITE_TICKER_DDL = `-- Бегущая строка на главной: стандартная строка (одна запись) и график акций по датам.
-- В период акции строка берёт текст и цвета акции, потом возвращается к стандартной.
-- Даты — календарные дни магазина (Омск), конец включительно. Идемпотентно: применяется
-- автоматически при старте админки и вручную:
-- psql "$DATABASE_URL" -f migrations/009_site_ticker.sql
CREATE TABLE IF NOT EXISTS site_ticker_default (
  id         smallint PRIMARY KEY CHECK (id = 1),
  items      jsonb NOT NULL,
  bg_color   text NOT NULL,
  text_color text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_ticker_schedules (
  id         bigserial PRIMARY KEY,
  title      text NOT NULL DEFAULT '',
  starts_on  date NOT NULL,
  ends_on    date NOT NULL,
  items      jsonb NOT NULL,
  bg_color   text NOT NULL,
  text_color text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_ticker_period_chk CHECK (ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS site_ticker_schedules_period_idx ON site_ticker_schedules (starts_on, ends_on);`;
