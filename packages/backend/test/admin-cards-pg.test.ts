import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgCardRepository } from '../src/admin/cards-pg.js';
import { CardService } from '../src/admin/cards.js';
import { PgCatalogReader, PgSiteBrandRepository } from '../src/admin/pg.js';
import { BrandService } from '../src/admin/service.js';
import { buildImportXml, writeImportXml, type ImportSpec } from '../src/catalog/fixtures.js';
import { importCatalogFile } from '../src/catalog/import-runner.js';
import { PgCatalogRepository } from '../src/catalog/pg.js';
import { buildOffersXml, writeOffersXml } from '../src/offers/fixtures.js';
import { importOffersFile } from '../src/offers/offers-runner.js';
import { PgOffersRepository } from '../src/offers/pg.js';

/** Карточки против живого PostgreSQL: TEST_DATABASE_URL=postgresql://… npm test -w @fa/backend */
const url = process.env.TEST_DATABASE_URL;

const TABLES = [
  'site_card_photos',
  'site_cards',
  'site_model_brand',
  'site_brand_placements',
  'site_brand_aliases',
  'site_brands',
  'offers_import_runs',
  'offer_stocks',
  'offer_prices',
  'offers',
  'warehouses',
  'price_types',
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
  products: [
    { id: 'm1#a', name: 'Джемпер Diesel красный, 46' },
    { id: 'm1#b', name: 'Джемпер Diesel красный, 48' },
    { id: 'm2#a', name: 'Платье без бренда, 42' },
  ],
};

describe.skipIf(!url)('карточки в PostgreSQL', () => {
  let pool: pg.Pool;
  let repo: PgCardRepository;
  let reader: PgCatalogReader;
  let brands: PgSiteBrandRepository;
  let cards: CardService;
  let dir: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    repo = new PgCardRepository(url as string);
    reader = new PgCatalogReader(url as string);
    brands = new PgSiteBrandRepository(url as string);
    cards = new CardService(repo, reader, new BrandService(brands, reader));
    await Promise.all([repo.ready(), brands.ready()]);
    const catalog = new PgCatalogRepository(url as string);
    await catalog.ready();
    await catalog.close();
    const offers = new PgOffersRepository(url as string);
    await offers.ready();
    await offers.close();
  });

  afterAll(async () => {
    await repo.close();
    await reader.close();
    await brands.close();
    await pool.end();
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fa-cards-pg-'));
    await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY`);
    const catalog = new PgCatalogRepository(url as string);
    const file = path.join(dir, 'import.xml');
    await writeImportXml(file, buildImportXml(SPEC));
    await importCatalogFile(catalog, file, 'import.xml');
    await catalog.close();
    return async () => {
      await rm(dir, { recursive: true, force: true });
    };
  });

  const loadOffers = async (quantityA: number, quantityB: number) => {
    const offers = new PgOffersRepository(url as string);
    const file = path.join(dir, 'offers.xml');
    await writeOffersXml(
      file,
      buildOffersXml({
        priceTypes: [
          { id: 'pt-retail', name: 'Розничная', currency: 'RUB' },
          { id: 'pt-sale', name: 'Распродажа', currency: 'RUB' },
        ],
        warehouses: [{ id: 'wh', name: 'Склад' }],
        offers: [
          {
            id: 'm1#a',
            prices: [
              { priceTypeId: 'pt-retail', value: 8000 },
              { priceTypeId: 'pt-sale', value: 6500 },
            ],
            stocks: [{ warehouseId: 'wh', quantity: quantityA }],
          },
          {
            id: 'm1#b',
            prices: [{ priceTypeId: 'pt-retail', value: 8000 }],
            stocks: [{ warehouseId: 'wh', quantity: quantityB }],
          },
        ],
      }),
    );
    await importOffersFile(offers, file, 'offers.xml');
    await offers.close();
  };

  it('миграция 005 идемпотентна; без offers.xml цен и остатков нет', async () => {
    await repo.ready();
    const live = await reader.liveData();
    expect(live.get('m1')).toMatchObject({ price: null, stock: null });
    expect(live.get('m1')!.variants).toHaveLength(2);
  });

  it('цена и остаток подклеиваются из предложений', async () => {
    await loadOffers(2, 1);
    const live = await reader.liveData();
    expect(live.get('m1')).toMatchObject({ price: 6500, stock: 3 });
    expect(live.get('m1')!.variants.map((v) => v.quantity)).toEqual([2, 1]);
    expect(live.get('m2')?.stock).toBeNull(); // предложения нет — остаток неизвестен
  });

  it('жизненный цикл: создать → фото → опубликовать → скрытие по остатку', async () => {
    const card = await cards.create({ modelId: 'm1' });
    await expect(cards.create({ modelId: 'm1' })).rejects.toMatchObject({ status: 409 });
    await expect(cards.update(card.id, { status: 'published' })).rejects.toMatchObject({
      status: 409,
    });

    const p1 = await repo.addPhoto(card.id, 'aaaaaaaaaaaaaaaa.jpg');
    const p2 = await repo.addPhoto(card.id, 'bbbbbbbbbbbbbbbb.jpg');
    expect(p2.sort).toBeGreaterThan(p1.sort);
    await repo.reorderPhotos(card.id, [p2.id, p1.id]);
    await expect(repo.reorderPhotos(card.id, [p2.id])).rejects.toThrow();
    expect((await cards.get(card.id)).photos.map((p) => p.file)).toEqual([
      'bbbbbbbbbbbbbbbb.jpg',
      'aaaaaaaaaaaaaaaa.jpg',
    ]);

    const pub = await cards.update(card.id, {
      title: 'Джемпер',
      characteristics: [{ name: 'Состав', value: 'шерсть' }],
      status: 'published',
    });
    expect(pub).toMatchObject({ status: 'published', visible: true });
    expect(pub.publishedAt).not.toBeNull();
    expect((await cards.publicList({ limit: 10, offset: 0 })).total).toBe(1);

    await loadOffers(0, 0);
    expect((await cards.get(card.id)).hiddenReason).toBe('no-stock');
    expect((await cards.publicList({ limit: 10, offset: 0 })).total).toBe(0);
    await loadOffers(0, 4);
    expect((await cards.publicCard(card.id))?.price).toBe(6500);

    expect(await repo.removePhoto(card.id, p1.id)).toBe('aaaaaaaaaaaaaaaa.jpg');
    expect(await repo.deleteCard(card.id)).toEqual(['bbbbbbbbbbbbbbbb.jpg']);
    const left = await pool.query('SELECT 1 FROM site_card_photos');
    expect(left.rowCount).toBe(0); // фото удалены каскадом
  });

  it('автокомплит ищет по названию staging', async () => {
    const hits = await cards.search('платье');
    expect(hits.map((h) => h.id)).toEqual(['m2']);
  });
});
