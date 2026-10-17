import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { compareSizes } from '../src/admin/cards.js';
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

describe('фильтры и сортировка витрины', () => {
  let app: FastifyInstance;
  let dir: string;
  const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();
  const titles = (r: { items: { title: string }[] }) => r.items.map((i) => i.title);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fa-filters-'));
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

  it('без параметров всё как раньше: новинки сверху, фасеты фильтра заполнены', async () => {
    const r = await get('/api/cards');
    expect(r.total).toBe(4);
    expect(titles(r)[0]).toBe('Джемпер Zara без цены'); // опубликован последним
    expect(r.facets.price).toEqual({ min: 3990, max: 9990 });
    expect(r.facets.brands.map((b: { slug: string }) => b.slug).sort()).toEqual(['diesel', 'zara']);
    // 48-й у красного джемпера раскуплен — в фильтре его нет, 48 есть только у джинсов
    expect(r.facets.sizes.map((s: { name: string }) => s.name)).toEqual(['46', '48', 'S']);
    expect(r.facets.colors.map((c: { name: string }) => c.name).sort()).toEqual([
      'красный',
      'синий',
    ]);
  });

  it('сортировка по цене: без цены в конце, при равенстве порядок новинок', async () => {
    expect(titles(await get('/api/cards?sort=priceAsc'))).toEqual([
      'Платье Zara',
      'Джемпер Diesel красный',
      'Джинсы Diesel синие',
      'Джемпер Zara без цены',
    ]);
    expect(titles(await get('/api/cards?sort=priceDesc'))).toEqual([
      'Джинсы Diesel синие',
      'Джемпер Diesel красный',
      'Платье Zara',
      'Джемпер Zara без цены',
    ]);
    expect((await get('/api/cards?sort=мусор')).total).toBe(4);
  });

  it('фильтры: бренд, размер (только в наличии), цвет, цена; вместе — «и», внутри — «или»', async () => {
    expect(titles(await get('/api/cards?brand=diesel&sort=priceAsc'))).toEqual([
      'Джемпер Diesel красный',
      'Джинсы Diesel синие',
    ]);
    expect((await get('/api/cards?brand=diesel,zara')).total).toBe(4);
    expect(titles(await get('/api/cards?size=48'))).toEqual(['Джинсы Diesel синие']);
    expect((await get('/api/cards?size=46,S')).total).toBe(3);
    expect((await get(`/api/cards?color=${encodeURIComponent('синий')}`)).total).toBe(2);
    expect(titles(await get('/api/cards?pmin=4000&pmax=9000'))).toEqual(['Джемпер Diesel красный']);
    expect((await get('/api/cards?pmax=100')).total).toBe(0);
    expect(
      titles(await get(`/api/cards?brand=zara&color=${encodeURIComponent('красный')}`)),
    ).toEqual(['Платье Zara']);
    expect((await get('/api/cards?pmin=abc&pmax=-5')).total).toBe(4); // мусор игнорируется
  });

  it('страница бренда понимает те же фильтры и считает фасеты внутри бренда', async () => {
    const r = await get('/api/brands/diesel/models?sort=priceDesc&size=46');
    expect(titles(r)).toEqual(['Джемпер Diesel красный']);
    expect(r.facets.price).toEqual({ min: 5990, max: 9990 });
    expect(r.facets.brands).toHaveLength(1);
  });

  it('порядок размеров: числа, затем XS…XXL, затем прочее', () => {
    const sorted = ['XL', '48', 'M', 'ONE', '9,5', 'XS', '46'].sort(compareSizes);
    expect(sorted).toEqual(['9,5', '46', '48', 'XS', 'M', 'XL', 'ONE']);
  });
});
