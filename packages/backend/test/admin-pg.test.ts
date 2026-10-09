import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgCatalogReader, PgSiteBrandRepository } from '../src/admin/pg.js';
import { BrandService } from '../src/admin/service.js';
import { buildImportXml, writeImportXml, type ImportSpec } from '../src/catalog/fixtures.js';
import { importCatalogFile } from '../src/catalog/import-runner.js';
import { PgCatalogRepository } from '../src/catalog/pg.js';

/**
 * Витринный слой брендов против живого PostgreSQL (как catalog-pg.test.ts):
 *   TEST_DATABASE_URL=postgresql://fa@127.0.0.1:5432/fa_test npm test -w @fa/backend
 */
const url = process.env.TEST_DATABASE_URL;

const SITE_TABLES = [
  'site_model_brand',
  'site_brand_placements',
  'site_brand_aliases',
  'site_brands',
];
const STAGING_TABLES = [
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

// Как в реальной выгрузке 1С: только SKU («Ид#Характеристика»), товаров-родителей и брендов нет.
const SPEC: ImportSpec = {
  products: [
    { id: 'm1#a', name: 'Джемпер Diesel красный, 46', images: ['import_files/aa/m1a.jpg'] },
    { id: 'm1#b', name: 'Джемпер Diesel красный, 48', images: ['import_files/aa/m1b.jpg'] },
    { id: 'm2#a', name: 'Платье Dorothee Shumacher, 42' },
    { id: 'm3#a', name: 'Куртка без бренда, 50', images: ['import_files/cc/m3a.jpg'] },
  ],
};

describe.skipIf(!url)('витринные бренды в PostgreSQL', () => {
  let pool: pg.Pool;
  let repo: PgSiteBrandRepository;
  let reader: PgCatalogReader;
  let service: BrandService;
  let dir: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    repo = new PgSiteBrandRepository(url as string);
    reader = new PgCatalogReader(url as string);
    service = new BrandService(repo, reader);
    await repo.ready();
    const catalog = new PgCatalogRepository(url as string);
    await catalog.ready();
    await catalog.close();
  });

  afterAll(async () => {
    await repo.close();
    await reader.close();
    await pool.end();
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fa-admin-pg-'));
    await pool.query(`TRUNCATE ${[...SITE_TABLES, ...STAGING_TABLES].join(', ')} RESTART IDENTITY`);
    const catalog = new PgCatalogRepository(url as string);
    const file = path.join(dir, 'import.xml');
    await writeImportXml(file, buildImportXml(SPEC));
    await importCatalogFile(catalog, file, 'import.xml');
    await catalog.close();
    return async () => {
      await rm(dir, { recursive: true, force: true });
    };
  });

  it('миграция 004 применяется идемпотентно', async () => {
    await repo.ready();
    const res = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`,
    );
    const present = res.rows.map((r) => r.table_name);
    for (const t of SITE_TABLES) expect(present).toContain(t);
  });

  it('модели берутся из SKU без родительских товаров, с названием и первым фото', async () => {
    const models = await reader.listModels();
    expect(models.map((m) => [m.id, m.skus, m.photo])).toEqual([
      ['m1', 2, 'import_files/aa/m1a.jpg'],
      ['m3', 1, 'import_files/cc/m3a.jpg'],
      ['m2', 1, null],
    ]); // порядок — по названию
  });

  it('бренды и привязки: создание, алиасы, пересчёт, ручная привязка', async () => {
    const diesel = await service.createBrand({
      name: 'Diesel',
      placements: { men: { top: true } },
    });
    const dorothee = await service.createBrand({
      name: 'Dorothee Schumacher',
      aliases: ['Shumacher'],
      placements: { women: { in: true } },
    });
    expect(diesel).toMatchObject({ slug: 'diesel', models: 1 });
    expect(dorothee).toMatchObject({
      slug: 'dorothee-schumacher',
      models: 1,
      aliases: ['shumacher'],
    });

    const un = await service.unmatched('', 50, 0);
    expect(un.items.map((m) => m.id)).toEqual(['m3']);

    await service.assignModel('m3', diesel.id);
    await service.recompute(); // manual переживает пересчёт
    const after = await service.listBrands();
    expect(after.find((b) => b.id === diesel.id)?.models).toBe(2);

    // повторный пересчёт не плодит строк
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM site_model_brand',
    );
    expect(rows[0]?.n).toBe('3');

    // обмен перезаписал каталог — привязки по Ид моделей остались
    const catalog = new PgCatalogRepository(url as string);
    const file = path.join(dir, 'import2.xml');
    await writeImportXml(file, buildImportXml(SPEC));
    await importCatalogFile(catalog, file, 'import.xml');
    await catalog.close();
    expect((await service.brandBySlug('diesel'))?.slug).toBe('diesel');
  });

  it('уникальность адреса и написаний → 409; бренд удаляется каскадом', async () => {
    const a = await service.createBrand({ name: 'Alpha', aliases: ['al'] });
    await expect(service.createBrand({ name: 'Alpha' })).rejects.toMatchObject({ status: 409 });
    await expect(
      repo.createBrand({ name: 'B', slug: 'b', aliases: ['al'], placements: a.placements }),
    ).rejects.toMatchObject({
      status: 409,
    });
    // неудавшееся создание не оставило бренд «b»
    expect((await repo.listBrands()).map((b) => b.slug)).toEqual(['alpha']);
    await repo.deleteBrand(a.id);
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM site_brand_aliases',
    );
    expect(rows[0]?.n).toBe('0');
    await expect(repo.deleteBrand(a.id)).rejects.toMatchObject({ status: 404 });
  });

  it('топ: порядок, замена, неизвестный бренд откатывает всё', async () => {
    const a = await service.createBrand({ name: 'Aaa', placements: { men: { in: true } } });
    const b = await service.createBrand({ name: 'Bbb', placements: { men: { in: true } } });
    const c = await service.createBrand({ name: 'Ccc' });
    await repo.setTop('men', [c.id, a.id]);
    expect((await service.publicBrands('men')).top.map((t) => t.slug)).toEqual(['ccc', 'aaa']);
    await expect(repo.setTop('men', [b.id, 9999])).rejects.toMatchObject({ status: 404 });
    expect((await service.publicBrands('men')).top.map((t) => t.slug)).toEqual(['ccc', 'aaa']);
    await repo.setTop('men', []);
    expect((await service.publicBrands('men')).top).toEqual([]);
    expect((await service.publicBrands('men')).all).toHaveLength(3);
  });

  it('файлы: setImage возвращает прежнее имя', async () => {
    const a = await service.createBrand({ name: 'Aaa' });
    expect(await repo.setImage(a.id, 'photo', '0123456789abcdef.png')).toBeNull();
    expect(await repo.setImage(a.id, 'photo', 'fedcba9876543210.png')).toBe('0123456789abcdef.png');
    expect(await repo.setImage(a.id, 'photo', null)).toBe('fedcba9876543210.png');
    await expect(repo.setImage(9999, 'logo', null)).rejects.toMatchObject({ status: 404 });
  });

  it('статус обмена читается', async () => {
    const st = await reader.exchangeStatus();
    expect(st.catalogRuns).toHaveLength(1);
    expect(Array.isArray(st.offersRuns)).toBe(true); // offers_* может быть и без строк
  });

  it('до первого обмена staging-таблиц нет — админка отвечает пустыми списками', async () => {
    await pool.query('CREATE SCHEMA IF NOT EXISTS admin_empty');
    const empty = new URL(url as string);
    empty.searchParams.set('options', '-c search_path=admin_empty');
    const fresh = new PgCatalogReader(empty.toString());
    try {
      expect(await fresh.listModels()).toEqual([]);
      expect(await fresh.exchangeStatus()).toEqual({ log: [], catalogRuns: [], offersRuns: [] });
    } finally {
      await fresh.close();
      await pool.query('DROP SCHEMA admin_empty CASCADE');
    }
  });
});
