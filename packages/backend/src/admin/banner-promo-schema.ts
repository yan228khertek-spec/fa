// Допустимые места баннера, включая promo. Источник истины — migrations/012_site_banner_promo.sql:
// тест admin-schema.test.ts сверяет эту константу с файлом миграции.
export const SITE_BANNER_PROMO_DDL = `-- Третье место баннера: 'promo' — промо-баннер на главной между блоком парфюмерии и блоками
-- брендов. Расширяет допустимые значения placement (миграция 011), данные не трогает.
-- Идемпотентно: применяется автоматически при старте админки и вручную:
-- psql "$DATABASE_URL" -f migrations/012_site_banner_promo.sql
ALTER TABLE site_banners DROP CONSTRAINT IF EXISTS site_banners_placement_check;
ALTER TABLE site_banners ADD CONSTRAINT site_banners_placement_check CHECK (placement IN ('hero', 'perfume', 'promo'));`;
