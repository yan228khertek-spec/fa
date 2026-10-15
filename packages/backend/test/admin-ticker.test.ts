import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { DEFAULT_TICKER, shopToday } from '../src/admin/ticker.js';

const auth = { authorization: `Basic ${Buffer.from('boss:secret').toString('base64')}` };
const write = { ...auth, 'x-fa-admin': '1' };

describe('бегущая строка', () => {
  let app: FastifyInstance;
  let dir: string;
  let clock = new Date('2026-10-15T12:00:00Z');

  beforeEach(async () => {
    clock = new Date('2026-10-15T12:00:00Z');
    dir = await mkdtemp(path.join(tmpdir(), 'fa-ticker-'));
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
      quiet: true,
      admin: {
        login: 'boss',
        password: 'secret',
        uploadsDir: path.join(dir, 'uploads'),
        publicBaseUrl: 'https://api.example.test',
        imagesBaseUrl: '',
      },
    } as AppConfig;
    app = await buildApp({ config, now: () => clock });
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: write, payload: payload as never });
  const pub = async () => (await app.inject({ method: 'GET', url: '/api/ticker' })).json();
  const promo = (over: Record<string, unknown> = {}) => ({
    title: 'Чёрная пятница',
    startsOn: '2026-11-20',
    endsOn: '2026-11-30',
    items: [{ text: 'Чёрная пятница: −30%', link: 'catalog.html?sale=1' }],
    bgColor: '#c8452f',
    textColor: '#FFFFFF',
    ...over,
  });

  it('без правок отдаёт стандартную строку, как была на сайте', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/ticker' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    const t = r.json();
    expect(t).toMatchObject({
      source: 'default',
      until: null,
      bgColor: '#2c2b27',
      textColor: '#ffffff',
    });
    expect(t.items).toEqual(DEFAULT_TICKER.items);
    const adm = (
      await app.inject({ method: 'GET', url: '/admin/api/ticker', headers: auth })
    ).json();
    expect(adm.default.isBuiltin).toBe(true);
    expect(adm.timeZone).toBe('Asia/Omsk');
  });

  it('закрыт без авторизации и без CSRF-заголовка', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/api/ticker' })).statusCode).toBe(401);
    const r = await app.inject({
      method: 'PUT',
      url: '/admin/api/ticker/default',
      headers: auth,
      payload: {},
    });
    expect(r.statusCode).toBe(403);
  });

  it('стандартную строку можно изменить и вернуть к исходной', async () => {
    const body = {
      items: [{ text: ' Новая фраза ', link: '' }],
      bgColor: '#112233',
      textColor: '#FFEEDD',
    };
    const r = await send('PUT', '/admin/api/ticker/default', body);
    expect(r.statusCode).toBe(200);
    expect(await pub()).toMatchObject({
      items: [{ text: 'Новая фраза', link: '' }],
      bgColor: '#112233',
      textColor: '#ffeedd',
      source: 'default',
    });
    const back = await send('DELETE', '/admin/api/ticker/default');
    expect(back.json().isBuiltin).toBe(true);
    expect((await pub()).items).toEqual(DEFAULT_TICKER.items);
  });

  it('проверяет входные данные', async () => {
    const ok = { items: [{ text: 'a', link: '' }], bgColor: '#000000', textColor: '#ffffff' };
    const bad = [
      { ...ok, items: [] },
      { ...ok, items: [{ text: '  ' }] },
      { ...ok, items: [{ text: 'x'.repeat(121) }] },
      { ...ok, items: Array.from({ length: 11 }, () => ({ text: 'a' })) },
      { ...ok, items: [{ text: 'a', link: 'javascript:alert(1)' }] },
      { ...ok, bgColor: 'red' },
      { ...ok, textColor: '#fff' },
    ];
    for (const b of bad)
      expect((await send('PUT', '/admin/api/ticker/default', b)).statusCode).toBe(400);
    expect(
      (await send('POST', '/admin/api/ticker/schedules', promo({ startsOn: '2026-02-30' })))
        .statusCode,
    ).toBe(400);
    expect(
      (await send('POST', '/admin/api/ticker/schedules', promo({ startsOn: '20.11.2026' })))
        .statusCode,
    ).toBe(400);
    expect(
      (await send('POST', '/admin/api/ticker/schedules', promo({ endsOn: '2026-11-19' })))
        .statusCode,
    ).toBe(400);
    expect((await send('PUT', '/admin/api/ticker/schedules/999', promo())).statusCode).toBe(404);
    expect((await send('DELETE', '/admin/api/ticker/schedules/999')).statusCode).toBe(404);
  });

  it('в период акции строка меняется, потом возвращается; границы включительно', async () => {
    const created = await send('POST', '/admin/api/ticker/schedules', promo());
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ textColor: '#ffffff', active: true });

    clock = new Date('2026-11-19T12:00:00Z'); // накануне
    expect((await pub()).source).toBe('default');
    clock = new Date('2026-11-20T00:30:00Z'); // 06:30 по Омску — первый день
    expect(await pub()).toMatchObject({
      source: 'schedule',
      bgColor: '#c8452f',
      until: '2026-11-30',
    });
    clock = new Date('2026-11-30T12:00:00Z'); // последний день
    expect((await pub()).source).toBe('schedule');
    clock = new Date('2026-12-01T12:00:00Z'); // после
    expect((await pub()).source).toBe('default');
  });

  it('сутки меняются по Омску (UTC+6), а не по серверу', () => {
    expect(shopToday(new Date('2026-11-19T17:59:00Z'))).toBe('2026-11-19');
    expect(shopToday(new Date('2026-11-19T18:00:00Z'))).toBe('2026-11-20');
  });

  it('выключенный период не действует; вложенная акция перекрывает общую', async () => {
    const wide = (
      await send(
        'POST',
        '/admin/api/ticker/schedules',
        promo({ title: 'Осень', startsOn: '2026-10-01', endsOn: '2026-10-31', bgColor: '#111111' }),
      )
    ).json();
    const inner = (
      await send(
        'POST',
        '/admin/api/ticker/schedules',
        promo({
          title: 'Неделя',
          startsOn: '2026-10-14',
          endsOn: '2026-10-20',
          bgColor: '#222222',
        }),
      )
    ).json();
    expect((await pub()).bgColor).toBe('#222222');
    await send(
      'PUT',
      `/admin/api/ticker/schedules/${inner.id}`,
      promo({ startsOn: '2026-10-14', endsOn: '2026-10-20', bgColor: '#222222', active: false }),
    );
    expect((await pub()).bgColor).toBe('#111111');
    await send('DELETE', `/admin/api/ticker/schedules/${wide.id}`);
    expect((await pub()).source).toBe('default');
  });

  it('админка показывает текущее состояние и список периодов по датам', async () => {
    await send(
      'POST',
      '/admin/api/ticker/schedules',
      promo({ title: 'Позже', startsOn: '2026-12-01', endsOn: '2026-12-10' }),
    );
    await send(
      'POST',
      '/admin/api/ticker/schedules',
      promo({ title: 'Раньше', startsOn: '2026-11-01', endsOn: '2026-11-05' }),
    );
    const a = (await app.inject({ method: 'GET', url: '/admin/api/ticker', headers: auth })).json();
    expect(a.today).toBe('2026-10-15');
    expect(a.schedules.map((s: { title: string }) => s.title)).toEqual(['Раньше', 'Позже']);
    expect(a.current.source).toBe('default');
  });
});
