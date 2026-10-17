-- Шапка страницы бренда: обложка (для компьютера и своя для телефона), заголовок и описание.
-- Всё необязательное: пока ничего не заполнено, страница бренда выглядит как раньше.
-- Идемпотентно: применяется автоматически при старте админки и вручную:
-- psql "$DATABASE_URL" -f migrations/013_site_brand_hero.sql
ALTER TABLE site_brands ADD COLUMN IF NOT EXISTS cover_file text;
ALTER TABLE site_brands ADD COLUMN IF NOT EXISTS cover_mobile_file text;
ALTER TABLE site_brands ADD COLUMN IF NOT EXISTS hero_title text NOT NULL DEFAULT '';
ALTER TABLE site_brands ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
