import { AdminError } from './types.js';

export const BANNER_THEMES = ['light', 'dark'] as const;
export type BannerTheme = (typeof BANNER_THEMES)[number];
/** Не больше баннеров: слайдер на главной не должен превращаться в ленту. */
export const MAX_BANNERS = 12;

export interface SiteBanner {
  id: number;
  title: string;
  subtitle: string;
  buttonText: string;
  link: string;
  theme: BannerTheme;
  /** Имена файлов в uploads. */
  image: string | null;
  imageMobile: string | null;
  /** Точка фокуса 0–100 % — какая часть картинки остаётся в кадре при обрезке. */
  focusX: number;
  focusY: number;
  mobileFocusX: number;
  mobileFocusY: number;
  active: boolean;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

export type NewBanner = Omit<
  SiteBanner,
  'id' | 'image' | 'imageMobile' | 'sort' | 'createdAt' | 'updatedAt'
>;
export type BannerPatch = Partial<NewBanner>;

export interface BannerRepository {
  ready(): Promise<void>;
  list(): Promise<SiteBanner[]>;
  get(id: number): Promise<SiteBanner | null>;
  create(input: NewBanner): Promise<SiteBanner>;
  update(id: number, patch: BannerPatch): Promise<SiteBanner>;
  /** Удаляет баннер и возвращает его файлы, чтобы убрать их с диска. */
  delete(id: number): Promise<string[]>;
  /** Подменяет картинку и возвращает прежнее имя файла (null — не было). */
  setImage(id: number, kind: 'image' | 'imageMobile', file: string | null): Promise<string | null>;
  /** ids — ровно все баннеры, в нужном порядке. */
  reorder(ids: number[]): Promise<void>;
  close(): Promise<void>;
}

function text(v: unknown, field: string, max: number): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new AdminError(`${field}: ожидается строка`);
  const s = v.trim();
  if (s.length > max) throw new AdminError(`${field}: не длиннее ${max} символов`);
  return s;
}

function pct(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new AdminError(`${field}: число 0–100`);
  return Math.min(100, Math.max(0, Math.round(v)));
}

/** Ссылка: путь внутри сайта или http(s); javascript: и прочее не принимаем. */
function link(v: unknown): string {
  const s = text(v, 'link', 300);
  if (s && !/^(https?:\/\/|\/|[\w.-]+\.html\b|#)/i.test(s)) {
    throw new AdminError('link: адрес страницы сайта или http(s)-ссылка');
  }
  return s;
}

const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export class BannerService {
  constructor(readonly repo: BannerRepository) {}

  list = () => this.repo.list();

  async create(body: Record<string, unknown>): Promise<SiteBanner> {
    if ((await this.repo.list()).length >= MAX_BANNERS) {
      throw new AdminError(`Не больше ${MAX_BANNERS} баннеров`, 409);
    }
    return this.repo.create({
      title: text(body.title, 'title', 120),
      subtitle: text(body.subtitle, 'subtitle', 240),
      buttonText: text(body.buttonText, 'buttonText', 40),
      link: link(body.link),
      theme: BannerService.theme(body.theme ?? 'light'),
      focusX: has(body, 'focusX') ? pct(body.focusX, 'focusX') : 50,
      focusY: has(body, 'focusY') ? pct(body.focusY, 'focusY') : 50,
      mobileFocusX: has(body, 'mobileFocusX') ? pct(body.mobileFocusX, 'mobileFocusX') : 50,
      mobileFocusY: has(body, 'mobileFocusY') ? pct(body.mobileFocusY, 'mobileFocusY') : 50,
      active: body.active === undefined ? true : body.active === true,
    });
  }

  private static theme(v: unknown): BannerTheme {
    if (v === 'light' || v === 'dark') return v;
    throw new AdminError('theme: light или dark');
  }

  async update(id: number, body: Record<string, unknown>): Promise<SiteBanner> {
    const p: BannerPatch = {};
    if (has(body, 'title')) p.title = text(body.title, 'title', 120);
    if (has(body, 'subtitle')) p.subtitle = text(body.subtitle, 'subtitle', 240);
    if (has(body, 'buttonText')) p.buttonText = text(body.buttonText, 'buttonText', 40);
    if (has(body, 'link')) p.link = link(body.link);
    if (has(body, 'theme')) p.theme = BannerService.theme(body.theme);
    for (const k of ['focusX', 'focusY', 'mobileFocusX', 'mobileFocusY'] as const) {
      if (has(body, k)) p[k] = pct(body[k], k);
    }
    if (has(body, 'active')) p.active = body.active === true;
    return this.repo.update(id, p);
  }

  /** Публичная выдача: включённые баннеры с картинкой, по порядку. */
  async publicList(): Promise<SiteBanner[]> {
    return (await this.repo.list()).filter((b) => b.active && b.image);
  }
}
