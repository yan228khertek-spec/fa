import type { NewPost, PostPatch, PostRepository, SitePost } from './posts.js';
import { AdminError } from './types.js';

/** Хранилище постов в памяти: dev без БД и тесты (контракт как у PgPostRepository). */
export class MemoryPostRepository implements PostRepository {
  private rows = new Map<number, SitePost>();
  private seq = 0;

  async ready(): Promise<void> {}

  private row(id: number): SitePost {
    const p = this.rows.get(id);
    if (!p) throw new AdminError('Пост не найден', 404);
    return p;
  }

  async list(): Promise<SitePost[]> {
    return [...this.rows.values()]
      .sort((a, b) => a.sort - b.sort || a.id - b.id)
      .map((p) => ({ ...p }));
  }

  async get(id: number): Promise<SitePost | null> {
    const p = this.rows.get(id);
    return p ? { ...p } : null;
  }

  async create(input: NewPost): Promise<SitePost> {
    const now = new Date().toISOString();
    const sort = Math.min(1, ...[...this.rows.values()].map((p) => p.sort)) - 1;
    const p: SitePost = {
      ...input,
      id: ++this.seq,
      image: null,
      sort,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(p.id, p);
    return { ...p };
  }

  async update(id: number, patch: PostPatch): Promise<SitePost> {
    const p = this.row(id);
    Object.assign(p, patch, { updatedAt: new Date().toISOString() });
    return { ...p };
  }

  async delete(id: number): Promise<string[]> {
    const p = this.row(id);
    this.rows.delete(id);
    return p.image ? [p.image] : [];
  }

  async setImage(id: number, file: string | null) {
    const p = this.row(id);
    const old = p.image;
    p.image = file;
    p.updatedAt = new Date().toISOString();
    return old;
  }

  async reorder(ids: number[]): Promise<void> {
    const all = [...this.rows.keys()].sort((a, b) => a - b);
    if (ids.length !== all.length || [...ids].sort((a, b) => a - b).some((v, i) => v !== all[i])) {
      throw new AdminError('ids: нужны все посты ровно по одному разу');
    }
    ids.forEach((id, i) => (this.row(id).sort = i + 1));
  }

  async close(): Promise<void> {}
}
