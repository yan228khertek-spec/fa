import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildImportXml, writeImportXml, type ImportSpec } from '../src/catalog/fixtures.js';
import { importCatalogFile } from '../src/catalog/import-runner.js';
import { PgCatalogRepository } from '../src/catalog/pg.js';

/**
 * Интеграционные тесты staging-схемы против живого PostgreSQL.
 * Запускаются только при заданном TEST_DATABASE_URL, поэтому CI без БД
 * (lint + vitest) остаётся зелёным:
 *   TEST_DATABASE_URL=postgresql://fa@127.0.0.1:5432/fa_test npm test -w @fa/backend
 */
const url = process.env.TEST_DATABASE_URL;

const TABLES = [
  'catalog_import_runs',
  'product_images_meta',
  'product_properties',
  'product_categories',
  'product_variants',
  'products',
  'property_options',
  'properties',
  'brands',
  'categories',
];

const SPEC: ImportSpec = {
  groups: [
    {
      id: 'g1',
      name: 'Женская одежда',
      children: [{ id: 'g1-1', name: 'Платья', children: [{ id: 'g1-1-1', name: 'Миди' }] }],
    },
  ],
  properties: [
    { id: 'prop-size', name: 'Размер', options: [{ id: 's-44', value: '44' }] },
    { id: 'prop-color', name: 'Цвет', options: [{ id: 'c-red', value: 'Красный' }] },
  ],
  products: [
    {
      id: 'p1',
      article: 'ART-1',
      name: 'Платье',
      groups: ['g1-1', 'g1-1-1'],
      brand: { id: 'b1', name: 'Gerry Weber' },
      images: ['import_files/p1.jpg', 'import_files/p1-2.jpg'],
      props: [{ id: 'prop-color', values: ['c-red'] }],
    },
    {
      id: 'p1#ch1',
      name: 'Платье 44 Красный',
      chars: [
        { name: 'Размер', value: '44' },
        { name: 'Цвет', value: 'Красный' },
      ],
    },
  ],
};

describe.skipIf(!url)('PostgreSQL staging-каталог', () => {
  let pool: pg.Pool;
  let repo: PgCatalogRepository;
  let dir: string;

  const count = async (table: string): Promise<number> => {
    const res = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    return Number(res.rows[0]?.n ?? 0);
  };

  const counts = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const table of TABLES) out[table] = await count(table);
    return out;
  };

  const load = async (spec: ImportSpec, name = 'import.xml') => {
    const file = path.join(dir, name);
    await writeImportXml(file, buildImportXml(spec));
    return importCatalogFile(repo, file, 'import.xml');
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    repo = new PgCatalogRepository(url as string);
    await repo.ready();
  });

  afterAll(async () => {
    await repo.close();
    await pool.end();
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fa-pg-'));
    await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY`);
    return async () => {
      await rm(dir, { recursive: true, force: true });
    };
  });

  it('миграция 002 применяется идемпотентно', async () => {
    await repo.ready();
    const res = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() ORDER BY table_name`,
    );
    const present = res.rows.map((r) => r.table_name);
    for (const table of TABLES) expect(present).toContain(table);
  });

  it('первая загрузка раскладывает каталог по таблицам', async () => {
    const summary = await load(SPEC);
    expect(summary.products).toBe(1);
    expect(summary.variants).toBe(1);

    expect(await counts()).toMatchObject({
      categories: 3,
      brands: 1,
      properties: 2,
      property_options: 2,
      products: 1,
      product_variants: 1,
      product_categories: 2,
      product_properties: 1,
      product_images_meta: 2,
      catalog_import_runs: 1,
    });

    const cat = await pool.query(
      `SELECT parent_source_id, level, sort_order FROM categories WHERE source_id = 'g1-1-1'`,
    );
    expect(cat.rows[0]).toMatchObject({ parent_source_id: 'g1-1', level: 2, sort_order: 0 });

    const prod = await pool.query(
      `SELECT article, brand_source_id, category_source_id FROM products WHERE source_id = 'p1'`,
    );
    expect(prod.rows[0]).toMatchObject({
      article: 'ART-1',
      brand_source_id: 'b1',
      category_source_id: 'g1-1',
    });

    const variant = await pool.query(
      `SELECT product_source_id, char_source_id, size, color, characteristics
         FROM product_variants WHERE source_id = 'p1#ch1'`,
    );
    expect(variant.rows[0]).toMatchObject({
      product_source_id: 'p1',
      char_source_id: 'ch1',
      size: '44',
      color: 'Красный',
      characteristics: { Размер: '44', Цвет: 'Красный' },
    });

    const images = await pool.query<{ path: string; sort_order: number }>(
      `SELECT path, sort_order FROM product_images_meta ORDER BY sort_order`,
    );
    expect(images.rows).toEqual([
      { path: 'import_files/p1.jpg', sort_order: 0 },
      { path: 'import_files/p1-2.jpg', sort_order: 1 },
    ]);

    const run = await pool.query(`SELECT status, products, variants FROM catalog_import_runs`);
    expect(run.rows[0]).toMatchObject({ status: 'success', products: 1, variants: 1 });
  });

  it('повторная загрузка того же файла не меняет ни строк, ни updated_at', async () => {
    await load(SPEC);
    const before = await counts();
    const stamps = await pool.query<{ p: string; v: string; c: string }>(
      `SELECT (SELECT max(updated_at)::text FROM products) AS p,
              (SELECT max(updated_at)::text FROM product_variants) AS v,
              (SELECT max(updated_at)::text FROM categories) AS c`,
    );

    await load(SPEC);

    const after = await counts();
    expect({ ...after, catalog_import_runs: before.catalog_import_runs }).toEqual(before);
    expect(after.catalog_import_runs).toBe(2);
    const again = await pool.query<{ p: string; v: string; c: string }>(
      `SELECT (SELECT max(updated_at)::text FROM products) AS p,
              (SELECT max(updated_at)::text FROM product_variants) AS v,
              (SELECT max(updated_at)::text FROM categories) AS c`,
    );
    expect(again.rows[0]).toEqual(stamps.rows[0]);
  });

  it('изменённый товар обновляется, исчезнувшие связи убираются', async () => {
    await load(SPEC);
    const changed: ImportSpec = {
      ...SPEC,
      onlyChanges: true,
      products: [
        {
          id: 'p1',
          article: 'ART-1',
          name: 'Платье миди',
          groups: ['g1-1'],
          brand: { id: 'b1', name: 'Gerry Weber' },
          images: ['import_files/p1.jpg'],
        },
      ],
    };
    await load(changed, 'import2.xml');

    const prod = await pool.query<{ name: string }>(
      `SELECT name FROM products WHERE source_id = 'p1'`,
    );
    expect(prod.rows[0]?.name).toBe('Платье миди');
    expect(await count('products')).toBe(1);
    // связи и картинки заменены на пришедшие
    expect(await count('product_categories')).toBe(1);
    expect(await count('product_images_meta')).toBe(1);
    expect(await count('product_properties')).toBe(0);
    // инкремент не тронул характеристику, которой не было в файле
    expect(await count('product_variants')).toBe(1);
  });

  it('битый файл: прогон помечен failure, каталог не меняется', async () => {
    await load(SPEC);
    const before = await counts();
    const file = path.join(dir, 'broken.xml');
    const xml = buildImportXml(SPEC);
    await writeImportXml(file, xml.slice(0, 400));

    await expect(importCatalogFile(repo, file, 'import.xml')).rejects.toThrow();

    const run = await pool.query<{ status: string; error: string }>(
      `SELECT status, error FROM catalog_import_runs ORDER BY id DESC LIMIT 1`,
    );
    expect(run.rows[0]?.status).toBe('failure');
    expect(run.rows[0]?.error).toBeTruthy();
    const after = await counts();
    expect({ ...after, catalog_import_runs: before.catalog_import_runs }).toEqual(before);
  });

  it('товары с десятками значений свойств не пробивают лимит параметров PostgreSQL', async () => {
    // Регрессия на находку 1 ревью: раньше батч строился как
    // VALUES ($1,…,$N) и 600 товаров × 40 значений давали 17 664 параметра.
    const properties = Array.from({ length: 40 }, (_, i) => ({
      id: `prop-${i}`,
      name: `Свойство ${i}`,
      options: [{ id: `v-${i}`, value: `Значение ${i}` }],
    }));
    const products = Array.from({ length: 600 }, (_, n) => ({
      id: `p-${n}`,
      name: `Модель ${n}`,
      props: properties.map((prop) => ({ id: prop.id, values: [`v-${prop.id.slice(5)}`] })),
      images: Array.from({ length: 30 }, (_, k) => `import_files/p-${n}-${k}.jpg`),
    }));

    const summary = await load({ properties, products }, 'wide.xml');
    expect(summary.products).toBe(600);
    expect(await count('products')).toBe(600);
    expect(await count('product_properties')).toBe(600 * 40);
    expect(await count('product_images_meta')).toBe(600 * 30);

    const before = await counts();
    await load({ properties, products }, 'wide.xml');
    const after = await counts();
    expect({ ...after, catalog_import_runs: before.catalog_import_runs }).toEqual(before);
  }, 120_000);

  it('обрыв на середине: прогон failure со фактическими счётчиками', async () => {
    const { generateLargeCatalog } = await import('../src/catalog/fixtures.js');
    const xml = buildImportXml(generateLargeCatalog(200, 2));
    const file = path.join(dir, 'cut.xml');
    await writeImportXml(file, xml.slice(0, Math.floor(xml.length * 0.6)));

    await expect(importCatalogFile(repo, file, 'import.xml', { batchSize: 50 })).rejects.toThrow();

    const run = await pool.query<{ status: string; products: number }>(
      'SELECT status, products FROM catalog_import_runs ORDER BY id DESC LIMIT 1',
    );
    expect(run.rows[0]?.status).toBe('failure');
    expect(run.rows[0]?.products).toBeGreaterThan(0);
    expect(await count('products')).toBe(run.rows[0]?.products);
  }, 60_000);

  it('справочник свойств подхватывается из БД для следующих частей выгрузки', async () => {
    await load(
      {
        properties: [
          { id: 'prop-size', name: 'Размер', options: [{ id: 's-44', value: '44' }] },
          { id: 'prop-color', name: 'Цвет', options: [{ id: 'c-red', value: 'Красный' }] },
        ],
        products: [{ id: 'p1', name: 'Платье' }],
      },
      'import.xml',
    );
    await load(
      {
        products: [
          {
            id: 'p1#ch1',
            name: 'Платье 44',
            props: [
              { id: 'prop-size', values: ['s-44'] },
              { id: 'prop-color', values: ['c-red'] },
            ],
          },
        ],
      },
      'import0_1.xml',
    );

    const variant = await pool.query<{ size: string; color: string }>(
      "SELECT size, color FROM product_variants WHERE source_id = 'p1#ch1'",
    );
    expect(variant.rows[0]).toMatchObject({ size: '44', color: 'Красный' });
  });

  it('1500 позиций: загрузка и повторная загрузка без дублей', async () => {
    const { generateLargeCatalog } = await import('../src/catalog/fixtures.js');
    const spec = generateLargeCatalog(300, 4);
    const first = await load(spec, 'big.xml');
    expect(first.durationMs).toBeLessThan(60_000);
    expect(await count('products')).toBe(300);
    expect(await count('product_variants')).toBe(1200);

    const before = await counts();
    await load(spec, 'big.xml');
    const after = await counts();
    expect({ ...after, catalog_import_runs: before.catalog_import_runs }).toEqual(before);
  }, 120_000);
});
