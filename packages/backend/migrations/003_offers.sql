-- Staging-схема предложений из 1С («Обмен с сайтом», offers.xml). Этап 3 мастердока.
-- Применяется и автоматически при старте приёмника (PgOffersRepository), и вручную:
-- psql "$DATABASE_URL" -f migrations/003_offers.sql
--
-- Связи — по идентификаторам из 1С (source_id), БЕЗ FK-ограничений: предложения
-- могут прийти раньше товаров (отдельная выгрузка цен/остатков), и законная
-- выгрузка не должна падать на констрейнте. Целостность сверяем запросами (этап 6).
CREATE TABLE IF NOT EXISTS price_types (
  source     text NOT NULL DEFAULT '1c',
  source_id  text NOT NULL,
  name       text NOT NULL,
  currency   text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_types_pk PRIMARY KEY (source, source_id)
);

-- Склады (ПакетПредложений/Склады). Пустой source_id не используется:
-- общий остаток без разбивки хранится в offer_stocks с warehouse_source_id = ''.
CREATE TABLE IF NOT EXISTS warehouses (
  source     text NOT NULL DEFAULT '1c',
  source_id  text NOT NULL,
  name       text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warehouses_pk PRIMARY KEY (source, source_id)
);

-- Предложение: цена/остаток для товара или SKU («Ид» либо «Ид#ИдХарактеристики»).
-- article/name/characteristics/is_deleted допускают NULL = «из 1С не приходило»:
-- инкрементальная выгрузка «только остатки» шлёт минимальное Предложение, и
-- NULL в пришедшей строке означает «не менять существующее» (coalesce в upsert).
CREATE TABLE IF NOT EXISTS offers (
  id                bigserial PRIMARY KEY,
  source            text NOT NULL DEFAULT '1c',
  source_id         text NOT NULL,
  product_source_id text NOT NULL,
  char_source_id    text,
  article           text,
  name              text,
  characteristics   jsonb,
  is_deleted        boolean,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offers_source_uniq UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS offers_product_idx ON offers (source, product_source_id);

-- Цены предложения (Предложение/Цены/Цена). Одна строка на тип цены.
CREATE TABLE IF NOT EXISTS offer_prices (
  source               text NOT NULL DEFAULT '1c',
  offer_source_id      text NOT NULL,
  price_type_source_id text NOT NULL,
  value                numeric(14,2) NOT NULL,
  currency             text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offer_prices_pk PRIMARY KEY (source, offer_source_id, price_type_source_id)
);

-- Остатки предложения: warehouse_source_id = '' — общий тег Количество,
-- иначе <Склад ИдСклада КоличествоНаСкладе> с разбивкой по складам.
CREATE TABLE IF NOT EXISTS offer_stocks (
  source              text NOT NULL DEFAULT '1c',
  offer_source_id     text NOT NULL,
  warehouse_source_id text NOT NULL DEFAULT '',
  quantity            numeric(14,3) NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offer_stocks_pk PRIMARY KEY (source, offer_source_id, warehouse_source_id)
);

-- Журнал загрузок offers.xml: счётчики для сверки с 1С (этап 6) и DoD этапа 3.
CREATE TABLE IF NOT EXISTS offers_import_runs (
  id             bigserial PRIMARY KEY,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  filename       text NOT NULL,
  schema_version text,
  generated_at   text,
  only_changes   boolean NOT NULL DEFAULT false,
  price_types    integer NOT NULL DEFAULT 0,
  warehouses     integer NOT NULL DEFAULT 0,
  offers         integer NOT NULL DEFAULT 0,
  prices         integer NOT NULL DEFAULT 0,
  stocks         integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'running',
  error          text
);
CREATE INDEX IF NOT EXISTS offers_import_runs_started_idx ON offers_import_runs (started_at);
