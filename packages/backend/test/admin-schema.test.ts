import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
