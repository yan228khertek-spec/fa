import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryAuthRepository } from '../src/auth/memory.js';
import { MemoryOrderRepository } from '../src/orders/memory.js';
import { MemoryCardRepository } from '../src/admin/cards-memory.js';
import { MemoryCatalogReader } from '../src/admin/memory.js';

const ORIGIN = 'https://shop.example.test';
const SECRET = 'test-secret-that-is-at-least-32-characters';
describe('закрытый API кабинета', () => {
  let app: FastifyInstance;
  let dir: string;
  let sent: { phone: string; code: string }[];
  let now: Date;
  let cardId: number;
  let orders: MemoryOrderRepository;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'fa-account-'));
    now = new Date('2026-11-02T12:00:00Z');
    sent = [];
    const config = loadConfig({
      NODE_ENV: 'test',
      ACCOUNT_ENABLED: '1',
      ACCOUNT_ORIGINS: ORIGIN,
      AUTH_CODE_SECRET: SECRET,
    });
    config.spoolDir = path.join(dir, 'spool');
    config.mediaDir = '';
    config.admin!.uploadsDir = path.join(dir, 'uploads');
    const cards = new MemoryCardRepository();
    const card = await cards.createCard({
      modelId: 'm1',
      title: 'Джемпер',
      description: '',
      characteristics: [],
    });
    cardId = card.id;
    await cards.addPhoto(cardId, 'aaaaaaaaaaaaaaaa.jpg');
    await cards.updateCard(cardId, { status: 'published' });
    orders = new MemoryOrderRepository();
    app = await buildApp({
      config,
      authRepo: new MemoryAuthRepository(),
      orderRepo: orders,
      cardRepo: cards,
      smsSender: {
        kind: 'test',
        async send(phone, code) {
          sent.push({ phone, code });
        },
      },
      now: () => now,
      catalogReader: new MemoryCatalogReader(
        [{ id: 'm1', name: 'Джемпер', article: 'D1', skus: 1, photo: null }],
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
                  quantity: 3,
                  price: 8000,
                  name: 'Джемпер',
                },
              ],
            },
          ],
        ]),
      ),
    });
  });
  afterEach(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });
  const headers = (cookie?: string, csrf?: string) => ({
    origin: ORIGIN,
    'x-fa-account': '1',
    ...(cookie ? { cookie } : {}),
    ...(csrf ? { 'x-fa-csrf': csrf } : {}),
  });
  async function login(phone = '+79131234567') {
    const code = await app.inject({
      method: 'POST',
      url: '/api/auth/code',
      headers: headers(),
      payload: { phone },
    });
    expect(code.statusCode).toBe(202);
    expect(code.json()).not.toHaveProperty('code');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: headers(),
      payload: { challengeId: code.json().challengeId, code: sent.at(-1)!.code },
    });
    expect(res.statusCode).toBe(200);
    return {
      cookie: String(res.headers['set-cookie']).split(';')[0],
      csrf: res.json().csrfToken as string,
      account: res.json().account,
      res,
    };
  }
  const order = () => ({
    customer: { name: 'Анна', phone: '+79131234567', email: 'anna@example.test' },
    delivery: { method: 'pickup' },
    payment: { method: 'on_receipt' },
    items: [{ cardId, variantId: 'm1#a', quantity: 1, price: 8000 }],
    consents: { personalData: true },
  });
  const createOrder = (
    user: { cookie: string; csrf: string },
    key = 'account-order-key-0000001',
    extra = {},
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/account/orders',
      headers: { ...headers(user.cookie, user.csrf), 'idempotency-key': key },
      payload: { ...order(), ...extra },
    });

  it('вход выдаёт защищённую cookie; профиль даёт данные для оформления', async () => {
    const user = await login();
    expect(user.res.headers['set-cookie']).toContain('HttpOnly');
    expect(user.res.headers['set-cookie']).toContain('Secure');
    expect(user.res.headers['set-cookie']).toContain('SameSite=Lax');
    expect(user.cookie).toMatch(/^__Host-fa_session=/);
    const me = await app.inject({ url: '/api/account/me', headers: headers(user.cookie) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ account: user.account, csrfToken: user.csrf });
    expect(me.headers['cache-control']).toBe('no-store');
    expect(me.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(me.headers['access-control-allow-credentials']).toBe('true');
  });
  it('без сессии профиль и заказы недоступны', async () => {
    for (const url of ['/api/account/me', '/api/account/orders', '/api/account/orders/FA-12345678'])
      expect((await app.inject({ url })).statusCode).toBe(401);
  });
  it('профиль сохраняет имя и email, нормализует email', async () => {
    const user = await login();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/account/me',
      headers: headers(user.cookie, user.csrf),
      payload: { name: ' Анна ', email: 'Anna@Example.Test' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().account).toMatchObject({ name: 'Анна', email: 'anna@example.test' });
    expect(
      (await app.inject({ url: '/api/account/me', headers: headers(user.cookie) })).json().account
        .name,
    ).toBe('Анна');
  });
  it('отклоняет изменение телефона, идентификатора и некорректные поля', async () => {
    const user = await login();
    for (const payload of [
      { phone: '+79139999999' },
      { userId: '2' },
      { name: 'a' },
      { email: 'bad' },
      { name: 'Анна\n' },
      {},
    ]) {
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/account/me',
            headers: headers(user.cookie, user.csrf),
            payload,
          })
        ).statusCode,
      ).toBe(422);
    }
  });
  it('не принимает изменения без CSRF или с чужим CSRF', async () => {
    const user = await login();
    for (const csrf of [undefined, 'wrong', 'я'.repeat(64)])
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/account/me',
            headers: headers(user.cookie, csrf),
            payload: { name: 'Анна' },
          })
        ).statusCode,
      ).toBe(403);
  });
  it('блокирует посторонний origin и отправку без клиентского заголовка', async () => {
    for (const h of [
      { origin: 'https://evil.test', 'x-fa-account': '1' },
      { origin: ORIGIN },
      { 'x-fa-account': '1' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/code',
        headers: h,
        payload: { phone: '+79131234567' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    }
    expect(sent).toHaveLength(0);
  });
  it('OPTIONS разрешает только доверенный origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/account/me',
      headers: { origin: ORIGIN, 'access-control-request-method': 'PATCH' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-headers']).toContain('x-fa-csrf');
    expect(
      (
        await app.inject({
          method: 'OPTIONS',
          url: '/api/account/me',
          headers: { origin: 'https://evil.test' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('выход отзывает сессию и очищает cookie', async () => {
    const user = await login();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: headers(user.cookie, user.csrf),
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['set-cookie']).toContain('Max-Age=0');
    expect(
      (await app.inject({ url: '/api/account/me', headers: headers(user.cookie) })).statusCode,
    ).toBe(401);
  });
  it('сессия истекает через 30 дней', async () => {
    const user = await login();
    now = new Date(now.getTime() + 30 * 86400_000);
    expect(
      (await app.inject({ url: '/api/account/me', headers: headers(user.cookie) })).statusCode,
    ).toBe(401);
  });
  it('валидация кода, JSON и размера тела не выдаёт подробности сервера', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/code',
          headers: headers(),
          payload: { phone: 'bad' },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/verify',
          headers: headers(),
          payload: { challengeId: 'bad', code: '123456' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/code',
          headers: { ...headers(), 'content-type': 'application/json' },
          payload: '{',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/code',
          headers: { ...headers(), 'content-type': 'application/json' },
          payload: 'x'.repeat(40_000),
        })
      ).statusCode,
    ).toBe(413);
  });
  it('старые гостевые заказы с тем же телефоном не попадают в ЛК', async () => {
    const guest = await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { 'idempotency-key': 'guest-order-key-00000001' },
      payload: order(),
    });
    expect(guest.statusCode).toBe(201);
    const user = await login();
    const list = await app.inject({ url: '/api/account/orders', headers: headers(user.cookie) });
    expect(list.statusCode).toBe(200);
    expect(list.json().orders).toEqual([]);
    expect(
      (
        await app.inject({
          url: `/api/account/orders/${guest.json().number}`,
          headers: headers(user.cookie),
        })
      ).statusCode,
    ).toBe(404);
  });
  it('новый заказ принадлежит сессии, имеет детали и повторяется без дубля', async () => {
    const user = await login();
    const first = await createOrder(user, undefined, { userId: '999' });
    expect(first.statusCode).toBe(201);
    const second = await createOrder(user, undefined, { userId: '999' });
    expect(second.statusCode).toBe(200);
    expect(second.json().number).toBe(first.json().number);
    expect(orders.orders).toHaveLength(1);
    expect(orders.orders[0].userId).toBe(user.account.id);
    const list = await app.inject({ url: '/api/account/orders', headers: headers(user.cookie) });
    expect(list.json().orders).toHaveLength(1);
    expect(list.json().orders[0]).not.toHaveProperty('token');
    const detail = await app.inject({
      url: `/api/account/orders/${first.json().number}`,
      headers: headers(user.cookie),
    });
    expect(detail.json().customer).toMatchObject({ name: 'Анна', email: 'anna@example.test' });
    expect(detail.json()).not.toHaveProperty('token');
    await app.inject({
      method: 'PATCH',
      url: '/api/account/me',
      headers: headers(user.cookie, user.csrf),
      payload: { name: 'Другое имя' },
    });
    expect(
      (
        await app.inject({
          url: `/api/account/orders/${first.json().number}`,
          headers: headers(user.cookie),
        })
      ).json().customer.name,
    ).toBe('Анна');
  });
  it('чужой аккаунт и гость не получают заказ повтором ключа', async () => {
    const alice = await login();
    const created = await createOrder(alice);
    const bob = await login('+79139999999');
    expect(
      (
        await app.inject({
          url: `/api/account/orders/${created.json().number}`,
          headers: headers(bob.cookie),
        })
      ).statusCode,
    ).toBe(404);
    expect((await createOrder(bob)).statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/orders',
          headers: { 'idempotency-key': 'account-order-key-0000001' },
          payload: order(),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ url: '/api/account/orders', headers: headers(bob.cookie) })).json()
        .orders,
    ).toEqual([]);
  });
  it('проверяет пагинацию', async () => {
    const user = await login();
    await createOrder(user);
    expect(
      (
        await app.inject({
          url: '/api/account/orders?limit=1&offset=1',
          headers: headers(user.cookie),
        })
      ).json().orders,
    ).toEqual([]);
    for (const query of ['limit=0', 'limit=101', 'offset=-1', 'limit=abc'])
      expect(
        (await app.inject({ url: `/api/account/orders?${query}`, headers: headers(user.cookie) }))
          .statusCode,
      ).toBe(422);
  });
});

describe('настройки ЛК', () => {
  it('модуль выключен по умолчанию', async () => {
    const app = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }) });
    try {
      expect((await app.inject({ url: '/api/account/me' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
  it('не включается без отправителя, секрета или origin', async () => {
    expect(() => loadConfig({ ACCOUNT_ENABLED: '1' })).toThrow();
    await expect(
      buildApp({
        config: loadConfig({
          ACCOUNT_ENABLED: '1',
          ACCOUNT_ORIGINS: ORIGIN,
          AUTH_CODE_SECRET: SECRET,
        }),
      }),
    ).rejects.toThrow(/SMS/);
  });
  it('production требует PostgreSQL и реальный отправитель', async () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        ACCOUNT_ENABLED: '1',
        ACCOUNT_ORIGINS: ORIGIN,
        AUTH_CODE_SECRET: SECRET,
      }),
    ).toThrow(/DATABASE_URL/);
    const config = loadConfig({
      NODE_ENV: 'production',
      ACCOUNT_ENABLED: '1',
      ACCOUNT_ORIGINS: ORIGIN,
      AUTH_CODE_SECRET: SECRET,
      DATABASE_URL: 'postgresql://localhost/not-connected',
    });
    await expect(
      buildApp({ config, smsSender: { kind: 'test', async send() {} } }),
    ).rejects.toThrow(/real SMS/);
    for (const origin of ['*', 'https://shop.example.test/path', 'http://shop.example.test'])
      expect(() =>
        loadConfig({ ACCOUNT_ENABLED: '1', ACCOUNT_ORIGINS: origin, AUTH_CODE_SECRET: SECRET }),
      ).toThrow(/ACCOUNT_ORIGINS/);
  });
});
