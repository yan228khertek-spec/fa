import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';

const write = {
  authorization: `Basic ${Buffer.from('boss:secret').toString('base64')}`,
  'x-fa-admin': '1',
};
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);

describe('блог на главной', () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fa-posts-'));
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

  const adm = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    type?: string,
  ) =>
    app.inject({
      method,
      url,
      headers: { ...write, ...(type ? { 'content-type': type } : {}) },
      payload: payload as never,
    });
  const pub = async (q = '') => (await app.inject({ url: `/api/posts${q}` })).json();
  const make = async (body: Record<string, unknown>, image = true) => {
    const p = (await adm('POST', '/admin/api/posts', body)).json();
    if (image) await adm('POST', `/admin/api/posts/${p.id}/image`, png, 'application/octet-stream');
    return p as { id: number };
  };

  it('нужна авторизация, на запись — ещё и заголовок X-FA-Admin', async () => {
    expect((await app.inject({ url: '/admin/api/posts' })).statusCode).toBe(401);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/admin/api/posts',
      headers: { authorization: write.authorization },
      payload: {},
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('создание: значения по умолчанию, проверка полей и ссылки', async () => {
    const r = await adm('POST', '/admin/api/posts', {
      title: ' Thom Krom ',
      badge: 'New',
      description: 'монохромный чёрный',
      buttonText: 'Купить',
      link: 'brand.html?slug=thom-krom',
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      title: 'Thom Krom',
      badge: 'New',
      gender: 'all',
      active: true,
      image: null,
      link: 'brand.html?slug=thom-krom',
    });
    for (const bad of [
      { link: 'javascript:alert(1)' },
      { gender: 'kids' },
      { title: 'x'.repeat(121) },
      { badge: 'x'.repeat(21) },
      { description: 'x'.repeat(401) },
      { buttonText: 5 },
    ]) {
      expect((await adm('POST', '/admin/api/posts', bad)).statusCode).toBe(400);
    }
  });

  it('публично видны только включённые посты с картинкой и заголовком', async () => {
    await make({ title: 'С фото' });
    await make({ title: 'Без фото' }, false);
    await make({ title: 'Выключен', active: false });
    await make({ title: '' });
    const r = await pub();
    expect(r.total).toBe(1);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ title: 'С фото' });
    expect(r.items[0].image).toMatch(/^https:\/\/api\.example\.test\/uploads\/[a-f0-9]{16}\.png$/);
    expect(Object.keys(r.items[0]).sort()).toEqual(
      ['badge', 'buttonText', 'description', 'id', 'image', 'link', 'title'].sort(),
    );
  });

  it('аудитория: «все» видно в обоих разделах, остальные — в своём', async () => {
    await make({ title: 'Всем' });
    await make({ title: 'Ей', gender: 'women' });
    await make({ title: 'Ему', gender: 'men' });
    const titles = async (q: string) => (await pub(q)).items.map((p: { title: string }) => p.title);
    expect((await titles('?gender=women')).sort()).toEqual(['Всем', 'Ей']);
    expect((await titles('?gender=men')).sort()).toEqual(['Всем', 'Ему']);
    expect(await titles('')).toHaveLength(3); // без параметра — всё
    expect(await titles('?gender=kids')).toHaveLength(3); // мусор не фильтрует
    expect((await pub('?gender=men')).total).toBe(2);
  });

  it('новые посты сверху, порядок меняется, лента отдаётся порциями', async () => {
    const a = await make({ title: 'A' });
    const b = await make({ title: 'B' });
    const c = await make({ title: 'C' });
    const order = async (q = '') => (await pub(q)).items.map((p: { title: string }) => p.title);
    expect(await order()).toEqual(['C', 'B', 'A']);
    const res = await adm('PUT', '/admin/api/posts-order', { ids: [a.id, c.id, b.id] });
    expect(res.statusCode).toBe(200);
    expect(await order()).toEqual(['A', 'C', 'B']);
    expect(await order('?limit=2')).toEqual(['A', 'C']);
    expect(await order('?limit=2&offset=2')).toEqual(['B']);
    expect((await pub('?limit=2&offset=2')).total).toBe(3);
    expect((await adm('PUT', '/admin/api/posts-order', { ids: [a.id] })).statusCode).toBe(400);
    expect((await adm('PUT', '/admin/api/posts-order', { ids: 'x' })).statusCode).toBe(400);
  });

  it('правка, смена и удаление фото убирают файл с диска', async () => {
    const p = await make({ title: 'Пост' });
    const files = async () => (await readdir(path.join(dir, 'uploads'))).sort();
    const first = await files();
    expect(first).toHaveLength(1);
    const upd = await adm('PUT', `/admin/api/posts/${p.id}`, { title: 'Новый', gender: 'men' });
    expect(upd.json()).toMatchObject({ title: 'Новый', gender: 'men' });
    await adm('POST', `/admin/api/posts/${p.id}/image`, png, 'application/octet-stream');
    const second = await files();
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
    expect((await adm('DELETE', `/admin/api/posts/${p.id}/image`)).json().image).toBeNull();
    expect(await files()).toHaveLength(0);
    await adm('POST', `/admin/api/posts/${p.id}/image`, png, 'application/octet-stream');
    expect((await adm('DELETE', `/admin/api/posts/${p.id}`)).statusCode).toBe(200);
    expect(await files()).toHaveLength(0);
    expect((await adm('GET', '/admin/api/posts')).json()).toEqual([]);
  });

  it('не картинка и несуществующий пост — ошибки', async () => {
    const p = await make({ title: 'Пост' }, false);
    const bad = await adm(
      'POST',
      `/admin/api/posts/${p.id}/image`,
      Buffer.from('hello'),
      'application/octet-stream',
    );
    expect(bad.statusCode).toBe(400);
    expect((await adm('PUT', '/admin/api/posts/999', { title: 'x' })).statusCode).toBe(404);
    expect((await adm('DELETE', '/admin/api/posts/999')).statusCode).toBe(404);
    expect(
      (await adm('POST', '/admin/api/posts/999/image', png, 'application/octet-stream')).statusCode,
    ).toBe(404);
    expect((await adm('PUT', '/admin/api/posts/abc', {})).statusCode).toBe(400);
  });
});
