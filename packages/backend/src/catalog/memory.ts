import type {
  CatalogBrand,
  CatalogCategory,
  CatalogDictionary,
  CatalogProduct,
  CatalogProperty,
  CatalogRepository,
  CatalogVariant,
  FinishRun,
  ImportCounters,
  ImportMeta,
} from './types.js';

export interface MemoryRun {
  id: number;
  filename: string;
  meta: ImportMeta;
  counters?: ImportCounters;
  status: 'running' | 'success' | 'failure';
  error?: string;
}

/**
 * Каталог в памяти — dev без DATABASE_URL и юнит-тесты (по образцу
 * MemoryExchangeLog). Ключ — sourceId из 1С, поэтому повторная загрузка
 * того же файла заменяет запись, а не добавляет дубль: та же идемпотентность,
 * что у ON CONFLICT в PgCatalogRepository.
 */
export class MemoryCatalogRepository implements CatalogRepository {
  readonly categories = new Map<string, CatalogCategory>();
  readonly brands = new Map<string, CatalogBrand>();
  readonly properties = new Map<string, CatalogProperty>();
  readonly products = new Map<string, CatalogProduct>();
  readonly variants = new Map<string, CatalogVariant>();
  readonly runs: MemoryRun[] = [];

  async ready(): Promise<void> {
    // схема не нужна
  }

  async upsertCategories(items: CatalogCategory[]): Promise<void> {
    for (const item of items) this.categories.set(item.sourceId, item);
  }

  async upsertBrands(items: CatalogBrand[]): Promise<void> {
    for (const item of items) this.brands.set(item.sourceId, item);
  }

  async upsertProperties(items: CatalogProperty[]): Promise<void> {
    for (const item of items) this.properties.set(item.sourceId, item);
  }

  async upsertProducts(items: CatalogProduct[]): Promise<void> {
    for (const item of items) this.products.set(item.sourceId, item);
  }

  async upsertVariants(items: CatalogVariant[]): Promise<void> {
    for (const item of items) this.variants.set(item.sourceId, item);
  }

  async loadDictionary(): Promise<CatalogDictionary> {
    const propertyNames = new Map<string, string>();
    const optionValues = new Map<string, string>();
    for (const prop of this.properties.values()) {
      propertyNames.set(prop.sourceId, prop.name);
      for (const option of prop.options) {
        optionValues.set(`${prop.sourceId}:${option.sourceId}`, option.value);
      }
    }
    return { propertyNames, optionValues };
  }

  async startRun(filename: string, meta: ImportMeta): Promise<number | null> {
    const id = this.runs.length + 1;
    this.runs.push({ id, filename, meta, status: 'running' });
    return id;
  }

  async finishRun(runId: number | null, result: FinishRun): Promise<void> {
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
    let images = 0;
    let productProperties = 0;
    let productCategories = 0;
    for (const p of this.products.values()) {
      images += p.images.length;
      productProperties += p.properties.length;
      productCategories += p.categorySourceIds.length;
    }
    for (const v of this.variants.values()) images += v.images.length;
    return {
      categories: this.categories.size,
      brands: this.brands.size,
      properties: this.properties.size,
      products: this.products.size,
      variants: this.variants.size,
      productCategories,
      productProperties,
      images,
    };
  }
}
