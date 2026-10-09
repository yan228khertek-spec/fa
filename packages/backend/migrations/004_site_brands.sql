-- Витринный слой брендов (сайт): то, чего нет в 1С и что задаёт админка.
-- Применяется и автоматически при старте админки (PgSiteBrandRepository), и вручную:
-- psql "$DATABASE_URL" -f migrations/004_site_brands.sql
--
-- Бренды в 1С не приходят (они «зашиты» в названия), поэтому словарь брендов ведём
-- на стороне сайта и сопоставляем с моделями по названию. Таблицы staging
-- (001–003) обмен перезаписывает, эти — нет, ссылок на staging через FK нет.
CREATE TABLE IF NOT EXISTS site_brands (
  id         bigserial PRIMARY KEY,
  slug       text NOT NULL,
  name       text NOT NULL,
  photo_file text,
  logo_file  text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_brands_slug_uniq UNIQUE (slug)
);

-- Написания бренда в названиях товаров (в нижнем регистре, без диакритики).
-- Само название бренда тоже участвует в поиске, отдельной строкой его хранить не нужно.
CREATE TABLE IF NOT EXISTS site_brand_aliases (
  alias    text PRIMARY KEY,
  brand_id bigint NOT NULL REFERENCES site_brands(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS site_brand_aliases_brand_idx ON site_brand_aliases (brand_id);

-- Раздел сайта, где показывается бренд, и «Топ бренды» раздела.
CREATE TABLE IF NOT EXISTS site_brand_placements (
  brand_id bigint NOT NULL REFERENCES site_brands(id) ON DELETE CASCADE,
  gender   text NOT NULL CHECK (gender IN ('men', 'women')),
  is_top   boolean NOT NULL DEFAULT false,
  top_sort integer NOT NULL DEFAULT 0,
  CONSTRAINT site_brand_placements_pk PRIMARY KEY (brand_id, gender)
);
CREATE INDEX IF NOT EXISTS site_brand_placements_top_idx ON site_brand_placements (gender, is_top, top_sort);

-- Бренд модели (модель = Ид товара до «#»). origin: auto — найден по алиасам,
-- manual — назначен оператором; при пересчёте manual не трогаем.
CREATE TABLE IF NOT EXISTS site_model_brand (
  model_source_id text PRIMARY KEY,
  brand_id        bigint NOT NULL REFERENCES site_brands(id) ON DELETE CASCADE,
  origin          text NOT NULL CHECK (origin IN ('auto', 'manual')),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_model_brand_brand_idx ON site_model_brand (brand_id);
