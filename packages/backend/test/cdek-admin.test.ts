import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const url = '/admin/api/cdek/calculate';
const headers = {
  authorization: `Basic ${Buffer.from('admin:test-password').toString('base64')}`,
  'x-fa-admin': '1',
};
const payload = {
  tariffCode: 136,
  fromLocation: { code: 268 },
  toLocation: { code: 44 },
  packages: [{ weightG: 1200, lengthCm: 30, widthCm: 20, heightCm: 10 }],
};

describe('protected CDEK calculation via buildApp', () => {
  let app: FastifyInstance | undefined;
  let dir: string;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fa-cdek-'));
    fetcher = vi.fn<typeof fetch>(async (target) =>
      String(target).endsWith('/oauth/token')
        ? Response.json({ access_token: 'private-token', expires_in: 3600 })
        : Response.json({
            total_sum: 612.34,
            delivery_sum: 500,
            currency: 'RUB',
            period_min: 2,
            period_max: 5,
            weight_calc: 1200,
          }),
    );
    vi.stubGlobal('fetch', fetcher);
  });
  afterEach(async () => {
    await app?.close();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });
  async function start(enabled = true, admin = true) {
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        ADMIN_LOGIN: admin ? 'admin' : '',
        ADMIN_PASSWORD: admin ? 'test-password' : '',
        ADMIN_UPLOADS_DIR: path.join(dir, 'uploads'),
        EXCHANGE_SPOOL_DIR: path.join(dir, 'spool'),
        EXCHANGE_MEDIA_DIR: path.join(dir, 'media'),
        CDEK_ENABLED: enabled ? '1' : '0',
        CDEK_ENVIRONMENT: 'test',
        CDEK_CLIENT_ID: 'private-account',
        CDEK_CLIENT_SECRET: 'private-secret',
      }),
    });
    return app;
  }

  it('requires admin authentication and CSRF before contacting CDEK', async () => {
    const server = await start();
    expect((await server.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    expect(
      (
        await server.inject({
          method: 'POST',
          url,
          payload,
          headers: { authorization: headers.authorization },
        })
      ).statusCode,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('calculates using configured credentials and returns no secrets or cached response', async () => {
    const server = await start();
    const response = await server.inject({ method: 'POST', url, headers, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      environment: 'test',
      currency: 'RUB',
      deliveryCostKop: 61234,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toMatch(/private-(token|account|secret)/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports disabled integration and does not call provider', async () => {
    const server = await start(false);
    const response = await server.inject({ method: 'POST', url, headers, payload });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'CDEK_DISABLED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not expose calculator when the admin area is disabled', async () => {
    const server = await start(true, false);
    expect((await server.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects invalid shipment and malformed JSON before calculation', async () => {
    const server = await start();
    expect(
      (await server.inject({ method: 'POST', url, headers, payload: { ...payload, packages: [] } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: 'POST',
          url,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: '{',
        })
      ).statusCode,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('limits request body size and calculation attempts', async () => {
    const server = await start();
    expect(
      (
        await server.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...payload, extra: 'x'.repeat(33000) },
        })
      ).statusCode,
    ).toBe(413);
    for (let i = 0; i < 20; i++) {
      expect((await server.inject({ method: 'POST', url, headers, payload: {} })).statusCode).toBe(
        400,
      );
    }
    const response = await server.inject({ method: 'POST', url, headers, payload });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('60');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns a safe provider error instead of the legacy fee', async () => {
    const server = await start();
    fetcher.mockRejectedValue(new Error('private-secret private-account'));
    const response = await server.inject({ method: 'POST', url, headers, payload });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'CDEK_UNAVAILABLE' });
    expect(response.body).not.toMatch(/private|500|deliveryCost/);
  });

  it('keeps the public checkout contract unchanged', async () => {
    const server = await start();
    const response = await server.inject('/api/checkout/config');
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/private|CDEK_CLIENT/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
