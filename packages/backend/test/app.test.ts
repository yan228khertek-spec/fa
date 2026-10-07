import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('app', () => {
  it('healthz отвечает 200, plain text и "ok"', async () => {
    const app = await buildApp({
      config: {
        port: 0,
        host: '127.0.0.1',
        exchangeLogin: 'x',
        exchangePassword: 'y',
        fileLimit: 1024,
        spoolDir: 'spool',
        databaseUrl: undefined,
        quiet: true,
      },
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('ok');
    await app.close();
  });
});
