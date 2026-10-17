import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryCatalogReader } from '../src/admin/memory.js';
import type { AppConfig } from '../src/config.js';

const auth = { authorization: `Basic ${Buffer.from('boss:secret').toString('base64')}` };
const write = { ...auth, 'x-fa-admin': '1' };
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);

describe('админка брендов (HTTP)', () => {
  let app: FastifyInstance;
  let dir: string;

  const config = (over: Partial<NonNullable<AppConfig['admin']>> = {}): AppConfig => ({
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
      ...over,
    },
  });

  const build = async (over = {}) => {
    app = await buildApp({
      config: config(over),
      catalogReader: new MemoryCatalogReader([
        {
          id: 'm1',
          name: 'Джемпер Diesel',
          skus: 4,
          photo: 'import_files/ab/1.jpg',
          article: 'D-1',
        },
        { id: 'm2', name: 'Без бренда', skus: 1, photo: null, article: null },
      ]),
    });
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fa-admin-'));
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('админка закрыта без авторизации и без заголовка CSRF', async () => {
    await build();
    expect((await app.inject({ url: '/admin' })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/admin/api/brands', headers: { authorization: 'Basic bad' } }))
        .statusCode,
    ).toBe(401);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/admin/api/brands',
      headers: auth,
      payload: { name: 'Diesel' },
    });
    expect(noCsrf.statusCode).toBe(403);
    const ui = await app.inject({ url: '/admin', headers: auth });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');
    expect(ui.body).toContain('FASHION AVENUE');
    // каждая кнопка диалога карточки должна иметь обработчик в странице
    for (const id of ['kFrom1c', 'kUp', 'kSave', 'kClose', 'kDel', 'kAddKv']) {
      expect(ui.body).toContain(`id="${id}"`);
      expect(ui.body).toMatch(new RegExp(`\\$\\('#${id}'\\)\\.on(click|change)`));
    }
  });

  it('без ADMIN_LOGIN/ADMIN_PASSWORD админки нет, публичное API есть', async () => {
    await build({ login: '', password: '' });
    expect((await app.inject({ url: '/admin', headers: auth })).statusCode).toBe(404);
    const res = await app.inject({ url: '/api/brands?gender=men' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ gender: 'men', top: [], all: [] });
  });

  it('блокирует подбор пароля', async () => {
    await build();
    for (let i = 0; i < 10; i++)
      await app.inject({ url: '/admin', headers: { authorization: 'Basic eDp5' } });
    expect((await app.inject({ url: '/admin', headers: auth })).statusCode).toBe(429);
  });

  it('сценарий: завести бренд, топ, фото → публичное API', async () => {
    await build();
    const created = await app.inject({
      method: 'POST',
      url: '/admin/api/brands',
      headers: write,
      payload: { name: 'Diesel', placements: { men: { top: true } } },
    });
    expect(created.statusCode).toBe(201);
    const brand = created.json();
    expect(brand).toMatchObject({ slug: 'diesel', models: 1, photo: null });

    const up = await app.inject({
      method: 'POST',
      url: `/admin/api/brands/${brand.id}/image/photo`,
      headers: { ...write, 'content-type': 'application/octet-stream' },
      payload: PNG,
    });
    expect(up.statusCode).toBe(200);
    const photoUrl: string = up.json().photo;
    expect(photoUrl).toMatch(/^https:\/\/api\.example\.test\/uploads\/[a-f0-9]{16}\.png$/);

    const pub = await app.inject({ url: '/api/brands?gender=men' });
    expect(pub.headers['access-control-allow-origin']).toBe('*');
    expect(pub.json()).toEqual({
      gender: 'men',
      top: [{ name: 'Diesel', slug: 'diesel', photo: photoUrl, logo: null }],
      all: [{ name: 'Diesel', slug: 'diesel' }],
    });

    const file = await app.inject({ url: new URL(photoUrl).pathname });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.rawPayload.equals(PNG)).toBe(true);

    // карточек ещё нет — на витрине бренда пусто
    const models = await app.inject({ url: '/api/brands/diesel/models' });
    expect(models.json()).toEqual({
      brand: {
        name: 'Diesel',
        slug: 'diesel',
        cover: null,
        coverMobile: null,
        heroTitle: '',
        description: '',
      },
      total: 0,
      facets: { brands: [], categories: [], colors: [], kinds: [], price: null, sizes: [] },
      items: [],
    });
    expect((await app.inject({ url: '/api/brands/nope/models' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/brands?gender=kids' })).statusCode).toBe(400);

    // замена фото удаляет старый файл, удаление бренда — оба
    await app.inject({
      method: 'POST',
      url: `/admin/api/brands/${brand.id}/image/photo`,
      headers: { ...write, 'content-type': 'application/octet-stream' },
      payload: PNG,
    });
    expect(await readdir(path.join(dir, 'uploads'))).toHaveLength(1);
    const del = await app.inject({
      method: 'DELETE',
      url: `/admin/api/brands/${brand.id}`,
      headers: write,
    });
    expect(del.statusCode).toBe(200);
    expect(await readdir(path.join(dir, 'uploads'))).toHaveLength(0);
  });

  it('шапка страницы бренда: заголовок, описание и обложки уходят в публичное API', async () => {
    await build();
    const brand = (
      await app.inject({
        method: 'POST',
        url: '/admin/api/brands',
        headers: write,
        payload: { name: 'Miss Sixty' },
      })
    ).json();
    expect(brand).toMatchObject({ heroTitle: '', description: '', cover: null, coverMobile: null });
    const put = (payload: unknown) =>
      app.inject({
        method: 'PUT',
        url: `/admin/api/brands/${brand.id}`,
        headers: write,
        payload: payload as never,
      });
    const ok = await put({
      heroTitle: '  Italian   Retro ',
      description: 'Первый абзац.  \r\n\r\n\r\n\r\nВторой абзац.',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      heroTitle: 'Italian Retro',
      description: 'Первый абзац.\n\nВторой абзац.',
    });
    // пустую строку можно сохранить — так шапку очищают; слишком длинное не пускаем
    expect((await put({ heroTitle: '' })).json().heroTitle).toBe('');
    expect((await put({ heroTitle: 'я'.repeat(121) })).statusCode).toBe(400);
    expect((await put({ description: 'я'.repeat(2001) })).statusCode).toBe(400);
    expect((await put({ description: 5 })).statusCode).toBe(400);
    // название другого поля не затирается
    expect((await put({ name: 'Miss Sixty' })).json().description).toBe(
      'Первый абзац.\n\nВторой абзац.',
    );

    const up = (kind: string) =>
      app.inject({
        method: 'POST',
        url: `/admin/api/brands/${brand.id}/image/${kind}`,
        headers: { ...write, 'content-type': 'application/octet-stream' },
        payload: PNG,
      });
    const withCover = (await up('cover')).json();
    expect(withCover.cover).toMatch(/^https:\/\/api\.example\.test\/uploads\/[a-f0-9]{16}\.png$/);
    expect(withCover.coverMobile).toBeNull();
    const withMobile = (await up('coverMobile')).json();
    expect(withMobile.coverMobile).toMatch(/\/uploads\//);
    expect((await up('banner')).statusCode).toBe(400);

    const pub = (await app.inject({ url: '/api/brands/miss-sixty/models' })).json();
    expect(pub.brand).toEqual({
      name: 'Miss Sixty',
      slug: 'miss-sixty',
      cover: withCover.cover,
      coverMobile: withMobile.coverMobile,
      heroTitle: '',
      description: 'Первый абзац.\n\nВторой абзац.',
    });

    // замена обложки убирает прежний файл, удаление бренда — все
    await up('cover');
    expect(await readdir(path.join(dir, 'uploads'))).toHaveLength(2);
    const rm = await app.inject({
      method: 'DELETE',
      url: `/admin/api/brands/${brand.id}/image/coverMobile`,
      headers: write,
    });
    expect(rm.json().coverMobile).toBeNull();
    expect(await readdir(path.join(dir, 'uploads'))).toHaveLength(1);
    await app.inject({ method: 'DELETE', url: `/admin/api/brands/${brand.id}`, headers: write });
    expect(await readdir(path.join(dir, 'uploads'))).toHaveLength(0);
  });

  it('принимает только настоящие картинки', async () => {
    await build();
    const b = (
      await app.inject({
        method: 'POST',
        url: '/admin/api/brands',
        headers: write,
        payload: { name: 'Diesel' },
      })
    ).json();
    const post = (payload: Buffer | string, type = 'application/octet-stream') =>
      app.inject({
        method: 'POST',
        url: `/admin/api/brands/${b.id}/image/logo`,
        headers: { ...write, 'content-type': type },
        payload,
      });
    expect((await post('<svg onload=alert(1)>')).statusCode).toBe(400);
    expect((await post(Buffer.alloc(0))).statusCode).toBe(400);
    expect((await post(PNG, 'image/gif')).statusCode).toBe(415);
    expect((await readdir(path.join(dir, 'uploads'))).length).toBe(0);
    const missing = await app.inject({
      method: 'POST',
      url: '/admin/api/brands/9999/image/logo',
      headers: { ...write, 'content-type': 'application/octet-stream' },
      payload: PNG,
    });
    expect(missing.statusCode).toBe(404);
    expect((await readdir(path.join(dir, 'uploads'))).length).toBe(0);
  });

  it('не отдаёт чужие файлы из uploads', async () => {
    await build();
    expect((await app.inject({ url: '/uploads/..%2Fsecret.txt' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/uploads/0123456789abcdef.png' })).statusCode).toBe(404);
  });

  it('«Без бренда» и ручное назначение', async () => {
    await build();
    const b = (
      await app.inject({
        method: 'POST',
        url: '/admin/api/brands',
        headers: write,
        payload: { name: 'Diesel' },
      })
    ).json();
    const un = (await app.inject({ url: '/admin/api/unmatched', headers: auth })).json();
    expect(un.total).toBe(1);
    expect(un.items[0].id).toBe('m2');
    const set = await app.inject({
      method: 'PUT',
      url: '/admin/api/models/m2/brand',
      headers: write,
      payload: { brandId: b.id },
    });
    expect(set.statusCode).toBe(200);
    expect((await app.inject({ url: '/admin/api/unmatched', headers: auth })).json().total).toBe(0);
    const bad = await app.inject({
      method: 'PUT',
      url: '/admin/api/models/m2/brand',
      headers: write,
      payload: { brandId: 'x' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('seed и пересчёт доступны из админки', async () => {
    await build();
    const seed = await app.inject({ method: 'POST', url: '/admin/api/seed', headers: write });
    expect(seed.statusCode).toBe(200);
    expect(seed.json().created.length).toBeGreaterThan(40);
    const stats = (await app.inject({ url: '/admin/api/stats', headers: auth })).json();
    expect(stats).toMatchObject({ models: 2, assigned: 1, unmatched: 1 });
    const rc = await app.inject({ method: 'POST', url: '/admin/api/recompute', headers: write });
    expect(rc.json()).toMatchObject({ models: 2, auto: 1 });
    const men = (await app.inject({ url: '/api/brands?gender=men' })).json();
    expect(men.top).toHaveLength(5);
  });
});
