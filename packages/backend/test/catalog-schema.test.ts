import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATALOG_DDL } from '../src/catalog/schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Убирает комментарии и лишние пробелы — сравниваем сам SQL. */
function normalize(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replaceAll(/\s+/g, ' ');
}

describe('миграция 002 и CATALOG_DDL', () => {
  it('не разъехались: автоприменение при старте = psql -f migrations/002', async () => {
    const file = await readFile(path.join(root, 'migrations', '002_catalog_staging.sql'), 'utf8');
    expect(normalize(CATALOG_DDL)).toBe(normalize(file));
  });

  it('все таблицы staging-схемы создаются идемпотентно', () => {
    const tables = [
      'categories',
      'brands',
      'properties',
      'property_options',
      'products',
      'product_variants',
      'product_categories',
      'product_properties',
      'product_images_meta',
      'catalog_import_runs',
    ];
    for (const table of tables) {
      expect(CATALOG_DDL).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    }
    expect(CATALOG_DDL).not.toMatch(/\bDROP\b/i);
  });
});
