// Колонки видео баннера. Источник истины — migrations/010_site_banner_video.sql:
// тест admin-schema.test.ts сверяет эту константу с файлом миграции.
export const SITE_BANNER_VIDEO_DDL = `-- Видео в баннере главной: ролик для компьютера и для телефона (по желанию).
-- Картинка баннера остаётся обязательной — она служит постером, пока видео грузится.
-- Идемпотентно: применяется автоматически при старте админки и вручную:
-- psql "$DATABASE_URL" -f migrations/010_site_banner_video.sql
ALTER TABLE site_banners ADD COLUMN IF NOT EXISTS video text;
ALTER TABLE site_banners ADD COLUMN IF NOT EXISTS video_mobile text;`;
