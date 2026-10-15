import type { BannerPatch, BannerRepository, NewBanner, SiteBanner } from './banners.js';
import { AdminError } from './types.js';

/** Хранилище баннеров в памяти: dev без БД и тесты (контракт как у PgBannerRepository). */
export class MemoryBannerRepository implements BannerRepository {
  private rows = new Map<number, SiteBanner>();
  private seq = 0;

  async ready(): Promise<void> {}

  private row(id: number): SiteBanner {
    const b = this.rows.get(id);
    if (!b) throw new AdminError('Баннер не найден', 404);
    return b;
  }

  async list(): Promise<SiteBanner[]> {
    return [...this.rows.values()]
      .sort((a, b) => a.sort - b.sort || a.id - b.id)
      .map((b) => ({ ...b }));
  }

  async get(id: number): Promise<SiteBanner | null> {
    const b = this.rows.get(id);
    return b ? { ...b } : null;
  }

  async create(input: NewBanner): Promise<SiteBanner> {
    const now = new Date().toISOString();
    const sort = Math.max(0, ...[...this.rows.values()].map((b) => b.sort)) + 1;
    const b: SiteBanner = {
      ...input,
      id: ++this.seq,
      image: null,
      imageMobile: null,
      sort,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(b.id, b);
    return { ...b };
  }

  async update(id: number, patch: BannerPatch): Promise<SiteBanner> {
    const b = this.row(id);
    Object.assign(b, patch, { updatedAt: new Date().toISOString() });
    return { ...b };
  }

  async delete(id: number): Promise<string[]> {
    const b = this.row(id);
    this.rows.delete(id);
    return [b.image, b.imageMobile].filter((f): f is string => !!f);
  }

  async setImage(id: number, kind: 'image' | 'imageMobile', file: string | null) {
    const b = this.row(id);
    const old = b[kind];
    b[kind] = file;
    b.updatedAt = new Date().toISOString();
    return old;
  }

  async reorder(ids: number[]): Promise<void> {
    const all = [...this.rows.keys()].sort((a, b) => a - b);
    if (ids.length !== all.length || [...ids].sort((a, b) => a - b).some((v, i) => v !== all[i])) {
      throw new AdminError('ids: нужны все баннеры ровно по одному разу');
    }
    ids.forEach((id, i) => (this.row(id).sort = i + 1));
  }

  async close(): Promise<void> {}
}
