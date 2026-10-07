/**
 * Конструктор фикстур import.xml (CommerceML 2) — dev-утилита, не прод-код.
 * Реальной выгрузки из 1С у нас пока нет (мастердок, «Среда заказчика»):
 * до неё фикстуры собираем здесь — по структуре из скилла commerceml-exchange.
 * Используется юнит-тестами, scripts/gen-import-fixture.ts и эмулятором 1С (этап 4).
 */
import { writeFile } from 'node:fs/promises';
import iconv from 'iconv-lite';

export interface GroupSpec {
  id: string;
  name: string;
  children?: GroupSpec[];
}

export interface PropertySpec {
  id: string;
  name: string;
  valueType?: string;
  options?: { id: string; value: string }[];
}

export interface ProductSpec {
  id: string;
  name: string;
  article?: string;
  fullName?: string;
  description?: string;
  groups?: string[];
  brand?: { id: string; name: string };
  baseUnit?: string;
  images?: string[];
  /** ЗначенияСвойств: ссылки на свойства классификатора. */
  props?: { id: string; values: string[] }[];
  /** ХарактеристикиТовара: размер/цвет у товара-характеристики (Ид с «#»). */
  chars?: { name: string; value: string }[];
  deleted?: boolean;
}

export interface ImportSpec {
  schemaVersion?: string;
  generatedAt?: string;
  onlyChanges?: boolean;
  classifierId?: string;
  groups?: GroupSpec[];
  properties?: PropertySpec[];
  products?: ProductSpec[];
}

/** Строгий режим tsconfig: индекс массива может быть undefined. */
function pick<T>(items: readonly T[], index: number): T {
  const value = items[index % items.length];
  if (value === undefined) throw new Error('пустой список значений фикстуры');
  return value;
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

function renderGroups(groups: GroupSpec[], indent: string): string {
  let out = `${indent}<Группы>\n`;
  for (const g of groups) {
    out += `${indent}  <Группа>\n`;
    out += tag('Ид', g.id, `${indent}    `);
    out += tag('Наименование', g.name, `${indent}    `);
    if (g.children?.length) out += renderGroups(g.children, `${indent}    `);
    out += `${indent}  </Группа>\n`;
  }
  return out + `${indent}</Группы>\n`;
}

function renderProperties(properties: PropertySpec[], indent: string): string {
  let out = `${indent}<Свойства>\n`;
  for (const p of properties) {
    out += `${indent}  <Свойство>\n`;
    out += tag('Ид', p.id, `${indent}    `);
    out += tag('Наименование', p.name, `${indent}    `);
    out += tag('ТипЗначений', p.valueType ?? 'Справочник', `${indent}    `);
    if (p.options?.length) {
      out += `${indent}    <ВариантыЗначений>\n`;
      for (const o of p.options) {
        out += `${indent}      <Справочник>\n`;
        out += tag('ИдЗначения', o.id, `${indent}        `);
        out += tag('Значение', o.value, `${indent}        `);
        out += `${indent}      </Справочник>\n`;
      }
      out += `${indent}    </ВариантыЗначений>\n`;
    }
    out += `${indent}  </Свойство>\n`;
  }
  return out + `${indent}</Свойства>\n`;
}

function renderProduct(p: ProductSpec, indent: string): string {
  let out = `${indent}<Товар>\n`;
  const i = `${indent}  `;
  out += tag('Ид', p.id, i);
  if (p.article) out += tag('Артикул', p.article, i);
  out += tag('Наименование', p.name, i);
  if (p.fullName) out += tag('ПолноеНаименование', p.fullName, i);
  out += `${i}<БазоваяЕдиница Код="796" НаименованиеПолное="${esc(p.baseUnit ?? 'Штука')}">шт</БазоваяЕдиница>\n`;
  if (p.groups?.length) {
    out += `${i}<Группы>\n`;
    for (const g of p.groups) out += tag('Ид', g, `${i}  `);
    out += `${i}</Группы>\n`;
  }
  if (p.brand) {
    out += `${i}<Изготовитель>\n`;
    out += tag('Ид', p.brand.id, `${i}  `);
    out += tag('Наименование', p.brand.name, `${i}  `);
    out += `${i}</Изготовитель>\n`;
  }
  if (p.description) out += tag('Описание', p.description, i);
  for (const img of p.images ?? []) out += tag('Картинка', img, i);
  if (p.props?.length) {
    out += `${i}<ЗначенияСвойств>\n`;
    for (const prop of p.props) {
      out += `${i}  <ЗначенияСвойства>\n`;
      out += tag('Ид', prop.id, `${i}    `);
      for (const v of prop.values) out += tag('Значение', v, `${i}    `);
      out += `${i}  </ЗначенияСвойства>\n`;
    }
    out += `${i}</ЗначенияСвойств>\n`;
  }
  if (p.chars?.length) {
    out += `${i}<ХарактеристикиТовара>\n`;
    for (const c of p.chars) {
      out += `${i}  <ХарактеристикаТовара>\n`;
      out += tag('Наименование', c.name, `${i}    `);
      out += tag('Значение', c.value, `${i}    `);
      out += `${i}  </ХарактеристикаТовара>\n`;
    }
    out += `${i}</ХарактеристикиТовара>\n`;
  }
  if (p.deleted) out += tag('ПометкаУдаления', 'true', i);
  return out + `${indent}</Товар>\n`;
}

/** Собирает текст import.xml с объявлением кодировки windows-1251. */
export function buildImportXml(spec: ImportSpec): string {
  const classifierId = spec.classifierId ?? 'cls-1';
  const generatedAt = spec.generatedAt ?? '2026-10-07T12:00:00';
  let out = '<?xml version="1.0" encoding="windows-1251"?>\n';
  out += `<КоммерческаяИнформация ВерсияСхемы="${spec.schemaVersion ?? '2.05'}" ДатаФормирования="${generatedAt}">\n`;
  out += '  <Классификатор>\n';
  out += tag('Ид', classifierId, '    ');
  out += tag('Наименование', 'Классификатор (Каталог товаров)', '    ');
  if (spec.groups?.length) out += renderGroups(spec.groups, '    ');
  if (spec.properties?.length) out += renderProperties(spec.properties, '    ');
  out += '  </Классификатор>\n';
  out += `  <Каталог СодержитТолькоИзменения="${spec.onlyChanges ? 'true' : 'false'}">\n`;
  out += tag('Ид', 'cat-1', '    ');
  out += tag('ИдКлассификатора', classifierId, '    ');
  out += tag('Наименование', 'Каталог товаров', '    ');
  out += '    <Товары>\n';
  for (const p of spec.products ?? []) out += renderProduct(p, '      ');
  out += '    </Товары>\n';
  out += '  </Каталог>\n';
  out += '</КоммерческаяИнформация>\n';
  return out;
}

const DECLARED: Record<string, string> = { win1251: 'windows-1251', utf8: 'UTF-8' };

/**
 * Запись фикстуры (по умолчанию в windows-1251, как выгружает 1С).
 * Объявление в заголовке приводится к фактической кодировке файла — иначе
 * документ невалиден и приёмник справедливо его отвергнет.
 */
export async function writeImportXml(
  filePath: string,
  xml: string,
  encoding = 'win1251',
): Promise<void> {
  const declared = DECLARED[encoding] ?? encoding;
  const fixed = xml.replace(/(<\?xml[^>]*encoding=")[^"]*(")/, `$1${declared}$2`);
  await writeFile(filePath, iconv.encode(fixed, encoding));
}

const SIZES = ['40', '42', '44', '46', '48', '50'];
const COLORS = ['Чёрный', 'Белый', 'Бежевый', 'Синий'];
const BRANDS = [
  { id: 'brand-gw', name: 'Gerry Weber' },
  { id: 'brand-tb', name: 'Taifun' },
  { id: 'brand-sm', name: 'Samoon' },
];

/**
 * Большая выгрузка для проверки DoD: вложенные группы, свойства размер/цвет,
 * товары-модели и SKU-характеристики (Ид#ИдХарактеристики).
 */
export function generateLargeCatalog(models: number, variantsPerModel = 4): ImportSpec {
  const groups: GroupSpec[] = [
    {
      id: 'g-women',
      name: 'Женская одежда',
      children: [
        { id: 'g-women-dress', name: 'Платья' },
        {
          id: 'g-women-knit',
          name: 'Трикотаж',
          children: [{ id: 'g-women-knit-jumper', name: 'Джемперы' }],
        },
      ],
    },
    { id: 'g-men', name: 'Мужская одежда', children: [{ id: 'g-men-shirt', name: 'Рубашки' }] },
  ];
  const leaves = ['g-women-dress', 'g-women-knit-jumper', 'g-men-shirt'];
  const properties: PropertySpec[] = [
    {
      id: 'prop-size',
      name: 'Размер',
      options: SIZES.map((s, i) => ({ id: `size-${i}`, value: s })),
    },
    {
      id: 'prop-color',
      name: 'Цвет',
      options: COLORS.map((c, i) => ({ id: `color-${i}`, value: c })),
    },
  ];

  const products: ProductSpec[] = [];
  for (let n = 0; n < models; n++) {
    const id = `p-${n}`;
    const color = pick(COLORS, n);
    products.push({
      id,
      article: `ART-${String(n).padStart(6, '0')}`,
      name: `Модель ${n}`,
      fullName: `Модель ${n} (${color})`,
      description: `Описание модели ${n}`,
      groups: [pick(leaves, n)],
      brand: pick(BRANDS, n),
      images: [`import_files/${id}.jpg`],
      props: [{ id: 'prop-color', values: [`color-${n % COLORS.length}`] }],
    });
    for (let v = 0; v < variantsPerModel; v++) {
      const size = pick(SIZES, n + v);
      products.push({
        id: `${id}#ch-${v}`,
        name: `Модель ${n} (${size}, ${color})`,
        article: `ART-${String(n).padStart(6, '0')}-${size}`,
        chars: [
          { name: 'Размер', value: size },
          { name: 'Цвет', value: color },
        ],
      });
    }
  }
  return { groups, properties, products };
}
