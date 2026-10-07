import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import iconv from 'iconv-lite';
import { SaxesParser } from 'saxes';
import { detectFileEncoding } from './encoding.js';
import type {
  CatalogBrand,
  CatalogCategory,
  CatalogDictionary,
  CatalogImage,
  CatalogProduct,
  CatalogProperty,
  CatalogVariant,
  ImportCounters,
  ImportMeta,
} from './types.js';

/** Ошибка разбора выгрузки: наружу уходит одной строкой в exchange_log. */
export class ImportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportParseError';
  }
}

export interface ImportHandlers {
  onMeta?(meta: ImportMeta): void | Promise<void>;
  onCategories?(items: CatalogCategory[]): Promise<void>;
  onBrands?(items: CatalogBrand[]): Promise<void>;
  onProperties?(items: CatalogProperty[]): Promise<void>;
  onProducts?(items: CatalogProduct[]): Promise<void>;
  onVariants?(items: CatalogVariant[]): Promise<void>;
}

export interface ParseImportOptions {
  /** Сколько сущностей накапливать до выдачи в хранилище. */
  batchSize?: number;
  /** Имя файла в сообщениях об ошибках (1С бьёт выгрузку на части). */
  fileName?: string;
  /**
   * Справочник свойств из ранее загруженных частей выгрузки: Классификатор
   * приходит только в первом файле, а размер/цвет характеристик нужно
   * разворачивать и во всех следующих.
   */
  dictionary?: CatalogDictionary;
}

const ROOT = 'КоммерческаяИнформация';

/** ⚠️ Правило уточняется по итогам обследования 1С (мастердок, шаг 2.3). */
const SIZE_NAMES = new Set(['размер', 'размеры', 'size']);
const COLOR_NAMES = new Set(['цвет', 'цвета', 'color']);

const TRUE_VALUES = new Set(['true', 'истина', '1', 'да']);

function isTrue(raw: string | undefined): boolean {
  return raw !== undefined && TRUE_VALUES.has(raw.trim().toLowerCase());
}

interface GroupFrame {
  sourceId: string;
  name: string;
  isDeleted: boolean;
  parentSourceId: string | null;
  level: number;
  sortOrder: number;
}

interface PropertyFrame {
  sourceId: string;
  name: string;
  valueType: string | null;
  options: { sourceId: string; value: string }[];
  currentOption: { sourceId: string; value: string } | null;
}

interface ProductFrame {
  sourceId: string;
  article: string | null;
  name: string;
  fullName: string | null;
  description: string | null;
  baseUnit: string | null;
  brandSourceId: string | null;
  brandName: string | null;
  isDeleted: boolean;
  groups: string[];
  images: string[];
  props: { propertySourceId: string; value: string }[];
  currentProp: { propertySourceId: string; values: string[] } | null;
  chars: { name: string; value: string }[];
  currentChar: { name: string; value: string } | null;
  currentReq: { name: string; value: string } | null;
}

/**
 * Потоковый (SAX) разбор import.xml CommerceML 2.
 *
 * Принимает УЖЕ декодированный текстовый поток — декодирование делает
 * parseImportXmlFile по заголовку XML. Ничего не копит целиком: сущности
 * отдаются батчами, между чанками поток приостанавливается на время записи,
 * поэтому файл в сотни МБ проходит с постоянным расходом памяти.
 */
export async function parseImportXmlStream(
  text: Readable,
  handlers: ImportHandlers,
  opts: ParseImportOptions = {},
): Promise<{ counters: ImportCounters; meta: ImportMeta }> {
  const batchSize = opts.batchSize ?? 500;

  const counters: ImportCounters = {
    categories: 0,
    brands: 0,
    properties: 0,
    products: 0,
    variants: 0,
    images: 0,
  };
  const meta: ImportMeta = { schemaVersion: null, generatedAt: null, onlyChanges: false };
  let metaSent = false;

  const categories: CatalogCategory[] = [];
  const brands: CatalogBrand[] = [];
  const properties: CatalogProperty[] = [];
  const products: CatalogProduct[] = [];
  const variants: CatalogVariant[] = [];

  // Справочники из Классификатора — нужны, чтобы у характеристик развернуть
  // Ид значения свойства в человекочитаемый размер/цвет.
  const propertyNames = new Map(opts.dictionary?.propertyNames ?? []);
  const optionValues = new Map(opts.dictionary?.optionValues ?? []);
  const seenBrands = new Set<string>();
  let rootTag: string | null = null;

  const stack: string[] = [];
  const groupStack: GroupFrame[] = [];
  const siblingCounters: number[] = [0];
  let property: PropertyFrame | null = null;
  let product: ProductFrame | null = null;
  let inClassifierProperties = false;
  let buf = '';
  let parseError: Error | null = null;
  // Чтение через функцию: иначе TypeScript сужает тип до null, видя, что
  // присваивание происходит только внутри колбэка saxes.
  const xmlError = (): Error | null => parseError;

  const parser = new SaxesParser({ fileName: opts.fileName ?? 'import.xml' });

  const toImages = (paths: string[]): CatalogImage[] =>
    paths.map((path, sortOrder) => ({ path, sortOrder }));

  parser.on('error', (err) => {
    parseError ??= err;
  });

  parser.on('text', (chunk) => {
    buf += chunk;
  });
  parser.on('cdata', (chunk) => {
    buf += chunk;
  });

  parser.on('opentag', (tag) => {
    const parent = stack[stack.length - 1];
    rootTag ??= tag.name;
    stack.push(tag.name);
    buf = '';

    switch (tag.name) {
      case 'КоммерческаяИнформация':
        meta.schemaVersion = (tag.attributes.ВерсияСхемы as string) ?? null;
        meta.generatedAt = (tag.attributes.ДатаФормирования as string) ?? null;
        break;

      case 'Каталог':
      case 'Классификатор':
        if (isTrue(tag.attributes.СодержитТолькоИзменения as string)) meta.onlyChanges = true;
        break;

      case 'Свойства':
        if (parent === 'Классификатор') inClassifierProperties = true;
        break;

      case 'Группа':
        if (!product) {
          const depth = groupStack.length;
          siblingCounters[depth] ??= 0;
          groupStack.push({
            sourceId: '',
            name: '',
            isDeleted: false,
            parentSourceId: groupStack.at(-1)?.sourceId ?? null,
            level: depth,
            sortOrder: siblingCounters[depth]++,
          });
          siblingCounters[depth + 1] = 0;
        }
        break;

      case 'Свойство':
        if (inClassifierProperties) {
          property = { sourceId: '', name: '', valueType: null, options: [], currentOption: null };
        }
        break;

      case 'Справочник':
        if (property) property.currentOption = { sourceId: '', value: '' };
        break;

      case 'Товар':
        product = {
          sourceId: '',
          article: null,
          name: '',
          fullName: null,
          description: null,
          baseUnit: null,
          brandSourceId: null,
          brandName: null,
          isDeleted: false,
          groups: [],
          images: [],
          props: [],
          currentProp: null,
          chars: [],
          currentChar: null,
          currentReq: null,
        };
        break;

      case 'ЗначенияСвойства':
        if (product) product.currentProp = { propertySourceId: '', values: [] };
        break;

      case 'ХарактеристикаТовара':
        if (product) product.currentChar = { name: '', value: '' };
        break;

      case 'ЗначениеРеквизита':
        if (product) product.currentReq = { name: '', value: '' };
        break;

      case 'БазоваяЕдиница':
        if (product) {
          const full = tag.attributes.НаименованиеПолное as string | undefined;
          if (full) product.baseUnit = full;
        }
        break;

      default:
        break;
    }
  });

  parser.on('closetag', (tag) => {
    const name = tag.name;
    stack.pop();
    const parent = stack[stack.length - 1];
    const value = buf.trim();
    buf = '';

    // --- Классификатор: группы ---
    const group = groupStack.at(-1);
    if (group && parent === 'Группа' && !product) {
      if (name === 'Ид') group.sourceId = value;
      else if (name === 'Наименование') group.name = value;
      else if (name === 'ПометкаУдаления') group.isDeleted = isTrue(value);
    }
    if (name === 'Группа' && !product) {
      const frame = groupStack.pop();
      if (frame?.sourceId) {
        categories.push({
          sourceId: frame.sourceId,
          parentSourceId: frame.parentSourceId,
          name: frame.name,
          level: frame.level,
          sortOrder: frame.sortOrder,
          isDeleted: frame.isDeleted,
        });
        counters.categories++;
      }
      return;
    }

    // --- Классификатор: свойства ---
    if (property) {
      if (property.currentOption && parent === 'Справочник') {
        if (name === 'ИдЗначения') property.currentOption.sourceId = value;
        else if (name === 'Значение') property.currentOption.value = value;
      } else if (parent === 'Свойство') {
        if (name === 'Ид') property.sourceId = value;
        else if (name === 'Наименование') property.name = value;
        else if (name === 'ТипЗначений') property.valueType = value || null;
      }
      if (name === 'Справочник') {
        const option = property.currentOption;
        property.currentOption = null;
        if (option?.sourceId) {
          property.options.push(option);
          optionValues.set(`${property.sourceId}:${option.sourceId}`, option.value);
        }
      }
      if (name === 'Свойство') {
        const frame = property;
        property = null;
        if (frame.sourceId) {
          propertyNames.set(frame.sourceId, frame.name);
          // Ид свойства мог прийти после Справочника — чиним ключи вариантов.
          for (const option of frame.options) {
            optionValues.set(`${frame.sourceId}:${option.sourceId}`, option.value);
          }
          properties.push({
            sourceId: frame.sourceId,
            name: frame.name,
            valueType: frame.valueType,
            options: frame.options,
          });
          counters.properties++;
        }
        return;
      }
    }
    if (name === 'Свойства' && parent === 'Классификатор') {
      inClassifierProperties = false;
      return;
    }

    // --- Каталог: товары ---
    if (!product) return;

    if (parent === 'Товар') {
      switch (name) {
        case 'Ид':
          product.sourceId = value;
          break;
        case 'Артикул':
          product.article = value || null;
          break;
        case 'Наименование':
          product.name = value;
          break;
        case 'ПолноеНаименование':
          product.fullName = value || null;
          break;
        case 'Описание':
          product.description = value || null;
          break;
        case 'БазоваяЕдиница':
          product.baseUnit ??= value || null;
          break;
        case 'Картинка':
          if (value) product.images.push(value);
          break;
        case 'ПометкаУдаления':
          product.isDeleted = isTrue(value);
          break;
        case 'Статус':
          if (value.toLowerCase().startsWith('удал')) product.isDeleted = true;
          break;
        default:
          break;
      }
    } else if (parent === 'Группы' && name === 'Ид' && value) {
      product.groups.push(value);
    } else if (parent === 'Изготовитель') {
      if (name === 'Ид') product.brandSourceId = value || null;
      else if (name === 'Наименование') product.brandName = value || null;
    } else if (product.currentProp && parent === 'ЗначенияСвойства') {
      if (name === 'Ид') product.currentProp.propertySourceId = value;
      else if (name === 'Значение' && value) product.currentProp.values.push(value);
    } else if (product.currentChar && parent === 'ХарактеристикаТовара') {
      if (name === 'Наименование') product.currentChar.name = value;
      else if (name === 'Значение') product.currentChar.value = value;
    } else if (product.currentReq && parent === 'ЗначениеРеквизита') {
      if (name === 'Наименование') product.currentReq.name = value;
      else if (name === 'Значение') product.currentReq.value = value;
    }

    if (name === 'ЗначенияСвойства') {
      const frame = product.currentProp;
      product.currentProp = null;
      if (frame?.propertySourceId) {
        for (const v of frame.values) {
          product.props.push({ propertySourceId: frame.propertySourceId, value: v });
        }
      }
      return;
    }

    if (name === 'ХарактеристикаТовара') {
      const frame = product.currentChar;
      product.currentChar = null;
      if (frame?.name) product.chars.push(frame);
      return;
    }

    if (name === 'ЗначениеРеквизита') {
      const frame = product.currentReq;
      product.currentReq = null;
      if (frame?.name) {
        const key = frame.name.trim().toLowerCase();
        if (key === 'полное наименование') product.fullName ??= frame.value || null;
        else if (key === 'артикул') product.article ??= frame.value || null;
      }
      return;
    }

    if (name !== 'Товар') return;

    // --- товар собран ---
    const frame = product;
    product = null;
    if (!frame.sourceId) return;

    const hash = frame.sourceId.indexOf('#');
    if (hash > 0) {
      const characteristics: Record<string, string> = {};
      for (const ch of frame.chars) characteristics[ch.name] = ch.value;
      // Размер/цвет могут приехать и как ЗначенияСвойств характеристики —
      // разворачиваем Ид варианта значения через справочник Классификатора.
      for (const p of frame.props) {
        const propName = propertyNames.get(p.propertySourceId);
        if (!propName) continue;
        const resolved = optionValues.get(`${p.propertySourceId}:${p.value}`) ?? p.value;
        characteristics[propName] ??= resolved;
      }
      let size: string | null = null;
      let color: string | null = null;
      for (const [key, val] of Object.entries(characteristics)) {
        const norm = key.trim().toLowerCase();
        if (!size && SIZE_NAMES.has(norm)) size = val || null;
        else if (!color && COLOR_NAMES.has(norm)) color = val || null;
      }
      variants.push({
        sourceId: frame.sourceId,
        productSourceId: frame.sourceId.slice(0, hash),
        charSourceId: frame.sourceId.slice(hash + 1) || null,
        article: frame.article,
        name: frame.name || null,
        size,
        color,
        characteristics,
        isDeleted: frame.isDeleted,
        images: toImages(frame.images),
      });
      counters.variants++;
      counters.images += frame.images.length;
      return;
    }

    if (frame.brandSourceId && !seenBrands.has(frame.brandSourceId)) {
      seenBrands.add(frame.brandSourceId);
      brands.push({ sourceId: frame.brandSourceId, name: frame.brandName ?? '' });
      counters.brands++;
    }
    products.push({
      sourceId: frame.sourceId,
      article: frame.article,
      name: frame.name,
      fullName: frame.fullName,
      description: frame.description,
      brandSourceId: frame.brandSourceId,
      categorySourceIds: [...new Set(frame.groups)],
      baseUnit: frame.baseUnit,
      isDeleted: frame.isDeleted,
      properties: frame.props,
      images: toImages(frame.images),
    });
    counters.products++;
    counters.images += frame.images.length;
  });

  const pending = (): number =>
    categories.length + brands.length + properties.length + products.length + variants.length;

  const flush = async (): Promise<void> => {
    if (!metaSent) {
      metaSent = true;
      await handlers.onMeta?.(meta);
    }
    if (categories.length) await handlers.onCategories?.(categories.splice(0));
    if (brands.length) await handlers.onBrands?.(brands.splice(0));
    if (properties.length) await handlers.onProperties?.(properties.splice(0));
    if (products.length) await handlers.onProducts?.(products.splice(0));
    if (variants.length) await handlers.onVariants?.(variants.splice(0));
  };

  // Ошибки записи в хранилище наружу уходят как есть: это не дефект выгрузки,
  // и подменять их ImportParseError значит соврать в журнале (ревью, п. 14).
  try {
    for await (const chunk of text as AsyncIterable<string>) {
      parser.write(chunk);
      if (xmlError()) break;
      if (pending() >= batchSize) await flush();
    }
    // close() сообщает об обрыве документа (незакрытый корень) через onerror.
    if (!xmlError()) parser.close();
  } catch (err) {
    if (!xmlError()) {
      text.destroy();
      throw err;
    }
  }
  const failed = xmlError();
  if (failed) {
    text.destroy();
    throw new ImportParseError(failed.message);
  }

  // Корень не тот — почти всегда это несовпадение кодировки: байты
  // windows-1251, прочитанные как UTF-8, дают имена тегов из U+FFFD, которые
  // XML считает допустимыми. Без этой проверки 1С получала бы `success`
  // на нуле товаров и дальше слала только инкременты (ревью, находка 4).
  if (rootTag !== ROOT) {
    text.destroy();
    throw new ImportParseError(
      `корень документа «${rootTag ?? 'отсутствует'}» вместо «${ROOT}» — проверьте кодировку выгрузки`,
    );
  }

  await flush();

  return { counters, meta };
}

/** Разбор файла: кодировка определяется по заголовку XML (часто windows-1251). */
export async function parseImportXmlFile(
  filePath: string,
  handlers: ImportHandlers,
  opts: ParseImportOptions = {},
): Promise<{ counters: ImportCounters; meta: ImportMeta; encoding: string }> {
  const encoding = await detectFileEncoding(filePath);
  const text = createReadStream(filePath).pipe(iconv.decodeStream(encoding)) as unknown as Readable;
  const { counters, meta } = await parseImportXmlStream(text, handlers, opts);
  return { counters, meta, encoding };
}
