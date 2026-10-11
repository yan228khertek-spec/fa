-- Флаг бренда «Показывать на главной»: бренд выводится отдельным блоком на главной странице сайта
-- (последние опубликованные карточки бренда). Идемпотентно: применяется автоматически при старте
-- админки и вручную:
-- psql "$DATABASE_URL" -f migrations/006_site_brand_home.sql
ALTER TABLE site_brands ADD COLUMN IF NOT EXISTS show_on_home boolean NOT NULL DEFAULT false;
