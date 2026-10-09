import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryCatalogReader } from '../src/admin/memory.js';
import type { AppConfig } from '../src/config.js';
import type { LiveModel } from '../src/admin/types.js';

const auth = { authorization: `Basic ${Buffer.from('boss:secret').toString('base64')}` };
const write = { ...auth, 'x-fa-admin': '1' };
const png = (n: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, n),
  ]);

describe('карточки товаров (HTTP)', () => {
  let app: FastifyInstance;
  let dir: string;
  let catalog: MemoryCatalogReader;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fa-cards-'));
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
    const live = new Map<string, LiveModel>([
      [
        'm1',
        {
          price: 5990,
          stock: 3,
          variants: [
            { id: 'm1#a', size: '46', color: 'красный', quantity: 3 },
            { id: 'm1#b', size: '48', color: 'красный', quantity: 0 },
          ],
        },
      ],
    ]);
    catalog = new MemoryCatalogReader(
      [
        { id: 'm1', name: 'Джемпер Diesel красный', skus: 2, photo: null, article: 'D-100' },
        { id: 'm2', name: 'Платье Zara', skus: 1, photo: null, article: 'Z-7' },
      ],
      live,
    );
    app = await buildApp({ config, catalogReader: catalog });
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (url: string, payload?: unknown, extra: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, headers: { ...write, ...extra }, payload: payload as never });
  const put = (url: string, payload: unknown) =>
    app.inject({ method: 'PUT', url, headers: write, payload: payload as never });
  const upload = (cardId: number, body: Buffer) =>
    post(`/admin/api/cards/${cardId}/photos`, body, { 'content-type': 'application/octet-stream' });

  it('закрыто без авторизации и без CSRF-заголовка', async () => {
    expect((await app.inject({ url: '/admin/api/cards' })).statusCode).toBe(401);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/api/cards',
      headers: auth,
      payload: { modelId: 'm1' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('автокомплит по названию и артикулу, показывает уже созданную карточку', async () => {
    const byName = await app.inject({ url: '/admin/api/cards/search?q=джемпер', headers: auth });
    expect(byName.json().map((m: { id: string }) => m.id)).toEqual(['m1']);
    const byArticle = await app.inject({ url: '/admin/api/cards/search?q=z-7', headers: auth });
    expect(byArticle.json()[0]).toMatchObject({ id: 'm2', article: 'Z-7', cardId: null });
    const card = (await post('/admin/api/cards', { modelId: 'm2' })).json();
    const again = await app.inject({ url: '/admin/api/cards/search?q=zara', headers: auth });
    expect(again.json()[0].cardId).toBe(card.id);
  });

  it('создание: нет такой модели → 404, дубль → 409, черновик по умолчанию', async () => {
    expect((await post('/admin/api/cards', { modelId: 'nope' })).statusCode).toBe(404);
    const res = await post('/admin/api/cards', { modelId: 'm1' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      modelId: 'm1',
      status: 'draft',
      visible: false,
      hiddenReason: 'draft',
      model: { article: 'D-100', price: 5990, stock: 3 },
    });
    expect((await post('/admin/api/cards', { modelId: 'm1' })).statusCode).toBe(409);
  });

  it('публикация требует фото; потом карточка видна на витрине с ценой и размерами из 1С', async () => {
    const card = (await post('/admin/api/cards', { modelId: 'm1' })).json();
    const url = `/admin/api/cards/${card.id}`;

    const early = await put(url, { status: 'published' });
    expect(early.statusCode).toBe(409);
    expect((await app.inject({ url: '/api/cards' })).json()).toEqual({ total: 0, items: [] });

    const first = (await upload(card.id, png(1))).json();
    const second = (await upload(card.id, png(2))).json();
    expect(second.photos).toHaveLength(2);
    const [p1, p2] = second.photos as { id: number; url: string }[];
    expect(first.photos[0].url).toBe(p1!.url);

    const saved = await put(url, {
      title: 'Джемпер Diesel',
      description: 'Мягкий джемпер',
      characteristics: [{ name: 'Состав', value: 'шерсть' }],
      status: 'published',
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ status: 'published', visible: true });

    const list = await app.inject({ url: '/api/cards' });
    expect(list.headers['access-control-allow-origin']).toBe('*');
    expect(list.json()).toMatchObject({
      total: 1,
      items: [{ id: card.id, title: 'Джемпер Diesel', photo: p1!.url, price: 5990, inStock: true }],
    });

    const detail = (await app.inject({ url: `/api/cards/${card.id}` })).json();
    expect(detail).toMatchObject({
      article: 'D-100',
      description: 'Мягкий джемпер',
      characteristics: [{ name: 'Состав', value: 'шерсть' }],
      photos: [p1!.url, p2!.url],
      sizes: [
        { size: '46', color: 'красный', inStock: true },
        { size: '48', color: 'красный', inStock: false },
      ],
    });

    // главное фото — первое по порядку
    const reordered = await put(`${url}/photos/order`, { ids: [p2!.id, p1!.id] });
    expect(reordered.json().photos.map((p: { id: number }) => p.id)).toEqual([p2!.id, p1!.id]);
    expect((await app.inject({ url: `/api/cards/${card.id}` })).json().photos[0]).toBe(p2!.url);
    expect((await put(`${url}/photos/order`, { ids: [p2!.id] })).statusCode).toBe(400);
  });

  it('скрывается правилом: нет остатка, товар исчез из 1С; возвращается сам', async () => {
    const card = (await post('/admin/api/cards', { modelId: 'm1' })).json();
    await upload(card.id, png(1));
    await put(`/admin/api/cards/${card.id}`, { status: 'published' });
    const visible = async () => (await app.inject({ url: `/api/cards/${card.id}` })).statusCode;
    expect(await visible()).toBe(200);

    catalog.live.get('m1')!.stock = 0;
    expect(await visible()).toBe(404);
    expect((await app.inject({ url: '/api/cards' })).json().total).toBe(0);
    const adminView = (
      await app.inject({ url: `/admin/api/cards/${card.id}`, headers: auth })
    ).json();
    expect(adminView).toMatchObject({
      status: 'published',
      visible: false,
      hiddenReason: 'no-stock',
    });
    const hidden = await app.inject({ url: '/admin/api/cards?status=hidden', headers: auth });
    expect(hidden.json().total).toBe(1);

    catalog.live.get('m1')!.stock = 2;
    expect(await visible()).toBe(200);

    const saved = catalog.models;
    catalog.models = [];
    expect(await visible()).toBe(404);
    expect(
      (await app.inject({ url: `/admin/api/cards/${card.id}`, headers: auth })).json().hiddenReason,
    ).toBe('gone');
    catalog.models = saved;
    expect(await visible()).toBe(200);
  });

  it('без данных об остатках карточка не скрывается', async () => {
    const card = (await post('/admin/api/cards', { modelId: 'm2' })).json();
    await upload(card.id, png(1));
    await put(`/admin/api/cards/${card.id}`, { status: 'published' });
    const res = (await app.inject({ url: `/api/cards/${card.id}` })).json();
    expect(res).toMatchObject({ price: null, inStock: null });
  });

  it('бренд определяется по каталогу; витрина бренда отдаёт только опубликованное', async () => {
    await post('/admin/api/brands', { name: 'Diesel' });
    const a = (await post('/admin/api/cards', { modelId: 'm1' })).json();
    expect(a.model.brand).toEqual({ name: 'Diesel', slug: 'diesel' });
    expect((await app.inject({ url: '/api/brands/diesel/models' })).json().total).toBe(0);
    await upload(a.id, png(1));
    await put(`/admin/api/cards/${a.id}`, { status: 'published' });
    const models = (await app.inject({ url: '/api/brands/diesel/models' })).json();
    expect(models).toMatchObject({ brand: { slug: 'diesel' }, total: 1, items: [{ id: a.id }] });
  });

  it('загрузка фото: только картинки по сигнатуре, лимит, удаление чистит файлы', async () => {
    const card = (await post('/admin/api/cards', { modelId: 'm1' })).json();
    const bad = await upload(card.id, Buffer.from('<svg onload=alert(1)>'));
    expect(bad.statusCode).toBe(400);
    expect((await upload(9999, png(1))).statusCode).toBe(404);
    const uploads = path.join(dir, 'uploads');
    expect(await readdir(uploads)).toEqual([]); // сирота после 404 не остался

    for (let i = 0; i < 12; i++) expect((await upload(card.id, png(i))).statusCode).toBe(200);
    expect((await upload(card.id, png(99))).statusCode).toBe(409);
    expect(await readdir(uploads)).toHaveLength(12);

    const view = (await app.inject({ url: `/admin/api/cards/${card.id}`, headers: auth })).json();
    const del = await app.inject({
      method: 'DELETE',
      url: `/admin/api/cards/${card.id}/photos/${view.photos[0].id}`,
      headers: write,
    });
    expect(del.json().photos).toHaveLength(11);
    expect(await readdir(uploads)).toHaveLength(11);

    await app.inject({ method: 'DELETE', url: `/admin/api/cards/${card.id}`, headers: write });
    expect(await readdir(uploads)).toEqual([]);
    expect(
      (await app.inject({ url: `/admin/api/cards/${card.id}`, headers: auth })).statusCode,
    ).toBe(404);
  });

  it('«Взять фото из 1С»: копирует, не дублирует, не выходит за каталог выгрузки', async () => {
    const unpacked = path.join(dir, 'spool', 'unpacked', 'import_files', 'ab');
    await mkdir(unpacked, { recursive: true });
    await writeFile(path.join(unpacked, 'a.jpg'), png(1));
    await writeFile(path.join(unpacked, 'b.jpg'), png(2));
    await writeFile(path.join(unpacked, 'text.jpg'), 'не картинка');
    await writeFile(path.join(dir, 'secret.png'), png(9));
    catalog.images.set('m1', [
      'import_files/ab/a.jpg',
      'import_files/ab/b.jpg',
      'import_files/ab/text.jpg',
      'import_files/ab/missing.jpg',
      '../../secret.png',
    ]);
    const card = (await post('/admin/api/cards', { modelId: 'm1' })).json();
    const url = `/admin/api/cards/${card.id}/photos/from-1c`;

    const first = await post(url);
    expect(first.statusCode).toBe(200);
    expect(first.json().import).toEqual({ found: 5, added: 2, skipped: 2 });
    expect(first.json().photos).toHaveLength(2);

    const again = await post(url); // повтор ничего не добавляет
    expect(again.json().import).toMatchObject({ added: 0 });
    expect(again.json().photos).toHaveLength(2);

    const none = (await post('/admin/api/cards', { modelId: 'm2' })).json();
    const empty = await post(`/admin/api/cards/${none.id}/photos/from-1c`);
    expect(empty.json().import).toEqual({ found: 0, added: 0, skipped: 0 });
    expect((await post('/admin/api/cards/999/photos/from-1c')).statusCode).toBe(404);
  });

  it('валидация полей', async () => {
    const card = (await post('/admin/api/cards', { modelId: 'm1' })).json();
    const url = `/admin/api/cards/${card.id}`;
    expect((await put(url, { status: 'live' })).statusCode).toBe(400);
    expect((await put(url, { title: 'x'.repeat(201) })).statusCode).toBe(400);
    expect((await put(url, { characteristics: 'нет' })).statusCode).toBe(400);
    expect((await put(url, { description: 5 })).statusCode).toBe(400);
    expect((await app.inject({ url: '/admin/api/cards/abc', headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/cards/abc' })).statusCode).toBe(404);
  });
});
