import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryCatalogReader } from '../src/admin/memory.js';
import type { AppConfig } from '../src/config.js';
import type { LiveModel } from '../src/admin/types.js';

const write = {
  authorization: `Basic ${Buffer.from('boss:secret').toString('base64')}`,
  'x-fa-admin': '1',
};
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);

describe('раздел сайта: женское и мужское', () => {
  let app: FastifyInstance;
  let dir: string;
  const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();
  const titles = (r: { items: { title: string }[] }) => r.items.map((i) => i.title);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fa-audience-'));
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
    const v = (id: string, size: string, color: string, quantity: number) => ({
      id,
      size,
      color,
      quantity,
    });
    const live = new Map<string, LiveModel>([
      [
        'm1',
        {
          price: 5990,
          stock: 3,
          variants: [v('a', '46', 'красный', 3), v('b', '48', 'красный', 0)],
        },
      ],
      ['m2', { price: 9990, stock: 2, variants: [v('c', '48', 'синий', 2)] }],
      ['m3', { price: 3990, stock: 1, variants: [v('d', 'S', 'красный', 1)] }],
      ['m4', { price: null, stock: 1, variants: [v('e', '46', 'синий', 1)] }],
    ]);
    const models = [
      { id: 'm1', name: 'Джемпер Diesel красный', skus: 2, photo: null, article: 'D-1' },
      { id: 'm2', name: 'Джинсы Diesel синие', skus: 1, photo: null, article: 'D-2' },
      { id: 'm3', name: 'Платье Zara', skus: 1, photo: null, article: 'Z-1' },
      { id: 'm4', name: 'Джемпер Zara без цены', skus: 1, photo: null, article: 'Z-2' },
    ];
    app = await buildApp({ config, catalogReader: new MemoryCatalogReader(models, live) });
    const send = (method: 'POST' | 'PUT', url: string, payload: unknown, type?: string) =>
      app.inject({
        method,
        url,
        headers: { ...write, ...(type ? { 'content-type': type } : {}) },
        payload: payload as never,
      });
    await send('POST', '/admin/api/brands', { name: 'Diesel' });
    await send('POST', '/admin/api/brands', { name: 'Zara' });
    for (const m of models) {
      const c = (await send('POST', '/admin/api/cards', { modelId: m.id })).json();
      await send('POST', `/admin/api/cards/${c.id}/photos`, png, 'application/octet-stream');
      await send('PUT', `/admin/api/cards/${c.id}`, { status: 'published', title: m.name });
    }
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const send = (method: 'POST' | 'PUT', url: string, payload: unknown) =>
    app.inject({ method, url, headers: write, payload: payload as never });
  const cardId = async (title: string) => {
    const l = (await app.inject({ url: '/admin/api/cards', headers: write })).json();
    return l.items.find((c: { title: string | null }) => c.title === title).id as number;
  };

  it('карточки: по умолчанию «для всех», разделы фильтруют каталог, бренд и главную', async () => {
    expect((await get('/api/cards?gender=men')).total).toBe(4);
    await send('PUT', `/admin/api/cards/${await cardId('Платье Zara')}`, { gender: 'women' });
    await send('PUT', `/admin/api/cards/${await cardId('Джинсы Diesel синие')}`, { gender: 'men' });
    expect(titles(await get('/api/cards?gender=women')).sort()).toEqual([
      'Джемпер Diesel красный',
      'Джемпер Zara без цены',
      'Платье Zara',
    ]);
    expect(titles(await get('/api/cards?gender=men')).sort()).toEqual([
      'Джемпер Diesel красный',
      'Джемпер Zara без цены',
      'Джинсы Diesel синие',
    ]);
    expect((await get('/api/cards')).total).toBe(4); // без параметра — всё, как раньше
    expect((await get('/api/cards?gender=kids')).total).toBe(4); // мусор не фильтрует
    expect(titles(await get('/api/brands/diesel/models?gender=women'))).toEqual([
      'Джемпер Diesel красный',
    ]);
    // фасеты считаются внутри раздела сайта
    expect((await get('/api/cards?gender=men')).facets.price).toEqual({ min: 5990, max: 9990 });
    // публичная карточка отдаёт поле
    const one = (await get(`/api/cards/${await cardId('Платье Zara')}`)) as { gender: string };
    expect(one.gender).toBe('women');
    expect(
      (await send('PUT', `/admin/api/cards/${await cardId('Платье Zara')}`, { gender: 'kids' }))
        .statusCode,
    ).toBe(400);
  });

  it('главная: блоки брендов собираются из карточек выбранного раздела', async () => {
    const diesel = (await app.inject({ url: '/admin/api/brands', headers: write }))
      .json()
      .find((b: { slug: string }) => b.slug === 'diesel');
    await send('PUT', `/admin/api/brands/${diesel.id}`, { home: true });
    await send('PUT', `/admin/api/cards/${await cardId('Джинсы Diesel синие')}`, { gender: 'men' });
    await send('PUT', `/admin/api/cards/${await cardId('Джемпер Diesel красный')}`, {
      gender: 'women',
    });
    const sections = async (g: string) =>
      (await get(`/api/home?gender=${g}`)).brands.map(
        (b: { slug: string; items: { title: string }[] }) => [b.slug, b.items.map((i) => i.title)],
      );
    expect(await sections('women')).toEqual([['diesel', ['Джемпер Diesel красный']]]);
    expect(await sections('men')).toEqual([['diesel', ['Джинсы Diesel синие']]]);
    expect((await get('/api/home')).brands[0].items).toHaveLength(2);
  });

  it('баннеры: «для кого» у каждого, в каждом разделе — свои и общие', async () => {
    const mk = async (title: string, gender?: string) => {
      const b = (
        await send('POST', '/admin/api/banners', { title, ...(gender ? { gender } : {}) })
      ).json();
      await app.inject({
        method: 'POST',
        url: `/admin/api/banners/${b.id}/image/desktop`,
        headers: { ...write, 'content-type': 'application/octet-stream' },
        payload: png,
      });
      return b;
    };
    const all = await mk('Общий');
    expect(all.gender).toBe('all');
    await mk('Женский', 'women');
    await mk('Мужской', 'men');
    const names = async (g?: string) =>
      (await get(`/api/banners${g ? `?gender=${g}` : ''}`)).items.map(
        (i: { title: string }) => i.title,
      );
    expect(await names('women')).toEqual(['Общий', 'Женский']);
    expect(await names('men')).toEqual(['Общий', 'Мужской']);
    expect(await names()).toEqual(['Общий', 'Женский', 'Мужской']);
    // раздел можно сменить правкой; мусор отклоняется
    expect(
      (await send('PUT', `/admin/api/banners/${all.id}`, { gender: 'men' })).json().gender,
    ).toBe('men');
    expect(await names('women')).toEqual(['Женский']);
    expect((await send('PUT', `/admin/api/banners/${all.id}`, { gender: 'x' })).statusCode).toBe(
      400,
    );
    expect((await send('POST', '/admin/api/banners', { gender: 'x' })).statusCode).toBe(400);
  });

  it('распродажа: ?sale=1 отдаёт только карточки с галочкой, в том числе внутри раздела и бренда', async () => {
    expect((await get('/api/cards?sale=1')).total).toBe(0);
    await send('PUT', `/admin/api/cards/${await cardId('Платье Zara')}`, {
      sale: true,
      gender: 'women',
    });
    await send('PUT', `/admin/api/cards/${await cardId('Джинсы Diesel синие')}`, {
      sale: true,
      gender: 'men',
    });
    expect(titles(await get('/api/cards?sale=1')).sort()).toEqual([
      'Джинсы Diesel синие',
      'Платье Zara',
    ]);
    expect(titles(await get('/api/cards?sale=1&gender=women'))).toEqual(['Платье Zara']);
    expect(titles(await get('/api/brands/diesel/models?sale=1'))).toEqual(['Джинсы Diesel синие']);
    expect((await get('/api/cards?sale=1')).facets.price).toEqual({ min: 3990, max: 9990 });
    // без параметра выдача прежняя, метка есть в элементах
    const all = await get('/api/cards');
    expect(all.total).toBe(4);
    expect(all.items.filter((i: { sale: boolean }) => i.sale)).toHaveLength(2);
    expect((await get('/api/cards?sale=0')).total).toBe(4);
    expect(
      (await send('PUT', `/admin/api/cards/${await cardId('Платье Zara')}`, { sale: 'yes' }))
        .statusCode,
    ).toBe(400);
  });

  it('старая цена: показывается только если задана и больше текущей', async () => {
    const dress = await cardId('Платье Zara'); // текущая цена 3990
    const noPrice = await cardId('Джемпер Zara без цены');
    const old = async (id: number) =>
      (await get(`/api/cards/${id}`)) as { oldPrice: number | null };
    expect((await old(dress)).oldPrice).toBeNull();
    await send('PUT', `/admin/api/cards/${dress}`, { oldPrice: 5990 });
    expect((await old(dress)).oldPrice).toBe(5990);
    const item = (await get('/api/cards')).items.find((i: { id: number }) => i.id === dress);
    expect(item.oldPrice).toBe(5990);
    // не больше текущей — скрыта, но в админке значение хранится
    await send('PUT', `/admin/api/cards/${dress}`, { oldPrice: 3990 });
    expect((await old(dress)).oldPrice).toBeNull();
    const adm = (await app.inject({ url: `/admin/api/cards/${dress}`, headers: write })).json();
    expect(adm.oldPrice).toBe(3990);
    // строка с пробелами и запятой, округление до копеек
    await send('PUT', `/admin/api/cards/${dress}`, { oldPrice: ' 5 990,555 ' });
    expect((await old(dress)).oldPrice).toBe(5990.56);
    // пусто снимает
    await send('PUT', `/admin/api/cards/${dress}`, { oldPrice: '' });
    expect((await old(dress)).oldPrice).toBeNull();
    expect(
      (await app.inject({ url: `/admin/api/cards/${dress}`, headers: write })).json().oldPrice,
    ).toBeNull();
    // цены у товара нет — старую не показываем
    await send('PUT', `/admin/api/cards/${noPrice}`, { oldPrice: 9999 });
    expect((await old(noPrice)).oldPrice).toBeNull();
    for (const bad of ['abc', -5, 0, 1e9, true]) {
      expect((await send('PUT', `/admin/api/cards/${dress}`, { oldPrice: bad })).statusCode).toBe(
        400,
      );
    }
  });
});
