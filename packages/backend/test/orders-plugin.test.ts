import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryCardRepository } from '../src/admin/cards-memory.js';
import { MemoryCatalogReader } from '../src/admin/memory.js';
import type { LiveModel } from '../src/admin/types.js';
import type { AppConfig } from '../src/config.js';
import { loadOrdersConfig } from '../src/config.js';
import { MemoryOrderRepository } from '../src/orders/memory.js';
import { DEFAULT_ORDERS_CONFIG, type OrdersConfig } from '../src/orders/types.js';

const KEY = '7f9c2ba4-e88f-4c6f-9f2a-000000000001';

describe('API заказов (HTTP, хранилища в памяти)', () => {
  let app: FastifyInstance;
  let dir: string;
  let orders: MemoryOrderRepository;
  let cardId: number;

  const live = (): Map<string, LiveModel> =>
    new Map([
      [
        'm1',
        {
          price: 8000,
          stock: 3,
          variants: [
            {
              id: 'm1#a',
              size: '46',
              color: 'красный',
              quantity: 2,
              price: 8000,
              name: 'Джемпер 46',
            },
            {
              id: 'm1#b',
              size: '48',
              color: 'красный',
              quantity: 1,
              price: 8500,
              name: 'Джемпер 48',
            },
            { id: 'm1#c', size: '50', color: 'красный', quantity: null, price: null, name: null },
          ],
        },
      ],
    ]);

  const start = async (over: Partial<OrdersConfig> = {}, published = true) => {
    dir = await mkdtemp(path.join(tmpdir(), 'fa-orders-'));
    const config: AppConfig = {
      port: 0,
      host: '127.0.0.1',
      exchangeLogin: 'x',
      exchangePassword: 'y',
      fileLimit: 1024,
      spoolDir: path.join(dir, 'spool'),
      importWaitMs: 100,
      unpackLimit: 1024,
      databaseUrl: undefined,
      sitePriceType: '',
      siteWarehouse: '',
      quiet: true,
      admin: {
        login: '',
        password: '',
        uploadsDir: path.join(dir, 'uploads'),
        publicBaseUrl: 'https://api.example.test',
        imagesBaseUrl: '',
      },
      orders: { ...DEFAULT_ORDERS_CONFIG, ...over },
    };
    const cardRepo = new MemoryCardRepository();
    const card = await cardRepo.createCard({
      modelId: 'm1',
      title: 'Джемпер Diesel',
      description: '',
      characteristics: [],
    });
    await cardRepo.addPhoto(card.id, 'aaaaaaaaaaaaaaaa.jpg');
    if (published) await cardRepo.updateCard(card.id, { status: 'published' });
    cardId = card.id;
    orders = new MemoryOrderRepository();
    app = await buildApp({
      config,
      cardRepo,
      orderRepo: orders,
      catalogReader: new MemoryCatalogReader(
        [{ id: 'm1', name: 'Джемпер Diesel красный', article: 'D-100', skus: 3, photo: null }],
        live(),
      ),
    });
  };

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const body = (over: Record<string, unknown> = {}) => ({
    customer: { name: 'Анна Петрова', phone: '+7 913 123-45-67', email: 'anna@mail.ru' },
    delivery: { method: 'pickup' },
    payment: { method: 'on_receipt' },
    items: [{ cardId, variantId: 'm1#a', quantity: 1, price: 8000 }],
    consents: { personalData: true },
    ...over,
  });
  const post = (payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { 'content-type': 'application/json', 'idempotency-key': KEY, ...headers },
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });

  describe('штатно', () => {
    beforeEach(() => start());

    it('GET /api/checkout/config: тарифы и версии из конфига, CORS', async () => {
      const res = await app.inject({ url: '/api/checkout/config' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.json()).toMatchObject({
        ordersEnabled: true,
        currency: 'RUB',
        delivery: {
          methods: [
            { id: 'pickup', cost: 0, address: null },
            { id: 'cdek', cost: 500, freeFrom: 20000 },
          ],
        },
        payment: {
          methods: [
            { id: 'on_receipt', available: true },
            { id: 'online', available: false },
          ],
        },
        documents: { marketingConsentVersion: 'draft-2026-10' },
        limits: { maxItems: 30, maxQuantity: 10 },
      });
    });

    it('OPTIONS /api/orders — предзапрос браузера', async () => {
      const res = await app.inject({ method: 'OPTIONS', url: '/api/orders' });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(String(res.headers['access-control-allow-headers'])).toContain('idempotency-key');
    });

    it('201: заказ без ПД в ответе; GET по токену; повтор = тот же заказ', async () => {
      const res = await post(body());
      expect(res.statusCode).toBe(201);
      const o = res.json();
      expect(o).toMatchObject({
        status: 'new',
        paymentStatus: 'unpaid',
        paymentMethod: 'on_receipt',
        delivery: { method: 'pickup' },
        itemsTotal: 8000,
        deliveryCost: 0,
        bonusAmount: 0,
        total: 8000,
        items: [
          { cardId, title: 'Джемпер Diesel', size: '46', price: 8000, quantity: 1, amount: 8000 },
        ],
      });
      expect(o.number).toMatch(/^FA-\d{8}$/);
      expect(o.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.body).not.toMatch(/Анна|9131234567|anna@/);
      expect(res.headers['access-control-allow-origin']).toBe('*');

      const again = await post(body());
      expect(again.statusCode).toBe(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.json()).toEqual(o);
      expect(orders.orders).toHaveLength(1);

      const view = await app.inject({ url: `/api/orders/${o.token}` });
      expect(view.statusCode).toBe(200);
      expect(view.headers['cache-control']).toBe('no-store');
      expect(view.json()).toEqual(
        Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'token')),
      );
      expect((await app.inject({ url: '/api/orders/nope' })).statusCode).toBe(404);
      expect((await app.inject({ url: `/api/orders/${'x'.repeat(43)}` })).json()).toMatchObject({
        error: 'ORDER_NOT_FOUND',
      });
    });

    it('тот же ключ с другим телом — 409 IDEMPOTENCY_KEY_REUSED', async () => {
      expect((await post(body())).statusCode).toBe(201);
      const res = await post(body({ comment: 'другое' }));
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('сохраняет нормализованный телефон, email и согласие на рассылку только по галочке', async () => {
      await post(body({ consents: { personalData: true, marketing: true } }));
      const saved = orders.orders[0]!;
      expect(saved.input.customer).toMatchObject({
        phoneNormalized: '+79131234567',
        email: 'anna@mail.ru',
      });
      expect(saved.input.consents.marketing).toBe(true);
      expect(saved.marketingConsentVersion).toBe('draft-2026-10');
      expect(saved.pdPolicyVersion).toBe('draft-2026-10');
    });

    it('СДЭК: фикс-тариф, бесплатно от порога', async () => {
      const cdek = { method: 'cdek', city: 'Омск', address: 'ул. Ленина, 10' };
      const r1 = await post(body({ delivery: cdek }));
      expect(r1.json()).toMatchObject({ itemsTotal: 8000, deliveryCost: 500, total: 8500 });
      const r2 = await post(
        body({
          delivery: cdek,
          items: [
            { cardId, variantId: 'm1#a', quantity: 2, price: 8000 },
            { cardId, variantId: 'm1#b', quantity: 1, price: 8500 },
          ],
        }),
        { 'idempotency-key': `${KEY}-2` },
      );
      expect(r2.json()).toMatchObject({ itemsTotal: 24500, deliveryCost: 0, total: 24500 });
    });

    it('краевые состояния позиций — все проблемы разом, заказ не создан', async () => {
      const res = await post(
        body({
          items: [
            { cardId, variantId: 'm1#c', quantity: 1, price: 1 },
            { cardId, variantId: 'm1#b', quantity: 2, price: 8500 },
            { cardId, variantId: 'm1#a', quantity: 1, price: 7000 },
            { cardId, variantId: 'm2#x', quantity: 1, price: 100 },
            { cardId: 999, variantId: 'm9#a', quantity: 1, price: 100 },
          ],
        }),
      );
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'ITEMS_UNAVAILABLE',
        message: 'Некоторые товары нельзя заказать',
        items: [
          { index: 0, cardId, variantId: 'm1#c', code: 'NO_PRICE' },
          { index: 1, cardId, variantId: 'm1#b', code: 'INSUFFICIENT_STOCK', available: 1 },
          { index: 2, cardId, variantId: 'm1#a', code: 'PRICE_CHANGED', price: 8000 },
          { index: 3, cardId, variantId: 'm2#x', code: 'VARIANT_NOT_FOUND' },
          { index: 4, cardId: 999, variantId: 'm9#a', code: 'CARD_NOT_AVAILABLE' },
        ],
      });
      expect(orders.orders).toHaveLength(0);
    });

    it('expectedTotal не совпал — 409 TOTAL_CHANGED с актуальными суммами', async () => {
      const res = await post(
        body({
          delivery: { method: 'cdek', city: 'Омск', address: 'ул. Ленина, 10' },
          expectedTotal: 8000,
        }),
      );
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: 'TOTAL_CHANGED',
        itemsTotal: 8000,
        deliveryCost: 500,
        bonusAmount: 0,
        total: 8500,
      });
      expect(
        (await post(body({ expectedTotal: 8000 }), { 'idempotency-key': `${KEY}-3` })).statusCode,
      ).toBe(201);
    });

    it('ошибки транспорта: ключ, тип, JSON, размер, валидация', async () => {
      const noKey = await app.inject({
        method: 'POST',
        url: '/api/orders',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(body()),
      });
      expect(noKey.statusCode).toBe(400);
      expect(noKey.json().error).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await post(body(), { 'idempotency-key': 'short' })).json().error).toBe(
        'IDEMPOTENCY_KEY_REQUIRED',
      );

      const bad = await post('{"customer":', {});
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe('INVALID_JSON');
      expect(bad.headers['access-control-allow-origin']).toBe('*');

      const text = await post(JSON.stringify(body()), { 'content-type': 'text/plain' });
      expect(text.statusCode).toBe(415);
      expect(text.json().error).toBe('UNSUPPORTED_MEDIA_TYPE');

      const big = await post(body({ comment: 'x'.repeat(40 * 1024) }));
      expect(big.statusCode).toBe(413);
      expect(big.json().error).toBe('PAYLOAD_TOO_LARGE');

      const v = await post(body({ customer: { name: 'Анна', phone: '123', email: 'x' } }));
      expect(v.statusCode).toBe(422);
      expect(v.json()).toMatchObject({
        error: 'VALIDATION_ERROR',
        fields: [
          { field: 'customer.phone', code: 'INVALID_PHONE' },
          { field: 'customer.email', code: 'TOO_SHORT' },
        ],
      });

      const online = await post(body({ payment: { method: 'online' } }));
      expect(online.statusCode).toBe(422);
      expect(online.json().error).toBe('PAYMENT_METHOD_UNAVAILABLE');
      expect(orders.orders).toHaveLength(0);
    });
  });

  it('черновик (снятая с публикации карточка) не продаётся — CARD_NOT_AVAILABLE', async () => {
    await start({}, false);
    const res = await post(body());
    expect(res.statusCode).toBe(409);
    expect(res.json().items).toEqual([
      { index: 0, cardId, variantId: 'm1#a', code: 'CARD_NOT_AVAILABLE' },
    ]);
  });

  it('ORDERS_ENABLED=0 — 503 и флаг в конфиге чекаута', async () => {
    await start({ enabled: false });
    const res = await post(body());
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('ORDERS_DISABLED');
    expect((await app.inject({ url: '/api/checkout/config' })).json().ordersEnabled).toBe(false);
  });

  it('ограничение частоты по IP — 429 с Retry-After', async () => {
    await start({ rateLimit: 2, rateWindowMs: 60_000 });
    expect((await post(body())).statusCode).toBe(201);
    expect((await post(body())).statusCode).toBe(200);
    const third = await post(body());
    expect(third.statusCode).toBe(429);
    expect(third.headers['retry-after']).toBe('60');
    expect(third.json().error).toBe('RATE_LIMITED');
  });
});

describe('loadOrdersConfig', () => {
  it('дефолты v1 и переопределение через env', () => {
    expect(loadOrdersConfig({})).toEqual(DEFAULT_ORDERS_CONFIG);
    const c = loadOrdersConfig({
      ORDERS_ENABLED: 'false',
      ORDER_CDEK_FEE: '450',
      ORDER_FREE_DELIVERY_FROM: '',
      ORDER_PICKUP_ADDRESS: ' Омск, ул. Жукова, 65 ',
      ORDER_OFFER_VERSION: '2026-11-01',
    });
    expect(c).toMatchObject({
      enabled: false,
      cdekFee: 450,
      freeDeliveryFrom: null,
      pickupAddress: 'Омск, ул. Жукова, 65',
      offerVersion: '2026-11-01',
      onlinePayment: false,
    });
  });

  it('кривые суммы — ошибка старта, а не тихий ноль', () => {
    expect(() => loadOrdersConfig({ ORDER_CDEK_FEE: 'пятьсот' })).toThrow(/ORDER_CDEK_FEE/);
    expect(() => loadOrdersConfig({ ORDER_FREE_DELIVERY_FROM: '-1' })).toThrow();
    expect(() => loadOrdersConfig({ ORDER_RATE_LIMIT: '0' })).toThrow();
  });
});
