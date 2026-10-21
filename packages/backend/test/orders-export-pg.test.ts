import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import iconv from 'iconv-lite';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { PgCardRepository } from '../src/admin/cards-pg.js';
import { PgSiteBrandRepository } from '../src/admin/pg.js';
import { buildImportXml, writeImportXml, type ImportSpec } from '../src/catalog/fixtures.js';
import { importCatalogFile } from '../src/catalog/import-runner.js';
import { PgCatalogRepository } from '../src/catalog/pg.js';
import type { AppConfig } from '../src/config.js';
import { resetSessions } from '../src/exchange/auth.js';
import { buildOffersXml, writeOffersXml, type OfferSpec } from '../src/offers/fixtures.js';
import { importOffersFile } from '../src/offers/offers-runner.js';
import { PgOffersRepository } from '../src/offers/pg.js';
import { PgOrderRepository } from '../src/orders/pg.js';
import { DEFAULT_ORDERS_CONFIG } from '../src/orders/types.js';

/** Выгрузка заказов в 1С против живого PostgreSQL: TEST_DATABASE_URL=postgresql://… */
const url = process.env.TEST_DATABASE_URL;

const TABLES = [
  'marketing_consents',
  'order_status_history',
  'order_payments',
  'order_items',
  'orders',
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

const CATALOG: ImportSpec = {
  products: [
    {
      id: 'm1#a',
      name: 'Джемпер Diesel красный (46)',
      article: 'D-100',
      chars: [{ name: 'Размер', value: '46' }],
    },
  ],
};

const offer = (id: string, price: number, qty: number): OfferSpec => ({
  id,
  prices: [{ priceTypeId: 'pt-retail', value: price }],
  quantity: qty,
  stocks: [{ warehouseId: 'wh', quantity: qty }],
});

describe.skipIf(!url)('выгрузка заказов в 1С (sale:query/success, PostgreSQL)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let dir: string;
  let cardId: number;
  const basic = 'Basic ' + Buffer.from('x:y').toString('base64');

  const config = (): AppConfig => ({
    port: 0,
    host: '127.0.0.1',
    exchangeLogin: 'x',
    exchangePassword: 'y',
    fileLimit: 1024,
    spoolDir: path.join(dir, 'spool'),
    importWaitMs: 100,
    unpackLimit: 1024,
    databaseUrl: url,
    sitePriceType: 'Розничная',
    siteWarehouse: 'Склад',
    quiet: true,
    admin: {
      login: '',
      password: '',
      uploadsDir: path.join(dir, 'uploads'),
      publicBaseUrl: 'https://api.example.test',
      imagesBaseUrl: '',
    },
    orders: { ...DEFAULT_ORDERS_CONFIG, rateLimit: 1000 },
    // Продавец задан — проверяем, что контрагент-продавец попадает в документ.
    saleExport: {
      schemaVersion: '2.05',
      timeZone: 'Europe/Moscow',
      sellerName: 'ИП Астафьев',
      sellerInn: '550700629713',
      batchLimit: 500,
    },
  });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    for (const R of [
      PgCatalogRepository,
      PgOffersRepository,
      PgSiteBrandRepository,
      PgCardRepository,
      PgOrderRepository,
    ]) {
      const r = new R(url as string);
      await r.ready();
      await r.close();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    resetSessions();
    dir = await mkdtemp(path.join(tmpdir(), 'fa-export-pg-'));
    await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    const catalog = new PgCatalogRepository(url as string);
    const file = path.join(dir, 'import.xml');
    await writeImportXml(file, buildImportXml(CATALOG));
    await importCatalogFile(catalog, file, 'import.xml');
    await catalog.close();
    const offersRepo = new PgOffersRepository(url as string);
    const offersFile = path.join(dir, 'offers.xml');
    await writeOffersXml(
      offersFile,
      buildOffersXml({
        priceTypes: [{ id: 'pt-retail', name: 'Розничная', currency: 'RUB' }],
        warehouses: [{ id: 'wh', name: 'Склад' }],
        offers: [offer('m1#a', 8000, 5)],
      }),
    );
    await importOffersFile(offersRepo, offersFile, 'offers.xml');
    await offersRepo.close();
    const cards = new PgCardRepository(url as string);
    const card = await cards.createCard({
      modelId: 'm1',
      title: 'Джемпер Diesel',
      description: '',
      characteristics: [],
    });
    await cards.addPhoto(card.id, 'aaaaaaaaaaaaaaaa.jpg');
    await cards.updateCard(card.id, { status: 'published' });
    await cards.close();
    cardId = card.id;
    app = await buildApp({ config: config() });
  });

  afterEach(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  let seq = 0;
  const placeOrder = async (over: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `export-key-${++seq}-0123456789abcdef`,
        'user-agent': 'vitest',
      },
      payload: JSON.stringify({
        customer: { name: 'Анна Петрова', phone: '8 (913) 123-45-67', email: 'Anna@Mail.ru' },
        delivery: { method: 'cdek', city: 'Омск', address: 'ул. Ленина, 10' },
        payment: { method: 'on_receipt' },
        items: [{ cardId, variantId: 'm1#a', quantity: 2, price: 8000 }],
        consents: { personalData: true },
        ...over,
      }),
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  const cookie = async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=checkauth',
      headers: { authorization: basic },
    });
    const [, name, value] = res.body.split('\n');
    return `${name}=${value}`;
  };
  const query = async (c: string) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=sale&mode=query',
      headers: { cookie: c },
    });
    return iconv.decode(res.rawPayload, 'win1251');
  };
  const success = async (c: string) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=sale&mode=success',
      headers: { cookie: c },
    });
    return iconv.decode(res.rawPayload, 'win1251');
  };
  const exportedAt = async (number: string) =>
    (await pool.query('SELECT exported_at FROM orders WHERE number = $1', [number])).rows[0]
      ?.exported_at ?? null;

  it('query строит документ из реального заказа; success выставляет exported_at', async () => {
    const o = await placeOrder();
    const c = await cookie();

    const xml = await query(c);
    expect(xml).toContain(`<Ид>${o.number}</Ид>`);
    expect(xml).toContain('<ХозОперация>Заказ товара</ХозОперация>');
    expect(xml).toContain('<Ид>m1#a</Ид>'); // variant_source_id
    expect(xml).toContain('<ЦенаЗаЕдиницу>8000.00</ЦенаЗаЕдиницу>');
    expect(xml).toContain('<Количество>2</Количество>');
    expect(xml).toContain('<Представление>Омск, ул. Ленина, 10</Представление>');
    expect(xml).toContain('<Наименование>ИП Астафьев</Наименование>'); // продавец из конфига
    // токен заказа в выгрузку не попадает
    expect(xml).not.toContain(o.token);

    expect(await exportedAt(o.number)).toBeNull(); // query не мутирует
    expect(await success(c)).toBe('success');
    expect(await exportedAt(o.number)).toBeInstanceOf(Date); // success пометил

    expect(await query(c)).not.toContain('<Документ>'); // повторный query пуст
  });

  it('success идемпотентен: повтор не меняет exported_at', async () => {
    const o = await placeOrder();
    const c = await cookie();
    await query(c);
    await success(c);
    const first = await exportedAt(o.number);
    // Новый round без query: пачка уже помечена и очищена — повтор success ничего не метит.
    await success(c);
    expect(await exportedAt(o.number)).toEqual(first);
  });

  it('гостевой и привязанный к аккаунту заказ выгружаются одинаково', async () => {
    const guest = await placeOrder();
    // Заказ с user_id (F5) вставляем напрямую — аккаунтов ещё нет, но выгрузка не должна их различать.
    await pool.query(
      `INSERT INTO orders (number, public_token, idempotency_key, request_hash, user_id,
         payment_method, customer_name, customer_phone, phone_normalized, customer_email,
         delivery_method, items_total, delivery_cost, bonus_amount, total, pd_consent_at,
         pd_policy_version, offer_version)
       VALUES ('FA-77777777', 'tok-acc-'||repeat('a',35), 'idem-acc', 'h', 42, 'on_receipt',
         'Пётр', '+7', '+79990000000', 'p@b.ru', 'pickup', 1000, 0, 0, 1000, now(), 'v', 'v')`,
    );
    await pool.query(
      `INSERT INTO order_items (order_id, line_no, model_source_id, variant_source_id, title,
         price, quantity, amount)
       VALUES ((SELECT id FROM orders WHERE number='FA-77777777'), 1, 'm2', 'm2#x', 'Товар',
         1000, 1, 1000)`,
    );

    const c = await cookie();
    const xml = await query(c);
    expect(xml).toContain(`<Номер>${guest.number}</Номер>`); // гостевой (user_id NULL)
    expect(xml).toContain('<Номер>FA-77777777</Номер>'); // привязанный к аккаунту
    expect((xml.match(/<Документ>/g) ?? []).length).toBe(2);

    await success(c);
    expect(await exportedAt(guest.number)).toBeInstanceOf(Date);
    expect(await exportedAt('FA-77777777')).toBeInstanceOf(Date);
  });

  it('нет заказов → валидный пустой CommerceML', async () => {
    const c = await cookie();
    const xml = await query(c);
    expect(xml).toContain('<КоммерческаяИнформация');
    expect(xml).not.toContain('<Документ>');
  });

  it('sale:query с неверным auth — failure', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=sale&mode=query',
      headers: { authorization: 'Basic ' + Buffer.from('x:wrong').toString('base64') },
    });
    expect(res.body.startsWith('failure')).toBe(true);
  });
});
