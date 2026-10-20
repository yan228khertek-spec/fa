-- «Для кого»: раздел сайта, где показывается баннер или карточка: all (оба), women, men.
-- Всё существующее остаётся «all», то есть видно и в женском, и в мужском разделе.
-- Идемпотентно: применяется автоматически при старте админки и вручную:
-- psql "$DATABASE_URL" -f migrations/015_site_audience.sql
ALTER TABLE site_banners ADD COLUMN IF NOT EXISTS gender text NOT NULL DEFAULT 'all' CHECK (gender IN ('all', 'women', 'men'));
ALTER TABLE site_cards ADD COLUMN IF NOT EXISTS gender text NOT NULL DEFAULT 'all' CHECK (gender IN ('all', 'women', 'men'));
