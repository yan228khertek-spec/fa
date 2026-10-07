import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OFFERS_DDL } from '../src/offers/schema.js';

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

describe('миграция 003 и OFFERS_DDL', () => {
  it('не разъехались: автоприменение при старте = psql -f migrations/003', async () => {
    const file = await readFile(path.join(root, 'migrations', '003_offers.sql'), 'utf8');
    expect(normalize(OFFERS_DDL)).toBe(normalize(file));
  });

  it('все таблицы схемы предложений создаются идемпотентно', () => {
    const tables = [
      'price_types',
      'warehouses',
      'offers',
      'offer_prices',
      'offer_stocks',
      'offers_import_runs',
    ];
    for (const table of tables) {
      expect(OFFERS_DDL).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    }
    expect(OFFERS_DDL).not.toMatch(/\bDROP\b/i);
  });
});
