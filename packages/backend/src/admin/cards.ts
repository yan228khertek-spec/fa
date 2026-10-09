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
    variants: { id: string; size: string | null; color: string | null; inStock: boolean | null }[];
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
}

export interface PublicCardDetail extends PublicCardItem {
  article: string | null;
  description: string;
  characteristics: CardCharacteristic[];
  photos: string[];
  sizes: { size: string | null; color: string | null; inStock: boolean | null }[];
}

export interface CardInput {
  modelId?: unknown;
  title?: unknown;
  description?: unknown;
  characteristics?: unknown;
  status?: unknown;
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
      category: categoryOf(m.name),
      kind: kindOf(m.name),
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
    limit: number;
    offset: number;
  }): Promise<Page<PublicCardItem> & { facets: PublicCardFacets }> {
    const byBrand = (await this.visibleCards())
      .filter((x) => !opts.brandSlug || x.view.model?.brand?.slug === opts.brandSlug)
      .map((x) => this.item(x));
    const count = <T extends string>(names: T[]) => {
      const m = new Map<T, number>();
      for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
      return m;
    };
    const catCounts = count(byBrand.map((i) => i.category));
    const inCategory = byBrand.filter((i) => !opts.category || i.category === opts.category);
    const kindCounts = count(inCategory.filter((i) => i.kind).map((i) => i.kind));
    const rows = inCategory.filter((i) => !opts.kind || i.kind === opts.kind);
    return {
      total: rows.length,
      items: rows.slice(opts.offset, opts.offset + opts.limit),
      facets: {
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
      sizes: m.variants.map((v) => ({ size: v.size, color: v.color, inStock: v.inStock })),
    };
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
