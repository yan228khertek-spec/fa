import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthService, SESSION_SECONDS } from '../auth/service.js';
import { AccountError, type Account, type AccountConfig } from '../auth/types.js';
import { ORDER_BODY_LIMIT, orderDto, RateLimiter } from '../orders/plugin.js';
import type { OrderService } from '../orders/service.js';
import { OrderError } from '../orders/types.js';
import { IDEMPOTENCY_KEY, parseOrderInput } from '../orders/validate.js';
import { object, pagination, profilePatch, string } from './validate.js';

export const SESSION_COOKIE = '__Host-fa_session';
const cookie = (value: string, maxAge: number) =>
  `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const readCookie = (req: FastifyRequest): string => {
  const values = (req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return values.length === 1 ? values[0]!.slice(SESSION_COOKIE.length + 1) : '';
};

export async function accountPlugin(
  app: FastifyInstance,
  opts: { auth: AuthService; orders: OrderService; config: AccountConfig },
): Promise<void> {
  const { auth, orders, config } = opts;
  const sessions = new WeakMap<FastifyRequest, { token: string; account: Account }>();
  const limiter = new RateLimiter(orders.config.rateLimit, orders.config.rateWindowMs);
  const user = (req: FastifyRequest) => {
    const session = sessions.get(req);
    if (!session) throw new AccountError(401, 'UNAUTHENTICATED');
    return session;
  };

  app.addHook('onRequest', async (req, reply) => {
    reply.header('cache-control', 'no-store').header('vary', 'Origin');
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!config.origins.includes(origin)) throw new AccountError(403, 'ORIGIN_FORBIDDEN');
      reply
        .header('access-control-allow-origin', origin)
        .header('access-control-allow-credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      if (!origin) throw new AccountError(403, 'ORIGIN_FORBIDDEN');
      return reply
        .code(204)
        .header('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS')
        .header(
          'access-control-allow-headers',
          'content-type, x-fa-account, x-fa-csrf, idempotency-key',
        )
        .header('access-control-max-age', '600')
        .send();
    }
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if (write && (!origin || req.headers['x-fa-account'] !== '1'))
      throw new AccountError(403, 'ORIGIN_FORBIDDEN');
    if (
      req.routeOptions.url?.startsWith('/api/account/') ||
      req.routeOptions.url === '/api/auth/logout'
    ) {
      const token = readCookie(req);
      const account = await auth.authenticate(token);
      if (!account) throw new AccountError(401, 'UNAUTHENTICATED');
      sessions.set(req, { token, account });
      if (write) {
        const csrf = req.headers['x-fa-csrf'];
        const expected = auth.csrfToken(token);
        if (
          typeof csrf !== 'string' ||
          !/^[0-9a-f]{64}$/.test(csrf) ||
          !timingSafeEqual(Buffer.from(csrf), Buffer.from(expected))
        )
          throw new AccountError(403, 'CSRF_INVALID');
      }
    }
    if (write && req.method !== 'POST' && req.method !== 'PATCH')
      throw new AccountError(405, 'METHOD_NOT_ALLOWED');
  });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (error instanceof AccountError) {
      if (error.code === 'RATE_LIMITED') reply.header('retry-after', '60');
      return reply.code(error.status).send({ error: error.code });
    }
    if (error instanceof OrderError)
      return reply
        .code(error.status)
        .send({ error: error.code, message: error.message, ...error.extra });
    if (error.statusCode === 413) return reply.code(413).send({ error: 'PAYLOAD_TOO_LARGE' });
    if (error.statusCode === 415) return reply.code(415).send({ error: 'UNSUPPORTED_MEDIA_TYPE' });
    if (error.statusCode === 400) return reply.code(400).send({ error: 'INVALID_JSON' });
    req.log.error('account request failed');
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });
  app.options('/api/auth/*', async () => undefined);
  app.options('/api/account/*', async () => undefined);
  const json = (req: FastifyRequest) => {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
      throw new AccountError(415, 'UNSUPPORTED_MEDIA_TYPE');
  };
  const routeOptions = { bodyLimit: ORDER_BODY_LIMIT, logLevel: 'warn' as const };

  app.post('/api/auth/code', routeOptions, async (req, reply) => {
    json(req);
    const body = object(req.body, ['phone']);
    const phone = string(body.phone);
    if (phone.length > 40) throw new AccountError(422, 'INVALID_PHONE');
    return reply.code(202).send(await auth.requestCode(phone, req.ip));
  });
  app.post('/api/auth/verify', routeOptions, async (req, reply) => {
    json(req);
    const body = object(req.body, ['challengeId', 'code']);
    const result = await auth.verifyCode(string(body.challengeId), string(body.code));
    // A new login replaces the current browser session, without leaving it active server-side.
    await auth.logout(readCookie(req));
    reply.header('set-cookie', cookie(result.token, SESSION_SECONDS));
    return { account: result.account, csrfToken: auth.csrfToken(result.token) };
  });
  app.post('/api/auth/logout', routeOptions, async (req, reply) => {
    await auth.logout(user(req).token);
    return reply.code(204).header('set-cookie', cookie('', 0)).send();
  });
  app.get('/api/account/me', async (req) => {
    const session = user(req);
    return { account: session.account, csrfToken: auth.csrfToken(session.token) };
  });
  app.patch('/api/account/me', routeOptions, async (req) => {
    json(req);
    return { account: await auth.repo.updateProfile(user(req).account.id, profilePatch(req.body)) };
  });
  app.get('/api/account/orders', async (req) => {
    const { limit, offset } = pagination(req.query);
    const rows = await orders.repo.listForUser(user(req).account.id, limit, offset);
    return { orders: rows.map((row) => orderDto(row, false)), limit, offset };
  });
  app.get('/api/account/orders/:number', async (req) => {
    const { number } = req.params as { number: string };
    if (!/^FA-[0-9]{8}$/.test(number)) throw new AccountError(404, 'ORDER_NOT_FOUND');
    const row = await orders.repo.findForUser(user(req).account.id, number);
    if (!row) throw new AccountError(404, 'ORDER_NOT_FOUND');
    return {
      ...orderDto(row, false),
      customer: row.customer,
      delivery: row.delivery,
      comment: row.comment,
    };
  });
  app.post('/api/account/orders', routeOptions, async (req, reply) => {
    json(req);
    if (!orders.config.enabled) throw new AccountError(503, 'ORDERS_DISABLED');
    if (limiter.hit(req.ip)) throw new AccountError(429, 'RATE_LIMITED');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key))
      throw new AccountError(400, 'IDEMPOTENCY_KEY_REQUIRED');
    const input = parseOrderInput(req.body, { onlinePayment: orders.config.onlinePayment });
    const result = await orders.create(input, {
      idempotencyKey: key,
      clientIp: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500) ?? null,
      userId: user(req).account.id,
    });
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(result.replayed ? 200 : 201).send(orderDto(result.order, true));
  });
}
