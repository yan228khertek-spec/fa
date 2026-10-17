-- Место баннера: 'hero' — слайдер вверху главной, 'perfume' — баннер блока парфюмерии
-- перед карточками. Старые баннеры остаются в hero. Идемпотентно: применяется
-- автоматически при старте админки и вручную:
-- psql "$DATABASE_URL" -f migrations/011_site_banner_placement.sql
ALTER TABLE site_banners ADD COLUMN IF NOT EXISTS placement text NOT NULL DEFAULT 'hero' CHECK (placement IN ('hero', 'perfume'));
