import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IDEMPOTENCY_KEY, parseOrderInput } from './validate.js';
import type { OrderService } from './service.js';
import { MAX_ITEMS, MAX_QUANTITY, OrderError, type OrderView } from './types.js';

export interface OrdersPluginOptions {
  orders: OrderService;
}

/** Тело заказа маленькое: 30 позиций и поля формы укладываются в несколько КБ. */
export const ORDER_BODY_LIMIT = 32 * 1024;

const rub = (kop: number) => kop / 100;

/** Представление заказа для покупателя: деньги в рублях, без ПД (имя, телефон, email, адрес). */
export function orderDto(o: OrderView, withToken: boolean) {
  return {
    number: o.number,
    ...(withToken ? { token: o.token } : {}),
    createdAt: o.createdAt,
    status: o.status,
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod,
    delivery: { method: o.delivery.method },
    currency: o.currency,
    itemsTotal: rub(o.itemsTotalKop),
    deliveryCost: rub(o.deliveryCostKop),
    bonusAmount: rub(o.bonusAmountKop),
    total: rub(o.totalKop),
    items: o.items.map((i) => ({
      cardId: i.cardId,
      title: i.title,
      article: i.article,
      size: i.size,
      color: i.color,
      price: rub(i.priceKop),
      quantity: i.quantity,
      amount: rub(i.amountKop),
    })),
  };
}

/**
 * Ограничитель частоты по IP (скользящее окно). Память ограничена: при росте карты
 * устаревшие адреса вычищаются целиком, чтобы поток разных IP не раздувал процесс.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Учитывает попытку; true — лимит превышен (попытка не засчитывается). */
  hit(key: string, now = Date.now()): boolean {
    if (this.hits.size > 10_000) {
      for (const [k, list] of this.hits) {
        if (!list.some((t) => now - t < this.windowMs)) this.hits.delete(k);
      }
    }
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return true;
    }
    list.push(now);
    this.hits.set(key, list);
    return false;
  }
}

/**
 * Публичное API заказов (трек F1, контракт v1.2 — docs/api-contract.md, раздел «Заказы»):
 *   GET  /api/checkout/config    — тарифы доставки, способы оплаты, версии документов
 *   POST /api/orders             — оформить заказ (Idempotency-Key обязателен)
 *   GET  /api/orders/:token      — заказ для страницы «Спасибо» (без ПД)
 * CORS как у остального публичного API. Ответы об ошибках — {error, message, …}.
 */
export async function ordersPlugin(app: FastifyInstance, opts: OrdersPluginOptions): Promise<void> {
  const { orders } = opts;
  const cfg = orders.config;
  const limiter = new RateLimiter(cfg.rateLimit, cfg.rateWindowMs);

  app.addHook('onSend', async (_req, reply) => {
    reply.header('access-control-allow-origin', '*');
  });

  app.setErrorHandler((err: Error & { code?: string; statusCode?: number }, req, reply) => {
    if (err instanceof OrderError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, ...err.extra });
    }
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply
        .code(413)
        .send({ error: 'PAYLOAD_TOO_LARGE', message: 'Слишком большой запрос' });
    }
    if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply
        .code(415)
        .send({ error: 'UNSUPPORTED_MEDIA_TYPE', message: 'Ожидается application/json' });
    }
    if (err.statusCode === 400) {
      return reply.code(400).send({ error: 'INVALID_JSON', message: 'Тело запроса — не JSON' });
    }
    req.log.error({ err }, 'orders request failed');
    return reply
      .code(500)
      .send({ error: 'INTERNAL_ERROR', message: 'Внутренняя ошибка, заказ не создан' });
  });

  app.get('/api/checkout/config', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    return {
      ordersEnabled: cfg.enabled,
      currency: 'RUB',
      delivery: {
        methods: [
          {
            id: 'pickup',
            title: 'Самовывоз из магазина',
            cost: 0,
            address: cfg.pickupAddress || null,
          },
          {
            id: 'cdek',
            title: 'Доставка СДЭК',
            cost: cfg.cdekFee,
            freeFrom: cfg.freeDeliveryFrom,
          },
        ],
      },
      payment: {
        methods: [
          { id: 'on_receipt', title: 'Оплата при получении', available: true },
          { id: 'online', title: 'Онлайн-оплата картой', available: cfg.onlinePayment },
        ],
      },
      documents: {
        offerVersion: cfg.offerVersion,
        pdPolicyVersion: cfg.pdPolicyVersion,
        marketingConsentVersion: cfg.marketingConsentVersion,
      },
      limits: { maxItems: MAX_ITEMS, maxQuantity: MAX_QUANTITY },
    };
  });

  // Предзапрос браузера: POST с JSON и своим заголовком с другого поддомена.
  app.options('/api/orders', async (_req, reply) =>
    reply
      .code(204)
      .header('access-control-allow-methods', 'POST, OPTIONS')
      .header('access-control-allow-headers', 'content-type, idempotency-key')
      .header('access-control-max-age', '600')
      .send(),
  );

  app.post(
    '/api/orders',
    {
      bodyLimit: ORDER_BODY_LIMIT,
      // До разбора тела: выключатель и лимит частоты дешевле JSON-парсинга.
      onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
        reply.header('cache-control', 'no-store');
        if (!cfg.enabled) {
          return reply
            .code(503)
            .send({ error: 'ORDERS_DISABLED', message: 'Оформление заказов временно недоступно' });
        }
        if (limiter.hit(req.ip)) {
          return reply
            .code(429)
            .header('retry-after', String(Math.ceil(cfg.rateWindowMs / 1000)))
            .send({ error: 'RATE_LIMITED', message: 'Слишком много попыток, попробуйте позже' });
        }
        return undefined;
      },
    },
    async (req, reply) => {
      const type = String(req.headers['content-type'] ?? '').toLowerCase();
      if (!type.startsWith('application/json')) {
        throw new OrderError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Ожидается application/json');
      }
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
        throw new OrderError(
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'Нужен заголовок Idempotency-Key (16–128 символов A-Z a-z 0-9 _ -)',
        );
      }
      const input = parseOrderInput(req.body, { onlinePayment: cfg.onlinePayment });
      const ua = req.headers['user-agent'];
      const res = await orders.create(input, {
        idempotencyKey: key,
        clientIp: req.ip ?? null,
        userAgent: typeof ua === 'string' ? ua.slice(0, 500) : null,
      });
      if (res.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(res.replayed ? 200 : 201).send(orderDto(res.order, true));
    },
  );

  app.get('/api/orders/:token', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const order = await orders.byToken((req.params as { token: string }).token);
    if (!order)
      return reply.code(404).send({ error: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    return orderDto(order, false);
  });
}
