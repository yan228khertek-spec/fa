/**
 * Доменные типы каталога из 1С (CommerceML 2, import.xml).
 * Все идентификаторы — «как в 1С»: Ид товара, Ид#ИдХарактеристики для SKU.
 */

/** Группа классификатора → категория. */
export interface CatalogCategory {
  sourceId: string;
  parentSourceId: string | null;
  name: string;
  level: number;
  sortOrder: number;
  isDeleted?: boolean;
}

export interface CatalogBrand {
  sourceId: string;
  name: string;
}

export interface CatalogPropertyOption {
  sourceId: string;
  value: string;
}

/** Свойство классификатора (Классификатор/Свойства/Свойство). */
export interface CatalogProperty {
  sourceId: string;
  name: string;
  valueType: string | null;
  options: CatalogPropertyOption[];
}

export interface CatalogImage {
  path: string;
  sortOrder: number;
}

/** Значение свойства у товара: value — то, что пришло (Ид варианта или текст). */
export interface CatalogProductPropertyValue {
  propertySourceId: string;
  value: string;
}

/** Товар-модель (Ид без «#»). */
export interface CatalogProduct {
  sourceId: string;
  article: string | null;
  name: string;
  fullName: string | null;
  description: string | null;
  brandSourceId: string | null;
  categorySourceIds: string[];
  baseUnit: string | null;
  isDeleted: boolean;
  properties: CatalogProductPropertyValue[];
  images: CatalogImage[];
}

/** SKU-характеристика (Ид вида «родитель#характеристика»). */
export interface CatalogVariant {
  sourceId: string;
  productSourceId: string;
  charSourceId: string | null;
  article: string | null;
  name: string | null;
  size: string | null;
  color: string | null;
  characteristics: Record<string, string>;
  isDeleted: boolean;
  images: CatalogImage[];
}

/** Шапка выгрузки: КоммерческаяИнформация + Каталог/@СодержитТолькоИзменения. */
export interface ImportMeta {
  schemaVersion: string | null;
  generatedAt: string | null;
  onlyChanges: boolean;
}

export interface ImportCounters {
  categories: number;
  brands: number;
  properties: number;
  products: number;
  variants: number;
  images: number;
}

/**
 * Справочник свойств классификатора: Ид свойства → имя, «Ид свойства:Ид
 * варианта» → значение. Нужен, чтобы развернуть размер/цвет характеристики,
 * когда Классификатор пришёл отдельным файлом выгрузки.
 */
export interface CatalogDictionary {
  propertyNames: Map<string, string>;
  optionValues: Map<string, string>;
}

export interface FinishRun {
  counters: ImportCounters;
  /** Шапка выгрузки известна полностью только к концу разбора. */
  meta: ImportMeta;
  status: 'success' | 'failure';
  error?: string;
}

export interface ImportSummary extends ImportCounters {
  filename: string;
  meta: ImportMeta;
  durationMs: number;
}

/**
 * Хранилище staging-каталога. Батчи приходят из потокового парсера, поэтому
 * методы принимают массивы; каждый обязан быть идемпотентным по sourceId.
 */
export interface CatalogRepository {
  /** Идемпотентный DDL (миграция 002). Вызывается один раз перед записью. */
  ready(): Promise<void>;
  upsertCategories(items: CatalogCategory[]): Promise<void>;
  upsertBrands(items: CatalogBrand[]): Promise<void>;
  upsertProperties(items: CatalogProperty[]): Promise<void>;
  upsertProducts(items: CatalogProduct[]): Promise<void>;
  upsertVariants(items: CatalogVariant[]): Promise<void>;
  /** Свойства и варианты значений из ранее загруженных файлов выгрузки. */
  loadDictionary(): Promise<CatalogDictionary>;
  /** Запись в catalog_import_runs; возвращает id прогона (null — если не ведётся). */
  startRun(filename: string, meta: ImportMeta): Promise<number | null>;
  finishRun(runId: number | null, result: FinishRun): Promise<void>;
  close(): Promise<void>;
}
