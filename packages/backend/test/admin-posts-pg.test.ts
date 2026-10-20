import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgPostRepository } from '../src/admin/posts-pg.js';
import { PostService } from '../src/admin/posts.js';

/** Посты блога против живого PostgreSQL: TEST_DATABASE_URL=postgresql://… npm test -w @fa/backend */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('блог в PostgreSQL', () => {
  let pool: pg.Pool;
  let repo: PgPostRepository;
  let svc: PostService;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    repo = new PgPostRepository(url!);
    svc = new PostService(repo);
    await repo.ready();
  });
  afterAll(async () => {
    await repo.close();
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE site_posts RESTART IDENTITY');
  });

  it('создание, правка, ошибки', async () => {
    const p = await svc.create({ title: 'Thom Krom', badge: 'New', link: 'brands.html' });
    expect(p).toMatchObject({
      title: 'Thom Krom',
      badge: 'New',
      gender: 'all',
      active: true,
      image: null,
    });
    const u = await svc.update(p.id, { gender: 'men', active: false, description: 'худи' });
    expect(u).toMatchObject({
      gender: 'men',
      active: false,
      description: 'худи',
      title: 'Thom Krom',
    });
    await expect(svc.update(999, { title: 'x' })).rejects.toThrow('Пост не найден');
    await expect(repo.delete(999)).rejects.toThrow('Пост не найден');
  });

  it('новый пост сверху, порядок меняется, повторный старт идемпотентен', async () => {
    const a = await svc.create({ title: 'A' });
    const b = await svc.create({ title: 'B' });
    const c = await svc.create({ title: 'C' });
    expect((await svc.list()).map((p) => p.title)).toEqual(['C', 'B', 'A']);
    await repo.reorder([a.id, b.id, c.id]);
    expect((await svc.list()).map((p) => p.title)).toEqual(['A', 'B', 'C']);
    await expect(repo.reorder([a.id])).rejects.toThrow('нужны все посты');
    const d = await svc.create({ title: 'D' });
    expect((await svc.list())[0]!.id).toBe(d.id);
    await new PgPostRepository(url!).ready();
  });

  it('картинка: подмена возвращает прежнее имя, удаление поста отдаёт файл', async () => {
    const p = await svc.create({ title: 'P' });
    expect(await repo.setImage(p.id, 'aaaaaaaaaaaaaaaa.jpg')).toBeNull();
    expect(await repo.setImage(p.id, 'bbbbbbbbbbbbbbbb.jpg')).toBe('aaaaaaaaaaaaaaaa.jpg');
    expect(await repo.delete(p.id)).toEqual(['bbbbbbbbbbbbbbbb.jpg']);
    await expect(repo.setImage(p.id, 'x')).rejects.toThrow('Пост не найден');
  });

  it('публичная лента: фильтр по разделу и порции', async () => {
    for (const [title, gender] of [
      ['A', 'all'],
      ['B', 'women'],
      ['C', 'men'],
    ] as const) {
      const p = await svc.create({ title, gender });
      await repo.setImage(p.id, 'cccccccccccccccc.jpg');
    }
    const r = await svc.publicList({ gender: 'women' });
    expect(r.items.map((p) => p.title)).toEqual(['B', 'A']);
    expect(r.total).toBe(2);
    expect((await svc.publicList({ limit: 1, offset: 1 })).items.map((p) => p.title)).toEqual([
      'B',
    ]);
  });
});
