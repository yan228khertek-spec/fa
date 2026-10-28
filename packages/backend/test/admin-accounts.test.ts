import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, loadExtraAdmins, type AppConfig } from '../src/config.js';

const basic = (l: string, p: string) => `Basic ${Buffer.from(`${l}:${p}`).toString('base64')}`;

describe('несколько аккаунтов админки', () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fa-acc-'));
    const config: AppConfig = {
      port: 0,
      host: '127.0.0.1',
      exchangeLogin: 'x',
      exchangePassword: 'y',
      fileLimit: 1024,
      spoolDir: path.join(dir, 'spool'),
      mediaDir: path.join(dir, 'media'),
      importWaitMs: 100,
      unpackLimit: 1024,
      databaseUrl: undefined,
      quiet: true,
      admin: {
        login: 'boss',
        password: 'secret',
        extraUsers: [{ login: 'client', password: 'p:a,s;s' }],
        uploadsDir: path.join(dir, 'uploads'),
        publicBaseUrl: 'https://api.example.test',
        imagesBaseUrl: '',
      },
    };
    app = await buildApp({ config });
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const status = async (authorization?: string) =>
    (
      await app.inject({
        url: '/admin/api/posts',
        headers: authorization ? { authorization } : {},
      })
    ).statusCode;

  it('входят и основной, и дополнительный аккаунт (пароль со спецсимволами)', async () => {
    expect(await status(basic('boss', 'secret'))).toBe(200);
    expect(await status(basic('client', 'p:a,s;s'))).toBe(200);
  });

  it('логин и пароль разных аккаунтов не смешиваются, без входа — 401', async () => {
    expect(await status(basic('client', 'secret'))).toBe(401);
    expect(await status(basic('boss', 'p:a,s;s'))).toBe(401);
    expect(await status(basic('client', 'wrong'))).toBe(401);
    expect(await status()).toBe(401);
  });

  it('дополнительный аккаунт работает и на запись, с тем же заголовком защиты', async () => {
    const post = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/admin/api/posts', headers, payload: { title: 'Пост' } });
    expect((await post({ authorization: basic('client', 'p:a,s;s') })).statusCode).toBe(403);
    expect(
      (await post({ authorization: basic('client', 'p:a,s;s'), 'x-fa-admin': '1' })).statusCode,
    ).toBe(201);
  });

  it('конфиг: пары ADMIN_LOGIN_n/ADMIN_PASSWORD_n, неполные пары игнорируются', () => {
    expect(
      loadExtraAdmins({
        ADMIN_LOGIN_2: 'a',
        ADMIN_PASSWORD_2: 'b',
        ADMIN_LOGIN_3: 'only-login',
        ADMIN_PASSWORD_4: 'only-password',
        ADMIN_LOGIN_5: 'e',
        ADMIN_PASSWORD_5: 'f',
      }),
    ).toEqual([
      { login: 'a', password: 'b' },
      { login: 'e', password: 'f' },
    ]);
    expect(loadConfig({}).admin?.extraUsers).toEqual([]);
  });
});
