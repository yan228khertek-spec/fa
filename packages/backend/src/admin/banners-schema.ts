// Схема баннеров главной. Источник истины — migrations/007_site_banners.sql:
// тест admin-schema.test.ts сверяет эту константу с файлом миграции.
export const SITE_BANNERS_DDL = `-- Баннеры главной страницы. Картинка для компьютера обязательна, для телефона — по желанию.
-- Точка фокуса (0–100 %, от левого/верхнего края) задаёт, какая часть картинки остаётся
-- в кадре при обрезке под узкий экран. Идемпотентно: применяется автоматически при старте
-- админки и вручную:
-- psql "$DATABASE_URL" -f migrations/007_site_banners.sql
CREATE TABLE IF NOT EXISTS site_banners (
  id           bigserial PRIMARY KEY,
  title        text NOT NULL DEFAULT '',
  subtitle     text NOT NULL DEFAULT '',
  button_text  text NOT NULL DEFAULT '',
  link         text NOT NULL DEFAULT '',
  theme        text NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark')),
  image        text,
  image_mobile text,
  focus_x      integer NOT NULL DEFAULT 50 CHECK (focus_x BETWEEN 0 AND 100),
  focus_y      integer NOT NULL DEFAULT 50 CHECK (focus_y BETWEEN 0 AND 100),
  mobile_focus_x integer NOT NULL DEFAULT 50 CHECK (mobile_focus_x BETWEEN 0 AND 100),
  mobile_focus_y integer NOT NULL DEFAULT 50 CHECK (mobile_focus_y BETWEEN 0 AND 100),
  active       boolean NOT NULL DEFAULT true,
  sort         integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_banners_sort_idx ON site_banners (sort, id);`;
