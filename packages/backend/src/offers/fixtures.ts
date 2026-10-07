/**
 * Конструктор фикстур offers.xml (CommerceML 2) — dev-утилита, не прод-код.
 * Согласован с генератором import.xml этапа 2 (catalog/fixtures.ts): те же
 * Ид моделей/характеристик, размеры и цвета — одной парой фикстур проходится
 * полный цикл каталог + цены/остатки (тесты, эмулятор 1С, DoD этапа 3).
 */
import iconv from 'iconv-lite';
import { writeFile } from 'node:fs/promises';

export interface PriceTypeSpec {
  id: string;
  name: string;
  currency?: string;
}

export interface WarehouseSpec {
  id: string;
  name: string;
}

export interface OfferSpec {
  id: string;
  name?: string;
  article?: string;
  chars?: { name: string; value: string }[];
  /**
   * undefined — блока Цены в XML не будет вовсе («не менять»);
   * [] — пустой блок <Цены/> («цен нет»).
   */
  prices?: { priceTypeId: string; value: number | string; currency?: string }[];
  /** Общий остаток (тег Количество). undefined — тега не будет. */
  quantity?: number | string;
  /** Остатки по складам: <Склад ИдСклада=... КоличествоНаСкладе=.../>. */
  stocks?: { warehouseId: string; quantity: number | string }[];
  deleted?: boolean;
}

export interface OffersSpec {
  schemaVersion?: string;
  generatedAt?: string;
  onlyChanges?: boolean;
  packageId?: string;
  catalogId?: string;
  classifierId?: string;
  priceTypes?: PriceTypeSpec[];
  warehouses?: WarehouseSpec[];
  offers?: OfferSpec[];
}

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function tag(name: string, value: string, indent: string): string {
  return `${indent}<${name}>${esc(value)}</${name}>\n`;
}

function renderOffer(o: OfferSpec, indent: string): string {
  let out = `${indent}<Предложение>\n`;
  const i = `${indent}  `;
  out += tag('Ид', o.id, i);
  if (o.article) out += tag('Артикул', o.article, i);
  if (o.name) out += tag('Наименование', o.name, i);
  out += `${i}<БазоваяЕдиница Код="796" НаименованиеПолное="Штука">шт</БазоваяЕдиница>\n`;
  if (o.chars?.length) {
    out += `${i}<ХарактеристикиТовара>\n`;
    for (const c of o.chars) {
      out += `${i}  <ХарактеристикаТовара>\n`;
      out += tag('Наименование', c.name, `${i}    `);
      out += tag('Значение', c.value, `${i}    `);
      out += `${i}  </ХарактеристикаТовара>\n`;
    }
    out += `${i}</ХарактеристикиТовара>\n`;
  }
  if (o.prices !== undefined) {
    if (o.prices.length === 0) {
      out += `${i}<Цены/>\n`;
    } else {
      out += `${i}<Цены>\n`;
      for (const p of o.prices) {
        out += `${i}  <Цена>\n`;
        out += tag('Представление', `${p.value} ${p.currency ?? 'RUB'} за шт`, `${i}    `);
        out += tag('ИдТипаЦены', p.priceTypeId, `${i}    `);
        out += tag('ЦенаЗаЕдиницу', String(p.value), `${i}    `);
        out += tag('Валюта', p.currency ?? 'RUB', `${i}    `);
        out += tag('Единица', 'шт', `${i}    `);
        out += tag('Коэффициент', '1', `${i}    `);
        out += `${i}  </Цена>\n`;
      }
      out += `${i}</Цены>\n`;
    }
  }
  if (o.quantity !== undefined) out += tag('Количество', String(o.quantity), i);
  for (const s of o.stocks ?? []) {
    out += `${i}<Склад ИдСклада="${esc(s.warehouseId)}" КоличествоНаСкладе="${esc(String(s.quantity))}"/>\n`;
  }
  if (o.deleted) out += tag('ПометкаУдаления', 'true', i);
  return out + `${indent}</Предложение>\n`;
}

/** Собирает текст offers.xml с объявлением кодировки windows-1251. */
export function buildOffersXml(spec: OffersSpec): string {
  const generatedAt = spec.generatedAt ?? '2026-10-07T12:30:00';
  let out = '<?xml version="1.0" encoding="windows-1251"?>\n';
  out += `<КоммерческаяИнформация ВерсияСхемы="${spec.schemaVersion ?? '2.05'}" ДатаФормирования="${generatedAt}">\n`;
  out += `  <ПакетПредложений СодержитТолькоИзменения="${spec.onlyChanges ? 'true' : 'false'}">\n`;
  out += tag('Ид', spec.packageId ?? 'pack-1', '    ');
  out += tag('Наименование', 'Пакет предложений', '    ');
  out += tag('ИдКаталога', spec.catalogId ?? 'cat-1', '    ');
  out += tag('ИдКлассификатора', spec.classifierId ?? 'cls-1', '    ');
  if (spec.priceTypes?.length) {
    out += '    <ТипыЦен>\n';
    for (const t of spec.priceTypes) {
      out += '      <ТипЦены>\n';
      out += tag('Ид', t.id, '        ');
      out += tag('Наименование', t.name, '        ');
      out += tag('Валюта', t.currency ?? 'RUB', '        ');
      out += '      </ТипЦены>\n';
    }
    out += '    </ТипыЦен>\n';
  }
  if (spec.warehouses?.length) {
    out += '    <Склады>\n';
    for (const w of spec.warehouses) {
      out += '      <Склад>\n';
      out += tag('Ид', w.id, '        ');
      out += tag('Наименование', w.name, '        ');
      out += '      </Склад>\n';
    }
    out += '    </Склады>\n';
  }
  out += '    <Предложения>\n';
  for (const o of spec.offers ?? []) out += renderOffer(o, '      ');
  out += '    </Предложения>\n';
  out += '  </ПакетПредложений>\n';
  out += '</КоммерческаяИнформация>\n';
  return out;
}

const DECLARED: Record<string, string> = { win1251: 'windows-1251', utf8: 'UTF-8' };

/**
 * Запись фикстуры (по умолчанию в windows-1251, как выгружает 1С).
 * Копия writeImportXml из catalog/fixtures.ts — объявление в заголовке
 * приводится к фактической кодировке файла.
 */
export async function writeOffersXml(
  filePath: string,
  xml: string,
  encoding = 'win1251',
): Promise<void> {
  const declared = DECLARED[encoding] ?? encoding;
  const fixed = xml.replace(/(<\?xml[^>]*encoding=")[^"]*(")/, `$1${declared}$2`);
  await writeFile(filePath, iconv.encode(fixed, encoding));
}

const SIZES = ['40', '42', '44', '46', '48', '50'];

export const FIXTURE_PRICE_TYPES: PriceTypeSpec[] = [
  { id: 'pt-retail', name: 'Розничная', currency: 'RUB' },
];

/** Детерминированная розничная цена модели n — её же проверяют тесты DoD. */
export function fixturePrice(model: number): number {
  return 1990 + (model % 50) * 100;
}

/** Детерминированный остаток SKU (модель n, характеристика v). */
export function fixtureQuantity(model: number, variant: number): number {
  return (model + variant) % 12;
}

/**
 * Пакет предложений, согласованный с generateLargeCatalog(models, variants)
 * этапа 2: предложения для каждого SKU `p-N#ch-V` с ценой fixturePrice(N)
 * и остатком fixtureQuantity(N, V).
 */
export function generateLargeOffers(models: number, variantsPerModel = 4): OffersSpec {
  const offers: OfferSpec[] = [];
  for (let n = 0; n < models; n++) {
    for (let v = 0; v < variantsPerModel; v++) {
      const size = SIZES[(n + v) % SIZES.length] ?? '42';
      offers.push({
        id: `p-${n}#ch-${v}`,
        name: `Модель ${n} (${size})`,
        article: `ART-${String(n).padStart(6, '0')}-${size}`,
        chars: [{ name: 'Размер', value: size }],
        prices: [{ priceTypeId: 'pt-retail', value: fixturePrice(n) }],
        quantity: fixtureQuantity(n, v),
      });
    }
  }
  return { priceTypes: FIXTURE_PRICE_TYPES, offers };
}
