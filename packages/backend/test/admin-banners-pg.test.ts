import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgBannerRepository } from '../src/admin/banners-pg.js';
import { BannerService } from '../src/admin/banners.js';

/** Баннеры против живого PostgreSQL: TEST_DATABASE_URL=postgresql://… npm test -w @fa/backend */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('баннеры в PostgreSQL', () => {
  let pool: pg.Pool;
  let repo: PgBannerRepository;
  let svc: BannerService;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    repo = new PgBannerRepository(url!);
    svc = new BannerService(repo);
    await repo.ready();
  });
  afterAll(async () => {
    await repo.close();
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE site_banners RESTART IDENTITY');
  });

  it('создание, правка, точки фокуса', async () => {
    const b = await svc.create({ title: 'Осень', link: 'catalog.html', mobileFocusX: 30 });
    expect(b).toMatchObject({
      title: 'Осень',
      focusX: 50,
      mobileFocusX: 30,
      active: true,
      sort: 1,
    });
    const u = await svc.update(b.id, { mobileFocusY: 15.6, active: false });
    expect(u).toMatchObject({ mobileFocusY: 16, active: false, mobileFocusX: 30 });
    await expect(svc.update(999, { title: 'x' })).rejects.toThrow('Баннер не найден');
  });

  it('место баннера: по умолчанию hero, перед карточками — perfume, мусор БД не пускает', async () => {
    const h = await svc.create({});
    const p = await svc.create({ placement: 'perfume' });
    expect(h.placement).toBe('hero');
    expect(p.placement).toBe('perfume');
    expect((await svc.publicList('perfume')).length).toBe(0); // без картинки не публикуется
    await repo.setFile(p.id, 'image', 'a.png');
    expect((await svc.publicList('perfume')).map((b) => b.id)).toEqual([p.id]);
    expect(await svc.publicList()).toEqual([]);
    const q = await svc.create({ placement: 'promo' });
    expect(q.placement).toBe('promo');
    await expect(
      pool.query("UPDATE site_banners SET placement = 'footer' WHERE id = $1", [h.id]),
    ).rejects.toThrow();
  });

  it('«для кого»: по умолчанию all, фильтр публичной выдачи по разделу, мусор БД не пускает', async () => {
    const a = await svc.create({});
    const w = await svc.create({ gender: 'women' });
    const m = await svc.create({ gender: 'men' });
    expect([a.gender, w.gender, m.gender]).toEqual(['all', 'women', 'men']);
    for (const b of [a, w, m]) await repo.setFile(b.id, 'image', `${b.id}.png`);
    expect((await svc.publicList('hero', 'women')).map((b) => b.id)).toEqual([a.id, w.id]);
    expect((await svc.publicList('hero', 'men')).map((b) => b.id)).toEqual([a.id, m.id]);
    expect(await svc.publicList('hero')).toHaveLength(3);
    expect((await svc.update(a.id, { gender: 'men' })).gender).toBe('men');
    await expect(
      pool.query("UPDATE site_banners SET gender = 'kids' WHERE id = $1", [a.id]),
    ).rejects.toThrow();
  });

  it('БД не пускает фокус вне 0–100', async () => {
    const b = await svc.create({});
    await expect(
      pool.query('UPDATE site_banners SET focus_x = 101 WHERE id = $1', [b.id]),
    ).rejects.toThrow();
  });

  it('картинки: замена возвращает прежнее имя, удаление — оба файла', async () => {
    const b = await svc.create({});
    expect(await repo.setFile(b.id, 'image', 'a.png')).toBeNull();
    expect(await repo.setFile(b.id, 'image', 'b.png')).toBe('a.png');
    await repo.setFile(b.id, 'imageMobile', 'm.png');
    expect(await svc.publicList()).toHaveLength(1);
    expect(await repo.delete(b.id)).toEqual(['b.png', 'm.png']);
    await expect(repo.delete(b.id)).rejects.toThrow('Баннер не найден');
    await expect(repo.setFile(b.id, 'image', 'c.png')).rejects.toThrow('Баннер не найден');
  });

  it('порядок: все баннеры ровно по разу', async () => {
    const a = await svc.create({ title: 'A' });
    const b = await svc.create({ title: 'B' });
    await repo.reorder([b.id, a.id]);
    expect((await repo.list()).map((x) => x.title)).toEqual(['B', 'A']);
    await expect(repo.reorder([a.id])).rejects.toThrow('ровно по одному');
    expect((await repo.list()).map((x) => x.title)).toEqual(['B', 'A']);
  });
});
