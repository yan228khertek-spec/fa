import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const auth = { authorization: `Basic ${Buffer.from('boss:secret').toString('base64')}` };
const write = { ...auth, 'x-fa-admin': '1' };
const png = (n: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, n),
  ]);

describe('баннеры главной (HTTP)', () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fa-banners-'));
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
    };
    app = await buildApp({ config });
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (url: string, payload?: unknown) =>
    app.inject({ method: 'POST', url, headers: write, payload: payload as never });
  const put = (url: string, payload: unknown) =>
    app.inject({ method: 'PUT', url, headers: write, payload: payload as never });
  const upload = (url: string, n: number) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...write, 'content-type': 'image/png' },
      payload: png(n),
    });
  const files = () => readdir(path.join(dir, 'uploads'));

  it('без авторизации и без CSRF-заголовка админка закрыта', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/api/banners' })).statusCode).toBe(401);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/api/banners',
      headers: auth,
      payload: {},
    });
    expect(r.statusCode).toBe(403);
  });

  it('создание с настройками по умолчанию и правка точки фокуса', async () => {
    const r = await post('/admin/api/banners', {
      title: ' Новая коллекция ',
      link: 'catalog.html',
    });
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b).toMatchObject({
      title: 'Новая коллекция',
      theme: 'light',
      focusX: 50,
      focusY: 50,
      mobileFocusX: 50,
      mobileFocusY: 50,
      active: true,
      image: null,
    });
    const u = await put(`/admin/api/banners/${b.id}`, {
      mobileFocusX: 80.4,
      mobileFocusY: 120,
      theme: 'dark',
    });
    expect(u.json()).toMatchObject({ mobileFocusX: 80, mobileFocusY: 100, theme: 'dark' });
  });

  it('проверяет входные данные', async () => {
    expect((await post('/admin/api/banners', { link: 'javascript:alert(1)' })).statusCode).toBe(
      400,
    );
    expect((await post('/admin/api/banners', { title: 'x'.repeat(121) })).statusCode).toBe(400);
    expect((await post('/admin/api/banners', { theme: 'red' })).statusCode).toBe(400);
    const b = (await post('/admin/api/banners', {})).json();
    expect((await put(`/admin/api/banners/${b.id}`, { focusX: 'left' })).statusCode).toBe(400);
    expect((await put('/admin/api/banners/999', { title: 'a' })).statusCode).toBe(404);
  });

  it('публично отдаёт только включённые баннеры с картинкой, по порядку', async () => {
    const a = (await post('/admin/api/banners', { title: 'A' })).json();
    const b = (
      await post('/admin/api/banners', { title: 'B', focusX: 20, mobileFocusY: 10 })
    ).json();
    const c = (await post('/admin/api/banners', { title: 'C', active: false })).json();
    await post('/admin/api/banners', { title: 'D без картинки' });
    for (const x of [a, b, c]) await upload(`/admin/api/banners/${x.id}/image/desktop`, x.id);
    await upload(`/admin/api/banners/${b.id}/image/mobile`, 9);
    expect((await put('/admin/api/banners-order', { ids: [b.id, a.id, c.id, 4] })).statusCode).toBe(
      200,
    );

    const r = await app.inject({ method: 'GET', url: '/api/banners' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    const items = r.json().items;
    expect(items.map((i: { title: string }) => i.title)).toEqual(['B', 'A']);
    expect(items[0].image).toMatch(/^https:\/\/api\.example\.test\/uploads\/[0-9a-f]{16}\.png$/);
    expect(items[0].imageMobile).toMatch(/\/uploads\//);
    expect(items[1].imageMobile).toBeNull();
    expect(items[0].focus).toEqual({ x: 20, y: 50 });
    expect(items[0].mobileFocus).toEqual({ x: 50, y: 10 });
    expect(Object.keys(items[0])).not.toContain('active');
  });

  it('замена и удаление картинки чистят файлы', async () => {
    const b = (await post('/admin/api/banners', {})).json();
    const first = (await upload(`/admin/api/banners/${b.id}/image/desktop`, 1)).json();
    expect(await files()).toHaveLength(1);
    const second = (await upload(`/admin/api/banners/${b.id}/image/desktop`, 2)).json();
    expect(second.image).not.toBe(first.image);
    expect(await files()).toHaveLength(1);
    await upload(`/admin/api/banners/${b.id}/image/mobile`, 3);
    expect(await files()).toHaveLength(2);
    const del = await app.inject({
      method: 'DELETE',
      url: `/admin/api/banners/${b.id}/image/mobile`,
      headers: write,
    });
    expect(del.json().imageMobile).toBeNull();
    expect(await files()).toHaveLength(1);
    const rm1 = await app.inject({
      method: 'DELETE',
      url: `/admin/api/banners/${b.id}`,
      headers: write,
    });
    expect(rm1.statusCode).toBe(200);
    expect(await files()).toHaveLength(0);
  });

  it('не принимает не-картинки и неизвестный вид картинки', async () => {
    const b = (await post('/admin/api/banners', {})).json();
    const bad = await app.inject({
      method: 'POST',
      url: `/admin/api/banners/${b.id}/image/desktop`,
      headers: { ...write, 'content-type': 'image/png' },
      payload: Buffer.from('<svg/>'),
    });
    expect(bad.statusCode).toBe(400);
    expect((await upload(`/admin/api/banners/${b.id}/image/tablet`, 1)).statusCode).toBe(400);
    expect((await upload('/admin/api/banners/999/image/desktop', 1)).statusCode).toBe(404);
    expect(await files()).toHaveLength(0);
  });

  it('порядок требует все баннеры ровно по разу', async () => {
    const a = (await post('/admin/api/banners', {})).json();
    await post('/admin/api/banners', {});
    expect((await put('/admin/api/banners-order', { ids: [a.id] })).statusCode).toBe(400);
    expect((await put('/admin/api/banners-order', { ids: 'x' })).statusCode).toBe(400);
  });

  it('не больше 12 баннеров', async () => {
    for (let i = 0; i < 12; i++)
      expect((await post('/admin/api/banners', {})).statusCode).toBe(201);
    expect((await post('/admin/api/banners', {})).statusCode).toBe(409);
  });
});
