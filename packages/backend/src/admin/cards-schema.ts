// Схема карточек товаров. Источник истины — migrations/005_site_cards.sql:
// тест admin-schema.test.ts сверяет эту константу с файлом миграции.
export const SITE_CARDS_DDL = `-- Карточки товаров сайта: то, что менеджер заполняет руками поверх данных 1С.
-- Применяется и автоматически при старте админки (PgCardRepository), и вручную:
-- psql "$DATABASE_URL" -f migrations/005_site_cards.sql
--
-- Карточка ссылается на модель из staging по Ид (model_source_id = Ид товара до «#»),
-- без FK: staging перезаписывается обменом. Цены, остатки и размеры в карточке не
-- хранятся — они подклеиваются из staging при выдаче. Бренд карточки — из site_model_brand.
CREATE TABLE IF NOT EXISTS site_cards (
  id              bigserial PRIMARY KEY,
  model_source_id text NOT NULL,
  title           text,
  description     text NOT NULL DEFAULT '',
  characteristics jsonb NOT NULL DEFAULT '[]'::jsonb,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_cards_model_uniq UNIQUE (model_source_id)
);
CREATE INDEX IF NOT EXISTS site_cards_status_idx ON site_cards (status);

-- Фото карточки. Порядок — sort, главное фото — с наименьшим sort.
CREATE TABLE IF NOT EXISTS site_card_photos (
  id         bigserial PRIMARY KEY,
  card_id    bigint NOT NULL REFERENCES site_cards(id) ON DELETE CASCADE,
  file       text NOT NULL,
  sort       integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_card_photos_card_idx ON site_card_photos (card_id, sort);`;
