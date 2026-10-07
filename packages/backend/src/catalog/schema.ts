// Схема staging-каталога. Источник истины — migrations/002_catalog_staging.sql:
// тест catalog-schema.test.ts сверяет эту константу с файлом миграции, чтобы
// автоприменение при старте и ручной psql -f не разъехались.
export const CATALOG_DDL = `-- Staging-схема каталога из 1С («Обмен с сайтом», import.xml). Этап 2 мастердока.
-- Применяется и автоматически при старте приёмника (PgCatalogRepository), и вручную:
-- psql "$DATABASE_URL" -f migrations/002_catalog_staging.sql
--
-- Связи между сущностями — по идентификаторам из 1С (source_id), БЕЗ FK-ограничений:
-- выгрузка инкрементальна («СодержитТолькоИзменения») и элементы могут прийти
-- частями и не по порядку (характеристика раньше родителя). Целостность проверяем
-- запросами сверки (этап 6), а не констрейнтами, иначе законная выгрузка упадёт.
CREATE TABLE IF NOT EXISTS categories (
  id               bigserial PRIMARY KEY,
  source           text NOT NULL DEFAULT '1c',
  source_id        text NOT NULL,
  parent_source_id text,
  name             text NOT NULL,
  level            integer NOT NULL DEFAULT 0,
  sort_order       integer NOT NULL DEFAULT 0,
  is_deleted       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_source_uniq UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS categories_parent_idx ON categories (source, parent_source_id);

CREATE TABLE IF NOT EXISTS brands (
  id         bigserial PRIMARY KEY,
  source     text NOT NULL DEFAULT '1c',
  source_id  text NOT NULL,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brands_source_uniq UNIQUE (source, source_id)
);

-- Свойства классификатора (Классификатор/Свойства/Свойство).
CREATE TABLE IF NOT EXISTS properties (
  id         bigserial PRIMARY KEY,
  source     text NOT NULL DEFAULT '1c',
  source_id  text NOT NULL,
  name       text NOT NULL,
  value_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT properties_source_uniq UNIQUE (source, source_id)
);

-- Варианты значений свойства (ВариантыЗначений/Справочник: ИдЗначения → Значение).
CREATE TABLE IF NOT EXISTS property_options (
  source              text NOT NULL DEFAULT '1c',
  property_source_id  text NOT NULL,
  source_id           text NOT NULL,
  value               text NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT property_options_pk PRIMARY KEY (source, property_source_id, source_id)
);

-- Товар = модель («одна модель — одна карточка»). Характеристики — в product_variants.
CREATE TABLE IF NOT EXISTS products (
  id                 bigserial PRIMARY KEY,
  source             text NOT NULL DEFAULT '1c',
  source_id          text NOT NULL,
  article            text,
  name               text NOT NULL,
  full_name          text,
  description        text,
  brand_source_id    text,
  category_source_id text,
  base_unit          text,
  is_deleted         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_source_uniq UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS products_article_idx ON products (source, article);
CREATE INDEX IF NOT EXISTS products_category_idx ON products (source, category_source_id);

-- SKU: Ид вида «Ид#ИдХарактеристики». Размер/цвет приходят в ХарактеристикиТовара
-- (import.xml) и в Характеристиках предложений (offers.xml, этап 3).
-- ⚠️ Правило разбора size/color уточняется по итогам обследования 1С.
CREATE TABLE IF NOT EXISTS product_variants (
  id                 bigserial PRIMARY KEY,
  source             text NOT NULL DEFAULT '1c',
  source_id          text NOT NULL,
  product_source_id  text NOT NULL,
  char_source_id     text,
  article            text,
  name               text,
  size               text,
  color              text,
  characteristics    jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_deleted         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_variants_source_uniq UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS product_variants_product_idx ON product_variants (source, product_source_id);

-- Товар может лежать в нескольких группах (Товар/Группы/Ид).
CREATE TABLE IF NOT EXISTS product_categories (
  source             text NOT NULL DEFAULT '1c',
  product_source_id  text NOT NULL,
  category_source_id text NOT NULL,
  CONSTRAINT product_categories_pk PRIMARY KEY (source, product_source_id, category_source_id)
);
CREATE INDEX IF NOT EXISTS product_categories_category_idx ON product_categories (source, category_source_id);

-- Значения свойств товара (Товар/ЗначенияСвойств). Свойство может иметь
-- несколько значений, поэтому value_raw входит в первичный ключ.
CREATE TABLE IF NOT EXISTS product_properties (
  source             text NOT NULL DEFAULT '1c',
  product_source_id  text NOT NULL,
  property_source_id text NOT NULL,
  value_raw          text NOT NULL,
  CONSTRAINT product_properties_pk PRIMARY KEY (source, product_source_id, property_source_id, value_raw)
);

-- Пути картинок из выгрузки (Товар/Картинка → import_files/...). Сами файлы
-- лежат в spool/unpacked; перенос в хранилище витрины — отдельная задача.
CREATE TABLE IF NOT EXISTS product_images_meta (
  source           text NOT NULL DEFAULT '1c',
  owner_kind       text NOT NULL DEFAULT 'product',
  owner_source_id  text NOT NULL,
  path             text NOT NULL,
  sort_order       integer NOT NULL DEFAULT 0,
  CONSTRAINT product_images_meta_pk PRIMARY KEY (source, owner_kind, owner_source_id, path)
);

-- Журнал загрузок каталога: счётчики для сверки с 1С (этап 6) и для DoD этапа 2.
CREATE TABLE IF NOT EXISTS catalog_import_runs (
  id             bigserial PRIMARY KEY,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  filename       text NOT NULL,
  schema_version text,
  generated_at   text,
  only_changes   boolean NOT NULL DEFAULT false,
  categories     integer NOT NULL DEFAULT 0,
  brands         integer NOT NULL DEFAULT 0,
  properties     integer NOT NULL DEFAULT 0,
  products       integer NOT NULL DEFAULT 0,
  variants       integer NOT NULL DEFAULT 0,
  images         integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'running',
  error          text
);
CREATE INDEX IF NOT EXISTS catalog_import_runs_started_idx ON catalog_import_runs (started_at);
`;
