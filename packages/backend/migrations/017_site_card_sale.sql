-- Галочка «В распродажу» у карточки: попадает в раздел «Распродажа» (catalog.html?sale=1).
-- Идемпотентно: применяется автоматически при старте админки и вручную:
-- psql "$DATABASE_URL" -f migrations/017_site_card_sale.sql
ALTER TABLE site_cards ADD COLUMN IF NOT EXISTS on_sale boolean NOT NULL DEFAULT false;
