// Схема поля «Для кого» у баннеров и карточек. Источник истины — migrations/015_site_audience.sql:
// тест admin-schema.test.ts сверяет SITE_AUDIENCE_DDL с файлом миграции. Каждый репозиторий
// применяет только свою таблицу: баннеры и карточки поднимаются независимо друг от друга.
export const SITE_BANNER_AUDIENCE_DDL = `ALTER TABLE site_banners ADD COLUMN IF NOT EXISTS gender text NOT NULL DEFAULT 'all' CHECK (gender IN ('all', 'women', 'men'));`;
export const SITE_CARD_AUDIENCE_DDL = `ALTER TABLE site_cards ADD COLUMN IF NOT EXISTS gender text NOT NULL DEFAULT 'all' CHECK (gender IN ('all', 'women', 'men'));`;
export const SITE_AUDIENCE_DDL = `-- «Для кого»: раздел сайта, где показывается баннер или карточка: all (оба), women, men.
-- Всё существующее остаётся «all», то есть видно и в женском, и в мужском разделе.
-- Идемпотентно: применяется автоматически при старте админки и вручную:
-- psql "$DATABASE_URL" -f migrations/015_site_audience.sql
${SITE_BANNER_AUDIENCE_DDL}
${SITE_CARD_AUDIENCE_DDL}`;
