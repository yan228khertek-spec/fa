// Схема постов блога. Источник истины — migrations/016_site_posts.sql:
// тест admin-schema.test.ts сверяет эту константу с файлом миграции.
export const SITE_POSTS_DDL = `-- Блог на главной: посты из фото, заголовка, короткого описания и кнопки.
-- gender — раздел сайта (all — в женском и в мужском), badge — необязательная метка
-- рядом с заголовком («New»), sort — порядок ленты (меньше — выше).
-- Идемпотентно: применяется автоматически при старте админки и вручную:
-- psql "$DATABASE_URL" -f migrations/016_site_posts.sql
CREATE TABLE IF NOT EXISTS site_posts (
  id          bigserial PRIMARY KEY,
  gender      text NOT NULL DEFAULT 'all' CHECK (gender IN ('all', 'women', 'men')),
  title       text NOT NULL DEFAULT '',
  badge       text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  button_text text NOT NULL DEFAULT '',
  link        text NOT NULL DEFAULT '',
  image       text,
  active      boolean NOT NULL DEFAULT true,
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_posts_sort_idx ON site_posts (sort, id);`;
