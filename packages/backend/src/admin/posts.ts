import { link, text } from './banners.js';
import { AdminError, parseAudience, type Audience } from './types.js';

export interface SitePost {
  id: number;
  /** Раздел сайта: all — в женском и в мужском. */
  gender: Audience;
  title: string;
  /** Необязательная метка рядом с заголовком, например «New». */
  badge: string;
  description: string;
  buttonText: string;
  link: string;
  /** Имя файла в uploads. */
  image: string | null;
  active: boolean;
  /** Порядок ленты: меньше — выше. */
  sort: number;
  createdAt: string;
  updatedAt: string;
}

export type NewPost = Omit<SitePost, 'id' | 'image' | 'sort' | 'createdAt' | 'updatedAt'>;
export type PostPatch = Partial<NewPost>;

export interface PostRepository {
  ready(): Promise<void>;
  list(): Promise<SitePost[]>;
  get(id: number): Promise<SitePost | null>;
  /** Новый пост встаёт в начало ленты. */
  create(input: NewPost): Promise<SitePost>;
  update(id: number, patch: PostPatch): Promise<SitePost>;
  /** Удаляет пост и возвращает его файл, чтобы убрать с диска. */
  delete(id: number): Promise<string[]>;
  /** Подменяет картинку и возвращает прежнее имя (null — не было). */
  setImage(id: number, file: string | null): Promise<string | null>;
  /** ids — ровно все посты, в нужном порядке. */
  reorder(ids: number[]): Promise<void>;
  close(): Promise<void>;
}

const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export const MAX_PUBLIC_POSTS = 50;

export class PostService {
  constructor(readonly repo: PostRepository) {}

  list = () => this.repo.list();

  create(body: Record<string, unknown>): Promise<SitePost> {
    return this.repo.create({
      gender: body.gender === undefined ? 'all' : parseAudience(body.gender),
      title: text(body.title, 'title', 120),
      badge: text(body.badge, 'badge', 20),
      description: text(body.description, 'description', 400),
      buttonText: text(body.buttonText, 'buttonText', 40),
      link: link(body.link),
      active: body.active === undefined ? true : body.active === true,
    });
  }

  update(id: number, body: Record<string, unknown>): Promise<SitePost> {
    const p: PostPatch = {};
    if (has(body, 'gender')) p.gender = parseAudience(body.gender);
    if (has(body, 'title')) p.title = text(body.title, 'title', 120);
    if (has(body, 'badge')) p.badge = text(body.badge, 'badge', 20);
    if (has(body, 'description')) p.description = text(body.description, 'description', 400);
    if (has(body, 'buttonText')) p.buttonText = text(body.buttonText, 'buttonText', 40);
    if (has(body, 'link')) p.link = link(body.link);
    if (has(body, 'active')) p.active = body.active === true;
    return this.repo.update(id, p);
  }

  /**
   * Публичная лента: включённые посты с картинкой и заголовком, по порядку.
   * gender — раздел сайта; без него отдаём всё. Пост «all» виден в обоих разделах.
   */
  async publicList(opts: { gender?: 'women' | 'men'; limit?: number; offset?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 12, 1), MAX_PUBLIC_POSTS);
    const offset = Math.max(opts.offset ?? 0, 0);
    const all = (await this.repo.list()).filter(
      (p) =>
        p.active &&
        p.image &&
        p.title &&
        (!opts.gender || p.gender === 'all' || p.gender === opts.gender),
    );
    return { total: all.length, items: all.slice(offset, offset + limit) };
  }
}

export { AdminError };
