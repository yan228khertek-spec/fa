/**
 * Доменные типы предложений из 1С (CommerceML 2, offers.xml). Этап 3 мастердока.
 * Ид предложения — как в 1С: «Ид товара» либо «Ид#ИдХарактеристики» для SKU.
 */

export interface OfferPriceType {
  sourceId: string;
  name: string;
  currency: string | null;
}

export interface OfferWarehouse {
  sourceId: string;
  name: string;
}

export interface OfferPrice {
  priceTypeSourceId: string;
  value: number;
  currency: string | null;
}

/** Остаток: warehouseSourceId '' — общий тег Количество (без разбивки по складам). */
export interface OfferStock {
  warehouseSourceId: string;
  quantity: number;
}

/**
 * Предложение. null в полях означает «тега/блока в файле НЕ БЫЛО вовсе —
 * не менять», а не «очистить»: 1С штатно шлёт инкрементальные выгрузки
 * «только цены» и «только остатки» с минимальным Предложением (Ид +
 * Количество), и такие выгрузки не должны затирать наименование, артикул,
 * характеристики или цены (ревью этапа 3, находка 1). Пустой блок
 * (<Цены/>) — наоборот, явное «значений нет»: [] либо {}.
 */
export interface Offer {
  sourceId: string;
  productSourceId: string;
  charSourceId: string | null;
  article: string | null;
  name: string | null;
  characteristics: Record<string, string> | null;
  isDeleted: boolean | null;
  prices: OfferPrice[] | null;
  stocks: OfferStock[] | null;
}

/** Шапка выгрузки: КоммерческаяИнформация + ПакетПредложений/@СодержитТолькоИзменения. */
export interface OffersMeta {
  schemaVersion: string | null;
  generatedAt: string | null;
  onlyChanges: boolean;
}

export interface OffersCounters {
  priceTypes: number;
  warehouses: number;
  offers: number;
  prices: number;
  stocks: number;
}

export interface OffersFinishRun {
  counters: OffersCounters;
  meta: OffersMeta;
  status: 'success' | 'failure';
  error?: string;
}

export interface OffersSummary extends OffersCounters {
  filename: string;
  meta: OffersMeta;
  durationMs: number;
}

/**
 * Хранилище предложений. Батчи приходят из потокового парсера; каждый метод
 * идемпотентен по sourceId. Для предложений с prices/stocks === null
 * существующие цены/остатки НЕ трогаются (инкрементальные выгрузки 1С).
 */
export interface OffersRepository {
  /** Идемпотентный DDL (миграция 003). Вызывается один раз перед записью. */
  ready(): Promise<void>;
  upsertPriceTypes(items: OfferPriceType[]): Promise<void>;
  upsertWarehouses(items: OfferWarehouse[]): Promise<void>;
  upsertOffers(items: Offer[]): Promise<void>;
  /** Запись в offers_import_runs; возвращает id прогона (null — если не ведётся). */
  startRun(filename: string, meta: OffersMeta): Promise<number | null>;
  finishRun(runId: number | null, result: OffersFinishRun): Promise<void>;
  close(): Promise<void>;
}
