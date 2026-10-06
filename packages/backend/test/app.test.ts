import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('app', () => {
  it('healthz отвечает 200 и plain "ok"', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok');
    await app.close();
  });
});
