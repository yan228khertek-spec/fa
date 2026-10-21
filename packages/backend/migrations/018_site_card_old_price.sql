-- Старая (перечёркнутая) цена у карточки: задаётся вручную в админке, на сайте показывается
-- рядом с текущей ценой из 1С, только если она больше текущей. NULL — старой цены нет.
-- Идемпотентно: применяется автоматически при старте админки и вручную:
-- psql "$DATABASE_URL" -f migrations/018_site_card_old_price.sql
ALTER TABLE site_cards ADD COLUMN IF NOT EXISTS old_price numeric(12, 2) CHECK (old_price IS NULL OR old_price > 0);
