import { CATEGORIES, categoryOf, kindOf, type Category } from './category.js';
import { normalizeText } from './matcher.js';
import type { BrandService, Page } from './service.js';
import {
  AdminError,
  type CardCharacteristic,
  type CardPatch,
  type CardRepository,
  type CardStatus,
  type CatalogReader,
  type LiveModel,
  type SiteCard,
} from './types.js';

/** Не больше фото на карточку (место и скорость страницы). */
export const MAX_CARD_PHOTOS = 12;

export type HiddenReason = 'draft' | 'no-photo' | 'gone' | 'no-stock';

export interface BrandRef {
  name: string;
  slug: string;
}

export interface ModelHit {
  id: string;
  name: string;
  article: string | null;
  brand: BrandRef | null;
  /** Id уже созданной карточки этой модели. */
  cardId: number | null;
}

export interface CardView extends SiteCard {
  /** Данные из staging; null — модель исчезла из 1С. */
  model: {
    name: string;
    article: string | null;
    brand: BrandRef | null;
    price: number | null;
    stock: number | null;
    variants: {
      id: string;
      size: string | null;
      color: string | null;
      inStock: boolean | null;
      price: number | null;
    }[];
  } | null;
  visible: boolean;
  hiddenReason: HiddenReason | null;
}

export interface PublicCardItem {
  id: number;
  modelId: string;
  title: string;
  brand: BrandRef | null;
  /** Имя файла главного фото в uploads. */
  photo: string | null;
  price: number | null;
  inStock: boolean | null;
  /** Раздел витрины и вид изделия — определяются по названию из 1С. */
  category: Category;
  kind: string;
}

export interface PublicCardFacets {
  categories: { name: Category; count: number }[];
  kinds: { name: string; count: number }[];
  /** Ниже — для фильтра на странице: считаются внутри выбранного раздела, без учёта самих фильтров. */
  brands: { name: string; slug: string; count: number }[];
  sizes: { name: string; count: number }[];
  colors: { name: string; count: number }[];
  price: { min: number; max: number } | null;
}

export type CardSort = 'new' | 'priceAsc' | 'priceDesc';

/** Размеры по порядку: буквенные XS…XXL, числовые по возрастанию, остальное по алфавиту. */
const LETTER_SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
export function compareSizes(a: string, b: string): number {
  const na = Number(a.replace(',', '.'));
  const nb = Number(b.replace(',', '.'));
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  if (!Number.isNaN(na)) return -1;
  if (!Number.isNaN(nb)) return 1;
  const ia = LETTER_SIZES.indexOf(a.toUpperCase());
  const ib = LETTER_SIZES.indexOf(b.toUpperCase());
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a.localeCompare(b, 'ru');
}

export interface PublicCardDetail extends PublicCardItem {
  article: string | null;
  description: string;
  characteristics: CardCharacteristic[];
  photos: string[];
  /** id — Ид SKU для корзины (v1.2), price — цена именно этого SKU (v1.2). */
  sizes: {
    id: string;
    size: string | null;
    color: string | null;
    inStock: boolean | null;
    price: number | null;
  }[];
}

/** Карточка, которую можно заказать: живые SKU модели со снимком полей для order_items. */
export interface OrderableCard {
  cardId: number;
  modelId: string;
  title: string;
  article: string | null;
  variants: Map<
    string,
    {
      size: string | null;
      color: string | null;
      name: string | null;
      price: number | null;
      quantity: number | null;
    }
  >;
}

export interface CardInput {
  modelId?: unknown;
  title?: unknown;
  description?: unknown;
  characteristics?: unknown;
  status?: unknown;
  category?: unknown;
}

function parseTitle(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new AdminError('title: ожидается строка');
  const s = v.trim().replace(/\s+/g, ' ');
  if (s.length > 200) throw new AdminError('title: не длиннее 200 символов');
  return s || null;
}

function parseDescription(v: unknown): string {
  if (typeof v !== 'string') throw new AdminError('description: ожидается строка');
  if (v.length > 20000) throw new AdminError('description: не длиннее 20000 символов');
  return v.trim();
}

function parseCharacteristics(v: unknown): CardCharacteristic[] {
  if (!Array.isArray(v) || v.length > 50)
    throw new AdminError('characteristics: массив до 50 строк');
  const out: CardCharacteristic[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null)
      throw new AdminError('characteristics: ожидаются объекты');
    const { name, value } = item as Record<string, unknown>;
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw new AdminError('characteristics: name и value — строки');
    }
    const n = name.trim();
    const val = value.trim();
    if (!n && !val) continue; // пустая строка формы
    if (!n || !val) throw new AdminError('characteristics: заполните и название, и значение');
    if (n.length > 100 || val.length > 500)
      throw new AdminError('characteristics: слишком длинное значение');
    out.push({ name: n, value: val });
  }
  return out;
}

/** Раздел вручную: пусто — «по названию из 1С», иначе один из разделов витрины. */
function parseCategory(v: unknown): string | null {
  if (v === null || v === '') return null;
  if (typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v)) return v;
  throw new AdminError(`category: пусто или один из «${CATEGORIES.join('», «')}»`);
}

function parseStatus(v: unknown): CardStatus {
  if (v === 'draft' || v === 'published') return v;
  throw new AdminError('status: draft или published');
}

/**
 * Карточки товаров: редакционная часть (site_cards) + живые данные из staging.
 * Правило видимости на сайте: опубликована, есть фото, модель есть в 1С и (если остатки
 * известны) остаток больше нуля. Менеджер ничего не «деплоит» и не скрывает руками.
 */
export class CardService {
  constructor(
    readonly repo: CardRepository,
    readonly catalog: CatalogReader,
    private readonly brands: BrandService,
  ) {}

  private async context() {
    const [models, live, brandList, assigned] = await Promise.all([
      this.catalog.listModels(),
      this.catalog.liveData(),
      this.brands.repo.listBrands(),
      this.brands.repo.listAssignments(),
    ]);
    const byBrandId = new Map(brandList.map((b) => [b.id, b]));
    const brandOf = new Map<string, BrandRef>();
    for (const a of assigned) {
      const b = byBrandId.get(a.brandId);
      if (b) brandOf.set(a.modelId, { name: b.name, slug: b.slug });
    }
    return { models: new Map(models.map((m) => [m.id, m])), live, brandOf, all: models };
  }

  private view(card: SiteCard, ctx: Awaited<ReturnType<CardService['context']>>): CardView {
    const m = ctx.models.get(card.modelId);
    const live: LiveModel | undefined = ctx.live.get(card.modelId);
    let hiddenReason: HiddenReason | null = null;
    if (card.status !== 'published') hiddenReason = 'draft';
    else if (!m) hiddenReason = 'gone';
    else if (card.photos.length === 0) hiddenReason = 'no-photo';
    else if (live && live.stock !== null && live.stock <= 0) hiddenReason = 'no-stock';
    return {
      ...card,
      model: m
        ? {
            name: m.name,
            article: m.article,
            brand: ctx.brandOf.get(m.id) ?? null,
            price: live?.price ?? null,
            stock: live?.stock ?? null,
            variants: (live?.variants ?? []).map((v) => ({
              id: v.id,
              size: v.size,
              color: v.color,
              inStock: v.quantity === null ? null : v.quantity > 0,
              price: v.price ?? null,
            })),
          }
        : null,
      visible: hiddenReason === null,
      hiddenReason,
    };
  }

  /** Автокомплит по staging: название или артикул. */
  async search(query: string, limit = 15): Promise<ModelHit[]> {
    const q = normalizeText(query);
    if (q.length < 2) return [];
    const [ctx, cards] = await Promise.all([this.context(), this.repo.listCards()]);
    const cardOf = new Map(cards.map((c) => [c.modelId, c.id]));
    const hits: ModelHit[] = [];
    for (const m of ctx.all) {
      if (!normalizeText(`${m.name} ${m.article ?? ''}`).includes(q)) continue;
      hits.push({
        id: m.id,
        name: m.name,
        article: m.article,
        brand: ctx.brandOf.get(m.id) ?? null,
        cardId: cardOf.get(m.id) ?? null,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  async list(opts: {
    status?: string;
    query?: string;
    limit: number;
    offset: number;
  }): Promise<Page<CardView>> {
    const [ctx, cards] = await Promise.all([this.context(), this.repo.listCards()]);
    const q = normalizeText(opts.query ?? '');
    const rows = cards
      .map((c) => this.view(c, ctx))
      .filter((v) => {
        if (opts.status === 'draft' || opts.status === 'published') {
          if (v.status !== opts.status) return false;
        } else if (opts.status === 'hidden') {
          if (v.status !== 'published' || v.visible) return false;
        }
        if (!q) return true;
        const text = `${v.title ?? ''} ${v.model?.name ?? ''} ${v.model?.article ?? ''}`;
        return normalizeText(text).includes(q);
      });
    return { total: rows.length, items: rows.slice(opts.offset, opts.offset + opts.limit) };
  }

  async get(id: number): Promise<CardView> {
    const card = await this.repo.getCard(id);
    if (!card) throw new AdminError('Карточка не найдена', 404);
    return this.view(card, await this.context());
  }

  async create(input: CardInput): Promise<CardView> {
    if (typeof input.modelId !== 'string' || !input.modelId || input.modelId.length > 200) {
      throw new AdminError('modelId: ожидается Ид модели');
    }
    const models = await this.catalog.listModels();
    if (!models.some((m) => m.id === input.modelId)) {
      throw new AdminError('Такой модели нет в каталоге 1С', 404);
    }
    const card = await this.repo.createCard({
      modelId: input.modelId,
      title: input.title === undefined ? null : parseTitle(input.title),
      description: input.description === undefined ? '' : parseDescription(input.description),
      characteristics:
        input.characteristics === undefined ? [] : parseCharacteristics(input.characteristics),
    });
    return this.get(card.id);
  }

  async update(id: number, input: CardInput): Promise<CardView> {
    const patch: CardPatch = {};
    if (input.title !== undefined) patch.title = parseTitle(input.title);
    if (input.description !== undefined) patch.description = parseDescription(input.description);
    if (input.characteristics !== undefined) {
      patch.characteristics = parseCharacteristics(input.characteristics);
    }
    if (input.category !== undefined) patch.category = parseCategory(input.category);
    if (input.status !== undefined) {
      patch.status = parseStatus(input.status);
      if (patch.status === 'published') {
        const card = await this.repo.getCard(id);
        if (!card) throw new AdminError('Карточка не найдена', 404);
        if (card.photos.length === 0) {
          throw new AdminError(
            'Нельзя опубликовать карточку без фото: загрузите хотя бы одно',
            409,
          );
        }
        const models = await this.catalog.listModels();
        if (!models.some((m) => m.id === card.modelId)) {
          throw new AdminError('Модель исчезла из каталога 1С — опубликовать нельзя', 409);
        }
      }
    }
    await this.repo.updateCard(id, patch);
    return this.get(id);
  }

  // ---------- публичная выдача: только то, что видно покупателю ----------

  private async visibleCards() {
    const [ctx, cards] = await Promise.all([this.context(), this.repo.listCards()]);
    return cards
      .map((c) => ({ card: c, view: this.view(c, ctx), ctx }))
      .filter((x) => x.view.visible)
      .sort(
        (a, b) =>
          (b.card.publishedAt ?? '').localeCompare(a.card.publishedAt ?? '') ||
          b.card.id - a.card.id,
      );
  }

  private item(x: { card: SiteCard; view: CardView }): PublicCardItem {
    const m = x.view.model!;
    const stock = m.stock;
    return {
      id: x.card.id,
      modelId: x.card.modelId,
      title: x.card.title ?? m.name,
      brand: m.brand,
      photo: x.card.photos[0]?.file ?? null,
      price: m.price,
      inStock: stock === null ? null : stock > 0,
      category: (x.card.category as Category | null) ?? categoryOf(m.name),
      // у карточки с ручным разделом первое слово названия — не вид изделия (часто бренд)
      kind: x.card.category ?? kindOf(m.name),
    };
  }

  /**
   * Витрина: только видимые карточки. Фильтры — бренд, раздел, вид изделия.
   * facets считаются по тому, что осталось после фильтра бренда (разделы) и раздела (виды),
   * чтобы меню показывало, что реально можно выбрать.
   */
  async publicList(opts: {
    brandSlug?: string;
    category?: string;
    kind?: string;
    /** Фильтры страницы: бренды (slug), размеры и цвета «любой из», цена «от и до». */
    brands?: string[];
    sizes?: string[];
    colors?: string[];
    priceMin?: number;
    priceMax?: number;
    sort?: CardSort;
    limit: number;
    offset: number;
  }): Promise<Page<PublicCardItem> & { facets: PublicCardFacets }> {
    // размеры и цвета берём только у вариантов, которые есть в наличии (или наличие неизвестно)
    const sizesOf = new Map<number, { sizes: Set<string>; colors: Set<string> }>();
    const byBrand = (await this.visibleCards())
      .filter((x) => !opts.brandSlug || x.view.model?.brand?.slug === opts.brandSlug)
      .map((x) => {
        const v = (x.view.model?.variants ?? []).filter((w) => w.inStock !== false);
        sizesOf.set(x.card.id, {
          sizes: new Set(v.map((w) => w.size?.trim()).filter((z): z is string => !!z)),
          colors: new Set(v.map((w) => w.color?.trim()).filter((z): z is string => !!z)),
        });
        return this.item(x);
      });
    const count = <T extends string>(names: T[]) => {
      const m = new Map<T, number>();
      for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
      return m;
    };
    const catCounts = count(byBrand.map((i) => i.category));
    const inCategory = byBrand.filter((i) => !opts.category || i.category === opts.category);
    const kindCounts = count(inCategory.filter((i) => i.kind).map((i) => i.kind));
    const brandCounts = new Map<string, { name: string; slug: string; count: number }>();
    const sizeCounts = new Map<string, number>();
    const colorCounts = new Map<string, number>();
    let pMin = Infinity;
    let pMax = -Infinity;
    for (const i of inCategory) {
      if (i.brand) {
        const e = brandCounts.get(i.brand.slug) ?? { ...i.brand, count: 0 };
        e.count++;
        brandCounts.set(i.brand.slug, e);
      }
      const v = sizesOf.get(i.id);
      for (const z of v?.sizes ?? []) sizeCounts.set(z, (sizeCounts.get(z) ?? 0) + 1);
      for (const c of v?.colors ?? []) colorCounts.set(c, (colorCounts.get(c) ?? 0) + 1);
      if (i.price !== null) {
        pMin = Math.min(pMin, i.price);
        pMax = Math.max(pMax, i.price);
      }
    }
    const has = (list: string[] | undefined, set: Set<string> | undefined) =>
      !list?.length || list.some((x) => set?.has(x));
    const rows = inCategory
      .filter((i) => !opts.kind || i.kind === opts.kind)
      .filter(
        (i) => !opts.brands?.length || (i.brand !== null && opts.brands.includes(i.brand.slug)),
      )
      .filter((i) => has(opts.sizes, sizesOf.get(i.id)?.sizes))
      .filter((i) => has(opts.colors, sizesOf.get(i.id)?.colors))
      .filter((i) => opts.priceMin === undefined || (i.price !== null && i.price >= opts.priceMin))
      .filter((i) => opts.priceMax === undefined || (i.price !== null && i.price <= opts.priceMax));
    if (opts.sort === 'priceAsc' || opts.sort === 'priceDesc') {
      const dir = opts.sort === 'priceAsc' ? 1 : -1;
      // без цены — в конец; при равной цене остаётся порядок «сначала новинки» (сортировка устойчивая)
      rows.sort((a, b) =>
        a.price === null
          ? b.price === null
            ? 0
            : 1
          : b.price === null
            ? -1
            : (a.price - b.price) * dir,
      );
    }
    return {
      total: rows.length,
      items: rows.slice(opts.offset, opts.offset + opts.limit),
      facets: {
        brands: [...brandCounts.values()].sort(
          (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'),
        ),
        sizes: [...sizeCounts]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => compareSizes(a.name, b.name)),
        colors: [...colorCounts]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru')),
        price: pMin <= pMax ? { min: Math.floor(pMin), max: Math.ceil(pMax) } : null,
        categories: CATEGORIES.filter((c) => catCounts.has(c)).map((name) => ({
          name,
          count: catCounts.get(name)!,
        })),
        kinds: [...kindCounts]
          .map(([name, c]) => ({ name, count: c }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru')),
      },
    };
  }

  /**
   * Блоки главной страницы: бренды с флагом «Показывать на главной» и их последние
   * опубликованные карточки. Бренд без видимых карточек в блок не попадает.
   */
  async homeSections(
    perBrand = 4,
    maxBrands = 3,
  ): Promise<{ brand: BrandRef; total: number; items: PublicCardItem[] }[]> {
    const brands = (await this.brands.repo.listBrands())
      .filter((b) => b.home)
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    if (!brands.length) return [];
    const items = (await this.visibleCards()).map((x) => this.item(x));
    return brands
      .map((b) => {
        const mine = items.filter((i) => i.brand?.slug === b.slug);
        return {
          brand: { name: b.name, slug: b.slug },
          total: mine.length,
          items: mine.slice(0, perBrand),
        };
      })
      .filter((s) => s.items.length)
      .slice(0, maxBrands);
  }

  async publicCard(id: number): Promise<PublicCardDetail | null> {
    const x = (await this.visibleCards()).find((c) => c.card.id === id);
    if (!x) return null;
    const m = x.view.model!;
    return {
      ...this.item(x),
      article: m.article,
      description: x.card.description,
      characteristics: x.card.characteristics,
      photos: x.card.photos.map((p) => p.file),
      sizes: m.variants.map((v) => ({
        id: v.id,
        size: v.size,
        color: v.color,
        inStock: v.inStock,
        price: v.price,
      })),
    };
  }

  /**
   * Для оформления заказа: только ВИДИМЫЕ на витрине карточки из `ids` (то же правило A5,
   * что у публичной выдачи) с живыми SKU — цена и остаток из той же liveData, что у витрины.
   */
  async orderable(ids: number[]): Promise<Map<number, OrderableCard>> {
    const want = new Set(ids);
    const [ctx, cards] = await Promise.all([this.context(), this.repo.listCards()]);
    const out = new Map<number, OrderableCard>();
    for (const card of cards) {
      if (!want.has(card.id)) continue;
      const view = this.view(card, ctx);
      if (!view.visible || !view.model) continue;
      const live = ctx.live.get(card.modelId);
      out.set(card.id, {
        cardId: card.id,
        modelId: card.modelId,
        title: card.title ?? view.model.name,
        article: view.model.article,
        variants: new Map(
          (live?.variants ?? []).map((v) => [
            v.id,
            {
              size: v.size,
              color: v.color,
              name: v.name ?? null,
              price: v.price ?? null,
              quantity: v.quantity,
            },
          ]),
        ),
      });
    }
    return out;
  }

  /** Пути фото модели в выгрузке 1С (для кнопки «Взять фото из 1С»). */
  async sourceImages(cardId: number): Promise<string[]> {
    const card = await this.repo.getCard(cardId);
    if (!card) throw new AdminError('Карточка не найдена', 404);
    return this.catalog.modelImages(card.modelId);
  }

  async photoCount(cardId: number): Promise<number> {
    const card = await this.repo.getCard(cardId);
    if (!card) throw new AdminError('Карточка не найдена', 404);
    return card.photos.length;
  }
}
