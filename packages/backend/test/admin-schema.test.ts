import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SITE_CARDS_DDL } from '../src/admin/cards-schema.js';
import { SITE_CARD_CATEGORY_DDL } from '../src/admin/card-category-schema.js';
import { SITE_TICKER_DDL } from '../src/admin/ticker-schema.js';
import { SITE_BANNER_PLACEMENT_DDL } from '../src/admin/banner-placement-schema.js';
import { SITE_BANNER_PROMO_DDL } from '../src/admin/banner-promo-schema.js';
import { SITE_BANNER_VIDEO_DDL } from '../src/admin/banner-video-schema.js';
import { SITE_BANNERS_DDL } from '../src/admin/banners-schema.js';
import { SITE_BRAND_HOME_DDL } from '../src/admin/home-schema.js';
import { SITE_BRANDS_DDL } from '../src/admin/schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function normalize(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replaceAll(/\s+/g, ' ');
}

describe('миграция 004 и SITE_BRANDS_DDL', () => {
  it('не разъехались: автоприменение = psql -f migrations/004', async () => {
    const file = await readFile(path.join(root, 'migrations', '004_site_brands.sql'), 'utf8');
    expect(normalize(SITE_BRANDS_DDL)).toBe(normalize(file));
  });

  it('все таблицы создаются идемпотентно и без FK на staging', () => {
    for (const t of [
      'site_brands',
      'site_brand_aliases',
      'site_brand_placements',
      'site_model_brand',
    ]) {
      expect(SITE_BRANDS_DDL).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`);
    }
    expect(SITE_BRANDS_DDL).not.toMatch(/\bDROP\b/i);
    expect(SITE_BRANDS_DDL).not.toMatch(/REFERENCES\s+(brands|products|product_variants)\b/);
  });
});

describe('миграция 005 и SITE_CARDS_DDL', () => {
  it('не разъехались: автоприменение = psql -f migrations/005', async () => {
    const file = await readFile(path.join(root, 'migrations', '005_site_cards.sql'), 'utf8');
    expect(normalize(SITE_CARDS_DDL)).toBe(normalize(file));
  });

  it('идемпотентна и не ссылается на staging', () => {
    for (const t of ['site_cards', 'site_card_photos']) {
      expect(SITE_CARDS_DDL).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`);
    }
    expect(SITE_CARDS_DDL).not.toMatch(/\bDROP\b/i);
    expect(SITE_CARDS_DDL).not.toMatch(/REFERENCES\s+(products|product_variants|offers)\b/);
  });
});

describe('миграция 006 и SITE_BRAND_HOME_DDL', () => {
  it('не разъехались: автоприменение = psql -f migrations/006', async () => {
    const file = await readFile(path.join(root, 'migrations', '006_site_brand_home.sql'), 'utf8');
    expect(normalize(SITE_BRAND_HOME_DDL)).toBe(normalize(file));
  });

  it('идемпотентна и ничего не удаляет', () => {
    expect(SITE_BRAND_HOME_DDL).toContain('ADD COLUMN IF NOT EXISTS show_on_home');
    expect(SITE_BRAND_HOME_DDL).not.toMatch(/\bDROP\b/i);
  });
});

describe('миграция 007 и SITE_BANNERS_DDL', () => {
  it('не разъехались: автоприменение = psql -f migrations/007', async () => {
    const file = await readFile(path.join(root, 'migrations', '007_site_banners.sql'), 'utf8');
    expect(normalize(SITE_BANNERS_DDL)).toBe(normalize(file));
  });

  it('идемпотентна и ничего не удаляет', () => {
    expect(SITE_BANNERS_DDL).toContain('CREATE TABLE IF NOT EXISTS site_banners');
    expect(SITE_BANNERS_DDL).not.toMatch(/\bDROP\b/i);
  });
});

describe('миграция 008 и SITE_CARD_CATEGORY_DDL', () => {
  it('не разъехались: автоприменение = psql -f migrations/008', async () => {
    const file = await readFile(
      path.join(root, 'migrations', '008_site_card_category.sql'),
      'utf8',
    );
    expect(normalize(SITE_CARD_CATEGORY_DDL)).toBe(normalize(file));
  });

  it('идемпотентна и ничего не удаляет', () => {
    expect(SITE_CARD_CATEGORY_DDL).toContain('ADD COLUMN IF NOT EXISTS category');
    expect(SITE_CARD_CATEGORY_DDL).not.toMatch(/\bDROP\b/i);
  });
});

describe('миграция 009 и SITE_TICKER_DDL', () => {
  it('не разъехались: автоприменение = psql -f migrations/009', async () => {
    const file = await readFile(path.join(root, 'migrations', '009_site_ticker.sql'), 'utf8');
    expect(normalize(SITE_TICKER_DDL)).toBe(normalize(file));
  });

  it('идемпотентна и ничего не удаляет', () => {
    expect(SITE_TICKER_DDL).toContain('CREATE TABLE IF NOT EXISTS site_ticker_schedules');
    expect(SITE_TICKER_DDL).not.toMatch(/\bDROP\b/i);
  });
});

describe('миграция 010 и SITE_BANNER_VIDEO_DDL', () => {
  it('не разъехались: автоприменение = psql -f migrations/010', async () => {
    const file = await readFile(path.join(root, 'migrations', '010_site_banner_video.sql'), 'utf8');
    expect(normalize(SITE_BANNER_VIDEO_DDL)).toBe(normalize(file));
  });

  it('идемпотентна и ничего не удаляет', () => {
    expect(SITE_BANNER_VIDEO_DDL).toContain('ADD COLUMN IF NOT EXISTS video ');
    expect(SITE_BANNER_VIDEO_DDL).not.toMatch(/\bDROP\b/i);
  });
});

describe('миграция 011 и SITE_BANNER_PLACEMENT_DDL', () => {
  it('не разъехались: автоприменение = psql -f migrations/011', async () => {
    const file = await readFile(
      path.join(root, 'migrations', '011_site_banner_placement.sql'),
      'utf8',
    );
    expect(normalize(SITE_BANNER_PLACEMENT_DDL)).toBe(normalize(file));
  });

  it('идемпотентна, старые баннеры остаются в hero и ничего не удаляет', () => {
    expect(SITE_BANNER_PLACEMENT_DDL).toContain('ADD COLUMN IF NOT EXISTS placement');
    expect(SITE_BANNER_PLACEMENT_DDL).toContain("DEFAULT 'hero'");
    expect(SITE_BANNER_PLACEMENT_DDL).not.toMatch(/\bDROP\b/i);
  });
});

describe('миграция 012 и SITE_BANNER_PROMO_DDL', () => {
  it('не разъехались: автоприменение = psql -f migrations/012', async () => {
    const file = await readFile(path.join(root, 'migrations', '012_site_banner_promo.sql'), 'utf8');
    expect(normalize(SITE_BANNER_PROMO_DDL)).toBe(normalize(file));
  });

  it('только расширяет список мест и не трогает данные', () => {
    expect(SITE_BANNER_PROMO_DDL).toContain("'promo'");
    expect(SITE_BANNER_PROMO_DDL).not.toMatch(/\b(DELETE|TRUNCATE|DROP TABLE|DROP COLUMN)\b/i);
  });
});
