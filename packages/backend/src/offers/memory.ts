import type {
  Offer,
  OfferPriceType,
  OfferWarehouse,
  OffersCounters,
  OffersFinishRun,
  OffersMeta,
  OffersRepository,
} from './types.js';

export interface MemoryOffersRun {
  id: number;
  filename: string;
  meta: OffersMeta;
  counters?: OffersCounters;
  status: 'running' | 'success' | 'failure';
  error?: string;
}

/** Предложение в памяти: поля «не приходило» хранятся раскрытыми. */
export interface MemoryOffer extends Omit<
  Offer,
  'prices' | 'stocks' | 'characteristics' | 'isDeleted'
> {
  prices: NonNullable<Offer['prices']>;
  stocks: NonNullable<Offer['stocks']>;
  characteristics: Record<string, string>;
  isDeleted: boolean;
}

/**
 * Предложения в памяти — dev без DATABASE_URL и юнит-тесты (по образцу
 * MemoryCatalogRepository). Семантика та же, что у PgOffersRepository:
 * ключ — sourceId из 1С; prices/stocks === null означает «тега в файле
 * не было» — существующие цены/остатки сохраняются, не обнуляются.
 */
export class MemoryOffersRepository implements OffersRepository {
  readonly priceTypes = new Map<string, OfferPriceType>();
  readonly warehouses = new Map<string, OfferWarehouse>();
  readonly offers = new Map<string, MemoryOffer>();
  readonly runs: MemoryOffersRun[] = [];

  async ready(): Promise<void> {
    // схема не нужна
  }

  async upsertPriceTypes(items: OfferPriceType[]): Promise<void> {
    for (const item of items) this.priceTypes.set(item.sourceId, item);
  }

  async upsertWarehouses(items: OfferWarehouse[]): Promise<void> {
    for (const item of items) this.warehouses.set(item.sourceId, item);
  }

  async upsertOffers(items: Offer[]): Promise<void> {
    for (const item of items) {
      // null = «тега в файле не было» → сохраняем прежнее значение, как
      // coalesce в PgOffersRepository (ревью этапа 3, находка 1).
      const prior = this.offers.get(item.sourceId);
      this.offers.set(item.sourceId, {
        ...item,
        article: item.article ?? prior?.article ?? null,
        name: item.name ?? prior?.name ?? null,
        characteristics: item.characteristics ?? prior?.characteristics ?? {},
        isDeleted: item.isDeleted ?? prior?.isDeleted ?? false,
        prices: item.prices ?? prior?.prices ?? [],
        stocks: item.stocks ?? prior?.stocks ?? [],
      });
    }
  }

  async startRun(filename: string, meta: OffersMeta): Promise<number | null> {
    const id = this.runs.length + 1;
    this.runs.push({ id, filename, meta, status: 'running' });
    return id;
  }

  async finishRun(runId: number | null, result: OffersFinishRun): Promise<void> {
    const run = this.runs.find((r) => r.id === runId);
    if (!run) return;
    run.counters = result.counters;
    run.meta = result.meta;
    run.status = result.status;
    run.error = result.error;
  }

  async close(): Promise<void> {
    // ничего
  }

  /** Сводка строк — ею тесты проверяют идемпотентность по счётчикам. */
  rowCounts(): Record<string, number> {
    let prices = 0;
    let stocks = 0;
    for (const o of this.offers.values()) {
      prices += o.prices.length;
      stocks += o.stocks.length;
    }
    return {
      priceTypes: this.priceTypes.size,
      warehouses: this.warehouses.size,
      offers: this.offers.size,
      prices,
      stocks,
    };
  }
}
