import { AdminError } from './types.js';

export const BANNER_THEMES = ['light', 'dark'] as const;
export type BannerTheme = (typeof BANNER_THEMES)[number];
/** Где показывается баннер: слайдер вверху главной или баннер блока парфюмерии. */
export const BANNER_PLACEMENTS = ['hero', 'perfume'] as const;
export type BannerPlacement = (typeof BANNER_PLACEMENTS)[number];
/** Не больше баннеров на место: слайдер не должен превращаться в ленту. */
export const MAX_BANNERS: Record<BannerPlacement, number> = { hero: 12, perfume: 3 };

export type BannerFileKind = 'image' | 'imageMobile' | 'video' | 'videoMobile';

export interface SiteBanner {
  id: number;
  placement: BannerPlacement;
  title: string;
  subtitle: string;
  buttonText: string;
  link: string;
  theme: BannerTheme;
  /** Имена файлов в uploads. */
  image: string | null;
  imageMobile: string | null;
  /** Видео (MP4) вместо картинки на экране; картинка служит постером. */
  video: string | null;
  videoMobile: string | null;
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
  'id' | 'image' | 'imageMobile' | 'video' | 'videoMobile' | 'sort' | 'createdAt' | 'updatedAt'
>;
/** Место задаётся при создании и не меняется. */
export type BannerPatch = Partial<Omit<NewBanner, 'placement'>>;

export interface BannerRepository {
  ready(): Promise<void>;
  list(): Promise<SiteBanner[]>;
  get(id: number): Promise<SiteBanner | null>;
  create(input: NewBanner): Promise<SiteBanner>;
  update(id: number, patch: BannerPatch): Promise<SiteBanner>;
  /** Удаляет баннер и возвращает его файлы, чтобы убрать их с диска. */
  delete(id: number): Promise<string[]>;
  /** Подменяет файл (картинку или видео) и возвращает прежнее имя (null — не было). */
  setFile(id: number, kind: BannerFileKind, file: string | null): Promise<string | null>;
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
    const placement = BannerService.placement(body.placement ?? 'hero');
    const sameSpot = (await this.repo.list()).filter((b) => b.placement === placement).length;
    if (sameSpot >= MAX_BANNERS[placement]) {
      throw new AdminError(`Не больше ${MAX_BANNERS[placement]} баннеров на это место`, 409);
    }
    return this.repo.create({
      placement,
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

  private static placement(v: unknown): BannerPlacement {
    if (v === 'hero' || v === 'perfume') return v;
    throw new AdminError('placement: hero или perfume');
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

  /** Публичная выдача места: включённые баннеры с картинкой, по порядку. */
  async publicList(placement: BannerPlacement = 'hero'): Promise<SiteBanner[]> {
    return (await this.repo.list()).filter((b) => b.placement === placement && b.active && b.image);
  }
}
