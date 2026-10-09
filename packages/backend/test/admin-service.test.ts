import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCatalogReader, MemorySiteBrandRepository } from '../src/admin/memory.js';
import { seedBrands } from '../src/admin/seed.js';
import { BrandService } from '../src/admin/service.js';
import type { CatalogModel } from '../src/admin/types.js';

const model = (id: string, name: string, photo: string | null = null): CatalogModel => ({
  id,
  name,
  skus: 3,
  photo,
});

describe('BrandService', () => {
  let catalog: MemoryCatalogReader;
  let service: BrandService;

  beforeEach(() => {
    catalog = new MemoryCatalogReader([
      model('m1', 'Джемпер Diesel красный', 'import_files/a/1.jpg'),
      model('m2', 'Платье Dorothee Shumacher'),
      model('m3', 'Кардиган Annette Gortz'),
      model('m4', 'Футболка без бренда'),
      model('m5', 'Футболка без бренда 2'),
    ]);
    service = new BrandService(new MemorySiteBrandRepository(), catalog);
  });

  it('создаёт бренд, берёт адрес из названия и сразу привязывает модели', async () => {
    const b = await service.createBrand({ name: 'Diesel', placements: { men: { top: true } } });
    expect(b.slug).toBe('diesel');
    expect(b.models).toBe(1);
    expect(b.placements.men).toEqual({ in: true, top: true, sort: 0 });
    expect(b.placements.women.in).toBe(false);
  });

  it('алиасы нормализуются и находят написание из 1С', async () => {
    const b = await service.createBrand({
      name: 'Dorothee Schumacher',
      aliases: ['Shumacher', ' SHUMACHER ', 'x'],
    });
    expect(b.aliases).toEqual(['shumacher']);
    expect(b.models).toBe(1);
  });

  it('отклоняет занятые адрес и написание', async () => {
    await service.createBrand({ name: 'Diesel', aliases: ['dsl'] });
    await expect(service.createBrand({ name: 'Diesel' })).rejects.toMatchObject({ status: 409 });
    await expect(service.createBrand({ name: 'Other', aliases: ['dsl'] })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('проверяет входные данные', async () => {
    await expect(service.createBrand({})).rejects.toThrow('name');
    await expect(service.createBrand({ name: '   ' })).rejects.toThrow('name');
    await expect(service.createBrand({ name: 'Смит', slug: 'Bad Slug' })).rejects.toThrow('Адрес');
    await expect(service.createBrand({ name: 'Смит' })).resolves.toMatchObject({ slug: 'smit' });
    await expect(service.createBrand({ name: '???' })).rejects.toThrow('Адрес');
    await expect(
      service.createBrand({ name: 'X1', placements: { men: { top: 'yes' } } }),
    ).rejects.toThrow('placements.men.top');
  });

  it('ручная привязка переживает пересчёт; снятие возвращает автопоиск', async () => {
    const diesel = await service.createBrand({ name: 'Diesel' });
    const other = await service.createBrand({ name: 'Other' });
    await service.assignModel('m1', other.id); // вручную перекрываем автопоиск
    await service.recompute();
    expect((await service.listBrands()).find((b) => b.id === other.id)?.models).toBe(1);
    expect((await service.listBrands()).find((b) => b.id === diesel.id)?.models).toBe(0);

    await service.assignModel('m1', null);
    expect((await service.listBrands()).find((b) => b.id === diesel.id)?.models).toBe(1);
  });

  it('переименование и новые написания пересчитывают привязки', async () => {
    const b = await service.createBrand({ name: 'Annette Görtz' });
    expect(b.models).toBe(1); // «Annette Gortz» совпала без диакритики
    const upd = await service.updateBrand(b.id, { aliases: ['gortz'] });
    expect(upd.aliases).toEqual(['gortz']);
    expect(upd.models).toBe(1);
  });

  it('удаление бренда освобождает его модели', async () => {
    const b = await service.createBrand({ name: 'Diesel' });
    await service.repo.deleteBrand(b.id);
    const un = await service.unmatched('', 50, 0);
    expect(un.total).toBe(5);
  });

  it('«Без бренда»: поиск, постраничность, подсказки', async () => {
    await service.createBrand({ name: 'Diesel' });
    const all = await service.unmatched('', 2, 0);
    expect(all.total).toBe(4);
    expect(all.items).toHaveLength(2);
    expect(all.candidates.some((c) => c.word === 'футболка')).toBe(true);
    const found = await service.unmatched('БРЕНДА 2', 50, 0);
    expect(found.items.map((m) => m.id)).toEqual(['m5']);
  });

  it('публичный список: топ по порядку, «все» по алфавиту, по разделам', async () => {
    const a = await service.createBrand({ name: 'Zed', placements: { men: { in: true } } });
    const b = await service.createBrand({ name: 'Alpha', placements: { men: { in: true } } });
    const c = await service.createBrand({
      name: 'Women Only',
      placements: { women: { in: true } },
    });
    await service.repo.setTop('men', [a.id, b.id]);
    const men = await service.publicBrands('men');
    expect(men.top.map((t) => t.slug)).toEqual(['zed', 'alpha']);
    expect(men.all.map((t) => t.slug)).toEqual(['alpha', 'zed']);
    const women = await service.publicBrands('women');
    expect(women.all.map((t) => t.slug)).toEqual([c.slug]);
    expect(women.top).toEqual([]);
  });

  it('снятие «в разделе» сбрасывает топ', async () => {
    const a = await service.createBrand({
      name: 'Zed',
      placements: { men: { top: true, sort: 2 } },
    });
    const upd = await service.updateBrand(a.id, { placements: { men: { in: false } } });
    expect(upd.placements.men).toEqual({ in: false, top: false, sort: 0 });
  });

  it('модели бренда и статистика', async () => {
    await service.createBrand({ name: 'Diesel' });
    const res = await service.brandModels('diesel', 10, 0);
    expect(res?.items.map((m) => m.id)).toEqual(['m1']);
    expect(await service.brandModels('nope', 10, 0)).toBeNull();
    expect(await service.stats()).toEqual({
      models: 5,
      withoutPhoto: 4,
      brands: 1,
      assigned: 1,
      unmatched: 4,
    });
  });

  it('seed идемпотентен и не затирает правки', async () => {
    const first = await seedBrands(service);
    expect(first.created.length).toBeGreaterThan(40);
    const brands = await service.listBrands();
    const diesel = brands.find((b) => b.slug === 'diesel')!;
    expect(diesel.placements.men).toMatchObject({ in: true, top: true });
    expect(diesel.models).toBe(1);
    expect(brands.find((b) => b.slug === 'dorothee-schumacher')?.models).toBe(1);

    await service.updateBrand(diesel.id, { name: 'Diesel Black Gold' });
    const second = await seedBrands(service);
    expect(second.created).toEqual([]);
    expect((await service.listBrands()).find((b) => b.id === diesel.id)?.name).toBe(
      'Diesel Black Gold',
    );

    const men = await service.publicBrands('men');
    expect(men.top.map((t) => t.name)).toEqual([
      'Aeronautica Militare',
      'Hannes Roether',
      'Diesel Black Gold',
      'TRANSIT',
      'Bogner',
    ]);
  });
});
