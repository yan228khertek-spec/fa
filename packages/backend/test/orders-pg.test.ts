import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { PgCardRepository } from '../src/admin/cards-pg.js';
import { buildImportXml, writeImportXml, type ImportSpec } from '../src/catalog/fixtures.js';
import { importCatalogFile } from '../src/catalog/import-runner.js';
import { PgCatalogRepository } from '../src/catalog/pg.js';
import type { AppConfig } from '../src/config.js';
import { buildOffersXml, writeOffersXml, type OfferSpec } from '../src/offers/fixtures.js';
import { importOffersFile } from '../src/offers/offers-runner.js';
import { PgOffersRepository } from '../src/offers/pg.js';
import { PgOrderRepository } from '../src/orders/pg.js';
import { DEFAULT_ORDERS_CONFIG } from '../src/orders/types.js';

/** Заказы против живого PostgreSQL: TEST_DATABASE_URL=postgresql://… npm test -w @fa/backend */
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
    {
      id: 'm1#b',
      name: 'Джемпер Diesel красный (48)',
      article: 'D-100',
      chars: [{ name: 'Размер', value: '48' }],
    },
    // Как в реальной выгрузке: у SKU каталога нет предложения в offers → цены нет.
    {
      id: 'm1#c',
      name: 'Джемпер Diesel красный (50)',
      article: 'D-100',
      chars: [{ name: 'Размер', value: '50' }],
    },
  ],
};

const offer = (id: string, price: number, qty: number, otherWh = 0): OfferSpec => ({
  id,
  prices: [
    { priceTypeId: 'pt-retail', value: price },
    { priceTypeId: 'pt-sale', value: Math.round(price / 2) },
  ],
  quantity: qty + otherWh, // общий остаток — витрина его не считает
  stocks: [
    { warehouseId: 'wh', quantity: qty },
    { warehouseId: 'wh-junk', quantity: otherWh },
  ],
});

describe.skipIf(!url)('заказы в PostgreSQL (HTTP end-to-end)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let dir: string;
  let cardId: number;

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
    // Как в проде: цена — тип «Розничная», остаток — один склад (фикстурные имена).
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
  });

  const loadOffers = async (offers: OfferSpec[], name = 'offers.xml') => {
    const repo = new PgOffersRepository(url as string);
    const file = path.join(dir, name);
    await writeOffersXml(
      file,
      buildOffersXml({
        priceTypes: [
          { id: 'pt-retail', name: 'Розничная', currency: 'RUB' },
          { id: 'pt-sale', name: 'Распродажа', currency: 'RUB' },
        ],
        warehouses: [
          { id: 'wh', name: 'Склад' },
          { id: 'wh-junk', name: 'Брак' },
        ],
        offers,
      }),
    );
    await importOffersFile(repo, file, 'offers.xml');
    await repo.close();
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    for (const R of [
      PgCatalogRepository,
      PgOffersRepository,
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
    dir = await mkdtemp(path.join(tmpdir(), 'fa-orders-pg-'));
    await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    const catalog = new PgCatalogRepository(url as string);
    const file = path.join(dir, 'import.xml');
    await writeImportXml(file, buildImportXml(CATALOG));
    await importCatalogFile(catalog, file, 'import.xml');
    await catalog.close();
    await loadOffers([offer('m1#a', 8000, 2, 50), offer('m1#b', 8500, 1)]);
    // Опубликованная карточка с фото — как её делает конструктор.
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
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const body = (over: Record<string, unknown> = {}) => ({
    customer: { name: 'Анна Петрова', phone: '8 (913) 123-45-67', email: 'Anna@Mail.ru' },
    delivery: { method: 'cdek', city: 'Омск', address: 'ул. Ленина, 10, кв. 5' },
    payment: { method: 'on_receipt' },
    items: [{ cardId, variantId: 'm1#a', quantity: 2, price: 8000 }],
    consents: { personalData: true },
    ...over,
  });
  let seq = 0;
  const post = (payload: unknown, key = `key-${++seq}-0123456789abcdef`) =>
    app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        'user-agent': 'vitest',
      },
      payload: JSON.stringify(payload),
    });
  const count = async (table: string) =>
    Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

  it('карточка витрины отдаёт sizes[].id и цену размера (контракт v1.1)', async () => {
    const res = await app.inject({ url: `/api/cards/${cardId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().sizes).toEqual([
      { id: 'm1#a', size: '46', color: null, inStock: true, price: 8000 },
      { id: 'm1#b', size: '48', color: null, inStock: true, price: 8500 },
      { id: 'm1#c', size: '50', color: null, inStock: null, price: null },
    ]);
  });

  it('успешный заказ СДЭК: строки в БД, снимок позиции, история, без рассылки', async () => {
    const res = await post(body());
    expect(res.statusCode).toBe(201);
    const o = res.json();
    expect(o).toMatchObject({ itemsTotal: 16000, deliveryCost: 500, bonusAmount: 0, total: 16500 });

    const { rows } = await pool.query('SELECT * FROM orders');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      number: o.number,
      public_token: o.token,
      status: 'new',
      payment_status: 'unpaid',
      payment_method: 'on_receipt',
      customer_name: 'Анна Петрова',
      customer_phone: '8 (913) 123-45-67',
      phone_normalized: '+79131234567',
      customer_email: 'anna@mail.ru',
      delivery_method: 'cdek',
      delivery_city: 'Омск',
      delivery_address: 'ул. Ленина, 10, кв. 5',
      currency: 'RUB',
      vat_mode: 'none',
      items_total: '16000.00',
      delivery_cost: '500.00',
      bonus_amount: '0.00',
      total: '16500.00',
      user_id: null,
      loyalty_account_ref: null,
      pd_policy_version: 'draft-2026-10',
      offer_version: 'draft-2026-10',
      user_agent: 'vitest',
      exported_at: null,
      onec_id: null,
      status_1c: null,
    });
    expect(rows[0].pd_consent_at).toBeInstanceOf(Date);
    expect(rows[0].client_ip).toBe('127.0.0.1');

    const items = await pool.query('SELECT * FROM order_items');
    expect(items.rows).toEqual([
      expect.objectContaining({
        line_no: 1,
        card_id: String(cardId),
        model_source_id: 'm1',
        variant_source_id: 'm1#a',
        article: 'D-100',
        title: 'Джемпер Diesel',
        name_1c: 'Джемпер Diesel красный (46)',
        size: '46',
        price: '8000.00',
        quantity: 2,
        amount: '16000.00',
      }),
    ]);
    const hist = await pool.query(
      'SELECT field, old_value, new_value, source FROM order_status_history',
    );
    expect(hist.rows).toEqual([
      { field: 'status', old_value: null, new_value: 'new', source: 'site' },
    ]);
    expect(await count('marketing_consents')).toBe(0);
    expect(await count('order_payments')).toBe(0);
  });

  it('согласие на рассылку — отдельная запись с версией текста, IP и временем', async () => {
    const res = await post(body({ consents: { personalData: true, marketing: true } }));
    expect(res.statusCode).toBe(201);
    const { rows } = await pool.query('SELECT * FROM marketing_consents');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: 'anna@mail.ru',
      phone_normalized: '+79131234567',
      user_id: null,
      source: 'checkout',
      consent_text_version: 'draft-2026-10',
      ip: '127.0.0.1',
      user_agent: 'vitest',
      revoked_at: null,
      revoke_method: null,
    });
    expect(rows[0].granted_at).toBeInstanceOf(Date);
    expect(rows[0].order_id).not.toBeNull();
  });

  it('идемпотентность: повтор и гонка с одним ключом дают один заказ', async () => {
    const key = 'checkout-0f2b8a8e-5c1d-4a55-9d3e-7a0c2e1b9f10';
    const first = await post(body(), key);
    const again = await post(body(), key);
    expect(again.statusCode).toBe(200);
    expect(again.json().number).toBe(first.json().number);

    const race = 'checkout-race-0123456789abcdef';
    const all = await Promise.all(Array.from({ length: 6 }, () => post(body(), race)));
    const numbers = new Set(all.map((r) => r.json().number));
    expect(numbers.size).toBe(1);
    expect(all.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(all.every((r) => r.statusCode === 201 || r.statusCode === 200)).toBe(true);
    expect(await count('orders')).toBe(2);
    expect(await count('order_status_history')).toBe(2);

    const reused = await post(body({ comment: 'другой заказ' }), key);
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('повтор отвечает тем же заказом, даже когда товар уже закончился', async () => {
    const key = 'checkout-sold-out-0123456789';
    const first = await post(body(), key);
    await loadOffers([offer('m1#a', 8000, 0), offer('m1#b', 8500, 1)], 'offers2.xml');
    const again = await post(body(), key);
    expect(again.statusCode).toBe(200);
    expect(again.json().number).toBe(first.json().number);
  });

  it('нет цены (SKU без предложения — частый случай на реальных данных) — NO_PRICE, заказа нет', async () => {
    const res = await post(
      body({ items: [{ cardId, variantId: 'm1#c', quantity: 1, price: 8000 }] }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().items).toEqual([{ index: 0, cardId, variantId: 'm1#c', code: 'NO_PRICE' }]);
    expect(await count('orders')).toBe(0);
    expect(await count('order_items')).toBe(0);
  });

  it('нет остатка на складе витрины — OUT_OF_STOCK; меньше, чем просили — INSUFFICIENT_STOCK', async () => {
    // На «Складе» 0, на «Браке» 50, общий остаток 50 — продавать нельзя.
    await loadOffers([offer('m1#a', 8000, 0, 50), offer('m1#b', 8500, 1)], 'offers3.xml');
    const res = await post(
      body({
        items: [
          { cardId, variantId: 'm1#a', quantity: 1, price: 8000 },
          { cardId, variantId: 'm1#b', quantity: 3, price: 8500 },
        ],
      }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().items).toEqual([
      { index: 0, cardId, variantId: 'm1#a', code: 'OUT_OF_STOCK' },
      { index: 1, cardId, variantId: 'm1#b', code: 'INSUFFICIENT_STOCK', available: 1 },
    ]);
    expect(await count('orders')).toBe(0);
  });

  it('модель исчезла с витрины целиком (нет остатка ни в одном размере) — CARD_NOT_AVAILABLE', async () => {
    await loadOffers([offer('m1#a', 8000, 0), offer('m1#b', 8500, 0)], 'offers4.xml');
    const res = await post(body());
    expect(res.json().items).toEqual([
      { index: 0, cardId, variantId: 'm1#a', code: 'CARD_NOT_AVAILABLE' },
    ]);
  });

  it('самовывоз vs СДЭК: стоимость доставки и адрес', async () => {
    const pickup = await post(
      body({ delivery: { method: 'pickup', city: 'Омск', address: 'не нужен' } }),
    );
    expect(pickup.json()).toMatchObject({
      deliveryCost: 0,
      total: 16000,
      delivery: { method: 'pickup' },
    });
    const free = await post(
      body({
        items: [
          { cardId, variantId: 'm1#a', quantity: 2, price: 8000 },
          { cardId, variantId: 'm1#b', quantity: 1, price: 8500 },
        ],
      }),
    );
    expect(free.json()).toMatchObject({ itemsTotal: 24500, deliveryCost: 0, total: 24500 });
    const { rows } = await pool.query(
      'SELECT delivery_method, delivery_city, delivery_address, delivery_cost::text FROM orders ORDER BY id',
    );
    expect(rows).toEqual([
      {
        delivery_method: 'pickup',
        delivery_city: null,
        delivery_address: null,
        delivery_cost: '0.00',
      },
      {
        delivery_method: 'cdek',
        delivery_city: 'Омск',
        delivery_address: 'ул. Ленина, 10, кв. 5',
        delivery_cost: '0.00',
      },
    ]);
  });

  it('снимок цены не меняется после обмена; новый заказ по старой цене — PRICE_CHANGED', async () => {
    const o = (await post(body())).json();
    await loadOffers([offer('m1#a', 9900, 5), offer('m1#b', 8500, 1)], 'offers5.xml');
    const item = await pool.query('SELECT price::text, amount::text FROM order_items');
    expect(item.rows).toEqual([{ price: '8000.00', amount: '16000.00' }]);
    const view = await app.inject({ url: `/api/orders/${o.token}` });
    expect(view.json()).toMatchObject({ itemsTotal: 16000, items: [{ price: 8000 }] });

    const stale = await post(body());
    expect(stale.statusCode).toBe(409);
    expect(stale.json().items).toEqual([
      { index: 0, cardId, variantId: 'm1#a', code: 'PRICE_CHANGED', price: 9900 },
    ]);
  });

  it('инвариант суммы держит сама БД: total = items_total + delivery_cost − bonus_amount', async () => {
    const insert = (total: string, bonus: string) =>
      pool.query(
        `INSERT INTO orders (number, public_token, idempotency_key, request_hash, payment_method,
           customer_name, customer_phone, phone_normalized, customer_email, delivery_method,
           items_total, delivery_cost, bonus_amount, total, pd_consent_at, pd_policy_version,
           offer_version)
         VALUES ('FA-1000000' || $3, 'tok' || $3, 'key' || $3, 'h', 'on_receipt', 'Анна', '+7',
           '+79131234567', 'a@b.ru', 'pickup', 1000, 500, $2::numeric, $1::numeric, now(), 'v', 'v')`,
        [total, bonus, String(++seq % 10)],
      );
    await expect(insert('1500', '0')).resolves.toBeDefined();
    await expect(insert('1300', '200')).resolves.toBeDefined(); // бонусы списаны
    await expect(insert('1500', '200')).rejects.toThrow(/orders_total_sum_check/);
    await expect(insert('1600', '0')).rejects.toThrow(/orders_total_sum_check/);
  });
});
