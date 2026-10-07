import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import iconv from 'iconv-lite';
import { SaxesParser } from 'saxes';
import { detectFileEncoding } from '../catalog/encoding.js';
import { ImportParseError } from '../catalog/import-parser.js';
import type {
  Offer,
  OfferPrice,
  OfferPriceType,
  OfferStock,
  OfferWarehouse,
  OffersCounters,
  OffersMeta,
} from './types.js';

export interface OffersHandlers {
  onMeta?(meta: OffersMeta): void | Promise<void>;
  onPriceTypes?(items: OfferPriceType[]): Promise<void>;
  onWarehouses?(items: OfferWarehouse[]): Promise<void>;
  onOffers?(items: Offer[]): Promise<void>;
}

export interface ParseOffersOptions {
  /** Сколько сущностей накапливать до выдачи в хранилище. */
  batchSize?: number;
  /** Имя файла в сообщениях об ошибках (1С бьёт выгрузку на части). */
  fileName?: string;
}

const ROOT = 'КоммерческаяИнформация';

const TRUE_VALUES = new Set(['true', 'истина', '1', 'да']);

function isTrue(raw: string | undefined): boolean {
  return raw !== undefined && TRUE_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Число из 1С: допускаем запятую как десятичный разделитель и пробелы-разряды.
 * Непарсибельное значение — null: такая цена/остаток строкой в БД не станет,
 * но попадёт в журнал через расхождение счётчиков (сверка этапа 6).
 */
export function parse1cNumber(raw: string): number | null {
  const normalized = raw.replace(/[\s\u00a0]/gu, '').replace(',', '.');
  if (normalized === '') return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

interface PriceTypeFrame {
  sourceId: string;
  name: string;
  currency: string | null;
}

interface PriceFrame {
  priceTypeSourceId: string;
  value: number | null;
  currency: string | null;
}

interface OfferFrame {
  sourceId: string;
  article: string | null;
  name: string | null;
  isDeleted: boolean | null;
  /** null — блока ХарактеристикиТовара в предложении не было. */
  chars: { name: string; value: string }[] | null;
  currentChar: { name: string; value: string } | null;
  prices: PriceFrame[] | null;
  currentPrice: PriceFrame | null;
  stocks: OfferStock[] | null;
}

/**
 * Потоковый (SAX) разбор offers.xml CommerceML 2 — тот же каркас, что у
 * import-parser: уже декодированный текстовый поток, батчи, приостановка
 * между чанками на время записи, постоянный расход памяти.
 *
 * Структура: ПакетПредложений (@СодержитТолькоИзменения) → ТипыЦен/ТипЦены,
 * Склады/Склад, Предложения/Предложение (Ид «товар#характеристика»,
 * Характеристики, Цены/Цена, Количество, <Склад ИдСклада КоличествоНаСкладе/>).
 */
export async function parseOffersXmlStream(
  text: Readable,
  handlers: OffersHandlers,
  opts: ParseOffersOptions = {},
): Promise<{ counters: OffersCounters; meta: OffersMeta }> {
  const batchSize = opts.batchSize ?? 500;

  const counters: OffersCounters = {
    priceTypes: 0,
    warehouses: 0,
    offers: 0,
    prices: 0,
    stocks: 0,
  };
  const meta: OffersMeta = { schemaVersion: null, generatedAt: null, onlyChanges: false };
  let metaSent = false;

  const priceTypes: OfferPriceType[] = [];
  const warehouses: OfferWarehouse[] = [];
  const offers: Offer[] = [];

  const stack: string[] = [];
  let rootTag: string | null = null;
  let priceType: PriceTypeFrame | null = null;
  let warehouse: { sourceId: string; name: string } | null = null;
  let offer: OfferFrame | null = null;
  let parseError: Error | null = null;
  let buf = '';
  // Чтение через функцию: иначе TypeScript сужает тип до null, видя, что
  // присваивание происходит только внутри колбэка saxes.
  const xmlError = (): Error | null => parseError;

  const parser = new SaxesParser({ fileName: opts.fileName ?? 'offers.xml' });

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

      case 'ПакетПредложений':
      case 'ИзмененияПакетаПредложений':
        if (isTrue(tag.attributes.СодержитТолькоИзменения as string)) meta.onlyChanges = true;
        break;

      case 'ТипЦены':
        priceType = { sourceId: '', name: '', currency: null };
        break;

      case 'Склад':
        if (offer) {
          // Остаток по складу: самозакрывающийся тег с атрибутами.
          const id = (tag.attributes.ИдСклада as string) ?? '';
          const qty = parse1cNumber((tag.attributes.КоличествоНаСкладе as string) ?? '');
          if (id && qty !== null) {
            (offer.stocks ??= []).push({ warehouseSourceId: id, quantity: qty });
          }
        } else if (parent === 'Склады') {
          // Справочник складов пакета.
          warehouse = { sourceId: '', name: '' };
        }
        break;

      case 'Предложение':
        offer = {
          sourceId: '',
          article: null,
          name: null,
          isDeleted: null,
          chars: null,
          currentChar: null,
          prices: null,
          currentPrice: null,
          stocks: null,
        };
        break;

      case 'Цены':
        // Пустой блок <Цены/> — это «цен нет», а не «тега не было».
        if (offer) offer.prices ??= [];
        break;

      case 'Цена':
        if (offer) offer.currentPrice = { priceTypeSourceId: '', value: null, currency: null };
        break;

      case 'ХарактеристикиТовара':
        // Пустой блок — «характеристик нет», отсутствие блока — «не менять».
        if (offer) offer.chars ??= [];
        break;

      case 'ХарактеристикаТовара':
        if (offer) {
          offer.chars ??= [];
          offer.currentChar = { name: '', value: '' };
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

    // --- ТипыЦен ---
    if (priceType) {
      if (parent === 'ТипЦены') {
        if (name === 'Ид') priceType.sourceId = value;
        else if (name === 'Наименование') priceType.name = value;
        else if (name === 'Валюта') priceType.currency = value || null;
      }
      if (name === 'ТипЦены') {
        const frame = priceType;
        priceType = null;
        if (frame.sourceId) {
          priceTypes.push(frame);
          counters.priceTypes++;
        }
        return;
      }
    }

    // --- Склады пакета ---
    if (warehouse) {
      if (parent === 'Склад') {
        if (name === 'Ид') warehouse.sourceId = value;
        else if (name === 'Наименование') warehouse.name = value;
      }
      if (name === 'Склад') {
        const frame = warehouse;
        warehouse = null;
        if (frame.sourceId) {
          warehouses.push(frame);
          counters.warehouses++;
        }
        return;
      }
    }

    // --- Предложения ---
    if (!offer) return;

    if (parent === 'Предложение') {
      switch (name) {
        case 'Ид':
          offer.sourceId = value;
          break;
        case 'Артикул':
          offer.article = value || null;
          break;
        case 'Наименование':
          offer.name = value || null;
          break;
        case 'Количество': {
          const qty = parse1cNumber(value);
          if (qty !== null) (offer.stocks ??= []).push({ warehouseSourceId: '', quantity: qty });
          break;
        }
        case 'ПометкаУдаления':
          offer.isDeleted = isTrue(value);
          break;
        case 'Статус':
          if (value.toLowerCase().startsWith('удал')) offer.isDeleted = true;
          break;
        default:
          break;
      }
    } else if (offer.currentPrice && parent === 'Цена') {
      if (name === 'ИдТипаЦены') offer.currentPrice.priceTypeSourceId = value;
      else if (name === 'ЦенаЗаЕдиницу') offer.currentPrice.value = parse1cNumber(value);
      else if (name === 'Валюта') offer.currentPrice.currency = value || null;
    } else if (offer.currentChar && parent === 'ХарактеристикаТовара') {
      if (name === 'Наименование') offer.currentChar.name = value;
      else if (name === 'Значение') offer.currentChar.value = value;
    }

    if (name === 'Цена') {
      const frame = offer.currentPrice;
      offer.currentPrice = null;
      if (frame?.priceTypeSourceId) (offer.prices ??= []).push(frame);
      return;
    }

    if (name === 'ХарактеристикаТовара') {
      const frame = offer.currentChar;
      offer.currentChar = null;
      if (frame?.name) (offer.chars ??= []).push(frame);
      return;
    }

    if (name !== 'Предложение') return;

    // --- предложение собрано ---
    const frame = offer;
    offer = null;
    if (!frame.sourceId) return;

    const hash = frame.sourceId.indexOf('#');
    let characteristics: Record<string, string> | null = null;
    if (frame.chars) {
      characteristics = {};
      for (const ch of frame.chars) characteristics[ch.name] = ch.value;
    }

    const prices: OfferPrice[] | null = frame.prices
      ? frame.prices
          .filter((p): p is PriceFrame & { value: number } => p.value !== null)
          .map((p) => ({
            priceTypeSourceId: p.priceTypeSourceId,
            value: p.value,
            currency: p.currency,
          }))
      : null;

    offers.push({
      sourceId: frame.sourceId,
      productSourceId: hash > 0 ? frame.sourceId.slice(0, hash) : frame.sourceId,
      charSourceId: hash > 0 ? frame.sourceId.slice(hash + 1) || null : null,
      article: frame.article,
      name: frame.name,
      characteristics,
      isDeleted: frame.isDeleted,
      prices,
      stocks: frame.stocks,
    });
    counters.offers++;
    counters.prices += prices?.length ?? 0;
    counters.stocks += frame.stocks?.length ?? 0;
  });

  const pending = (): number => priceTypes.length + warehouses.length + offers.length;

  const flush = async (): Promise<void> => {
    if (!metaSent) {
      metaSent = true;
      await handlers.onMeta?.(meta);
    }
    if (priceTypes.length) await handlers.onPriceTypes?.(priceTypes.splice(0));
    if (warehouses.length) await handlers.onWarehouses?.(warehouses.splice(0));
    if (offers.length) await handlers.onOffers?.(offers.splice(0));
  };

  // Ошибки записи в хранилище наружу уходят как есть: это не дефект выгрузки,
  // и подменять их ImportParseError значит соврать в журнале.
  try {
    for await (const chunk of text as AsyncIterable<string>) {
      parser.write(chunk);
      if (xmlError()) break;
      if (pending() >= batchSize) await flush();
    }
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

  // Та же защита от несовпадения кодировки, что в import-parser (ревью этапа 2,
  // находка 4): байты win-1251, прочитанные как UTF-8, дают «валидный» XML
  // с тегами из U+FFFD — и 1С получала бы success на нуле предложений.
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
export async function parseOffersXmlFile(
  filePath: string,
  handlers: OffersHandlers,
  opts: ParseOffersOptions = {},
): Promise<{ counters: OffersCounters; meta: OffersMeta; encoding: string }> {
  const encoding = await detectFileEncoding(filePath);
  const text = createReadStream(filePath).pipe(iconv.decodeStream(encoding)) as unknown as Readable;
  const { counters, meta } = await parseOffersXmlStream(text, handlers, opts);
  return { counters, meta, encoding };
}
