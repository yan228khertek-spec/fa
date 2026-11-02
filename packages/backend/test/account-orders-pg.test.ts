import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgAuthRepository } from '../src/auth/pg.js';
import { AuthService } from '../src/auth/service.js';
import { PgOrderRepository } from '../src/orders/pg.js';
import { OrderService } from '../src/orders/service.js';
import { DEFAULT_ORDERS_CONFIG } from '../src/orders/types.js';
import { parseOrderInput } from '../src/orders/validate.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('заказы ЛК PostgreSQL, изолированная схема', () => {
  const schema = `account_orders_${randomUUID().replaceAll('-', '')}`;
  let pool: pg.Pool;
  let repo: PgOrderRepository;
  let authRepo: PgAuthRepository;
  let service: OrderService;
  let accountId: string;
  let connection: string;
  const input = parseOrderInput(
    {
      customer: { name: 'Анна', phone: '+79131234567', email: 'anna@example.test' },
      delivery: { method: 'cdek', city: 'Омск', address: 'Улица, 1' },
      payment: { method: 'on_receipt' },
      items: [{ cardId: 1, variantId: 'm1#a', quantity: 1, price: 1000 }],
      consents: { personalData: true, marketing: true },
    },
    { onlinePayment: false },
  );
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    connection = url.toString();
    repo = new PgOrderRepository(connection);
    authRepo = new PgAuthRepository(connection);
    await repo.ready();
    await authRepo.ready();
    let code = '';
    const auth = new AuthService(
      authRepo,
      {
        kind: 'test',
        async send(_phone, sentCode) {
          code = sentCode;
        },
      },
      'test-secret-that-is-at-least-32-characters',
    );
    const challenge = await auth.requestCode('+79131234567', '127.0.0.1');
    accountId = (await auth.verifyCode(challenge.challengeId, code)).account.id;
    service = new OrderService(
      repo,
      {
        async orderable() {
          return new Map([
            [
              1,
              {
                cardId: 1,
                modelId: 'm1',
                title: 'Джемпер',
                article: 'D1',
                variants: new Map([
                  [
                    'm1#a',
                    { name: 'Джемпер', size: '46', color: 'красный', price: 1000, quantity: 3 },
                  ],
                ]),
              },
            ],
          ]);
        },
      },
      DEFAULT_ORDERS_CONFIG,
    );
  });
  afterAll(async () => {
    await repo?.close();
    await authRepo?.close();
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool?.end();
  });
  it('сохраняет владельца, согласие и снимок; исключает гостевые и чужие заказы', async () => {
    const guest = await service.create(input, {
      idempotencyKey: 'guest-pg-order-key',
      clientIp: null,
      userAgent: null,
    });
    const own = await service.create(input, {
      idempotencyKey: 'own-pg-order-key',
      clientIp: null,
      userAgent: null,
      userId: accountId,
    });
    const restarted = new PgOrderRepository(connection);
    try {
      const list = await restarted.listForUser(accountId, 20, 0);
      expect(list.map((o) => o.number)).toEqual([own.order.number]);
      expect(list[0]).toMatchObject({
        customer: { name: 'Анна' },
        delivery: { city: 'Омск', address: 'Улица, 1' },
      });
      expect(await restarted.findForUser(accountId, guest.order.number)).toBeNull();
      expect(await restarted.findForUser('99999', own.order.number)).toBeNull();
      expect(await restarted.findByIdempotencyKey('own-pg-order-key')).toMatchObject({
        userId: accountId,
      });
      const { rows } = await pool.query(
        `SELECT user_id::text FROM ${schema}.marketing_consents WHERE user_id IS NOT NULL`,
      );
      expect(rows).toEqual([{ user_id: accountId }]);
      await authRepo.updateProfile(accountId, { name: 'Другое имя' });
      expect((await restarted.findForUser(accountId, own.order.number))?.customer.name).toBe(
        'Анна',
      );
      expect(await restarted.listForUser(accountId, 1, 1)).toEqual([]);
    } finally {
      await restarted.close();
    }
    expect(
      (
        await service.create(input, {
          idempotencyKey: 'own-pg-order-key',
          clientIp: null,
          userAgent: null,
          userId: accountId,
        })
      ).replayed,
    ).toBe(true);
    for (const userId of [null, '99999'])
      await expect(
        service.create(input, {
          idempotencyKey: 'own-pg-order-key',
          clientIp: null,
          userAgent: null,
          userId,
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await repo.listPendingExport(10)).toHaveLength(2);
  });
});
