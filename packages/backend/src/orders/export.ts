/**
 * Выгрузка заказов в 1С (трек F2, sale:query) — доменные типы, источник данных
 * и ЧИСТЫЙ сборщик CommerceML. Сборщик не знает про БД и HTTP: берёт снимки
 * заказов и строит XML «КоммерческаяИнформация/Документ» (ХозОперация «Заказ товара»).
 *
 * Формат — windows-1251, все значения XML-экранируются (1С чувствительна к байтам,
 * как на приёме каталога). Деньги внутри — в копейках (целые), наружу — рубли «123.45».
 */

export interface OrderExportItem {
  lineNo: number;
  /** Снимок Ид#ИдХарактеристики — ключ сопоставления с номенклатурой 1С. */
  variantSourceId: string;
  article: string | null;
  /** Снимок названия из 1С на момент заказа; fallback — витринный title. */
  name1c: string | null;
  title: string;
  size: string | null;
  color: string | null;
  priceKop: number;
  quantity: number;
  amountKop: number;
}

/** Снимок заказа для выгрузки в 1С: с полными ПД (в отличие от OrderView страницы «Спасибо»). */
export interface OrderExport {
  /** Внутренний id строки (orders.id) — ключ пометки «выгружен», НЕ едет в 1С. */
  id: string;
  /** FA-######## — Ид и Номер документа в 1С (стабильный ключ идемпотентности), НЕ публичный токен. */
  number: string;
  createdAt: Date;
  customerName: string;
  phoneNormalized: string;
  email: string;
  deliveryMethod: 'pickup' | 'cdek';
  deliveryCity: string | null;
  deliveryAddress: string | null;
  deliveryPvzCode: string | null;
  paymentMethod: 'on_receipt' | 'online';
  comment: string | null;
  currency: string;
  itemsTotalKop: number;
  deliveryCostKop: number;
  bonusAmountKop: number;
  totalKop: number;
  items: OrderExportItem[];
}

/**
 * Источник заказов для выгрузки. Реализуют PgOrderRepository и MemoryOrderRepository,
 * тот же экземпляр, что обслуживает приём заказов, — отдельного пула не заводим.
 */
export interface OrderExportSource {
  ready(): Promise<void>;
  /**
   * Невыгруженные заказы по времени создания: exported_at IS NULL AND status='new'.
   * Гостевые (user_id IS NULL) включаются наравне со всеми (инвариант 5).
   */
  listPendingExport(limit: number): Promise<OrderExport[]>;
  /**
   * Пометить заказы выгруженными (exported_at=now) идемпотентно, в транзакции.
   * Повторный вызов для уже помеченных — no-op. Возвращает число помеченных строк.
   */
  markExported(ids: string[], now?: Date): Promise<number>;
}

/** Настройки сборщика (env). Имена реквизитов — протокольные дефолты, уточняются у 1С-специалиста. */
export interface SaleExportConfig {
  /** ВерсияСхемы корня КоммерческаяИнформация. */
  schemaVersion: string;
  /** Часовой пояс для Дата/Время документа (бизнес-ТЗ заказчика — Омск/МСК). */
  timeZone: string;
  /** Наименование продавца (ИП). Пусто — контрагент-продавец в документ не выводится. */
  sellerName: string;
  /** ИНН продавца. Пусто — не выводится. */
  sellerInn: string;
  /** Максимум заказов в одной выгрузке (защита от гигантского ответа). */
  batchLimit: number;
}

export const DEFAULT_SALE_EXPORT_CONFIG: SaleExportConfig = {
  schemaVersion: '2.05',
  timeZone: 'Europe/Moscow',
  sellerName: '',
  sellerInn: '',
  batchLimit: 500,
};

/** Копейки → рубли «123.45» без плавающей точки (целочисленно). */
function kopToAmount(kop: number): string {
  const sign = kop < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(kop));
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** XML-экранирование текста и значений атрибутов: &, <, >, ", '. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Дата/время в заданном поясе: {date:'YYYY-MM-DD', time:'HH:mm:ss'}. Детерминировано.
 * Собираем из числовых частей (formatToParts), а не из локали — чтобы не зависеть
 * от наличия en-CA/en-GB в сборке ICU (small-icu дал бы другой формат даты).
 * Данные часовых поясов есть в любой сборке ICU, поэтому конвертация пояса надёжна.
 */
function formatInZone(date: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const p: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') p[part.type] = part.value;
  // hour12:false иногда даёт «24» в полночь — приводим к «00».
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}:${p.second}` };
}

const DELIVERY_LABEL: Record<OrderExport['deliveryMethod'], string> = {
  pickup: 'Самовывоз',
  cdek: 'СДЭК',
};
const PAYMENT_LABEL: Record<OrderExport['paymentMethod'], string> = {
  on_receipt: 'При получении',
  online: 'Онлайн',
};

/** <ЗначениеРеквизита> с экранированием; пустое значение пропускается, если optional. */
function requisite(name: string, value: string | null | undefined, optional = false): string {
  if (value === null || value === undefined || (optional && value === '')) return '';
  return (
    `<ЗначениеРеквизита><Наименование>${escapeXml(name)}</Наименование>` +
    `<Значение>${escapeXml(value)}</Значение></ЗначениеРеквизита>`
  );
}

function buildContractor(o: OrderExport): string {
  const contacts = [
    `<Контакт><Тип>Телефон</Тип><Значение>${escapeXml(o.phoneNormalized)}</Значение></Контакт>`,
    `<Контакт><Тип>Почта</Тип><Значение>${escapeXml(o.email)}</Значение></Контакт>`,
  ].join('');
  // Адрес — только для СДЭК и только если заполнен (самовывоз адрес не несёт).
  const addressParts = [o.deliveryCity, o.deliveryAddress].filter((p): p is string => !!p);
  const address =
    o.deliveryMethod === 'cdek' && addressParts.length
      ? `<АдресРегистрации><Представление>${escapeXml(addressParts.join(', '))}</Представление></АдресРегистрации>`
      : '';
  return (
    `<Контрагент>` +
    // Ид покупателя = нормализованный телефон (стабильный ключ; для гостя тот же).
    `<Ид>${escapeXml(o.phoneNormalized)}</Ид>` +
    `<Наименование>${escapeXml(o.customerName)}</Наименование>` +
    `<ПолноеНаименование>${escapeXml(o.customerName)}</ПолноеНаименование>` +
    `<Роль>Покупатель</Роль>` +
    `<Контакты>${contacts}</Контакты>` +
    address +
    `</Контрагент>`
  );
}

function buildItem(it: OrderExportItem): string {
  const attrs = [requisite('Размер', it.size, true), requisite('Цвет', it.color, true)].join('');
  const requisites = attrs ? `<ЗначенияРеквизитов>${attrs}</ЗначенияРеквизитов>` : '';
  return (
    `<Товар>` +
    `<Ид>${escapeXml(it.variantSourceId)}</Ид>` +
    (it.article ? `<Артикул>${escapeXml(it.article)}</Артикул>` : '') +
    `<Наименование>${escapeXml(it.name1c ?? it.title)}</Наименование>` +
    `<БазоваяЕдиница Код="796" НаименованиеПолное="Штука" МеждународноеСокращение="PCE">шт</БазоваяЕдиница>` +
    `<ЦенаЗаЕдиницу>${kopToAmount(it.priceKop)}</ЦенаЗаЕдиницу>` +
    `<Количество>${it.quantity}</Количество>` +
    `<Сумма>${kopToAmount(it.amountKop)}</Сумма>` +
    requisites +
    `</Товар>`
  );
}

function buildDocument(o: OrderExport, config: SaleExportConfig): string {
  const { date, time } = formatInZone(o.createdAt, config.timeZone);
  const seller =
    config.sellerName.trim() !== ''
      ? `<Контрагент>` +
        (config.sellerInn.trim() !== '' ? `<Ид>${escapeXml(config.sellerInn)}</Ид>` : '') +
        `<Наименование>${escapeXml(config.sellerName)}</Наименование>` +
        `<ПолноеНаименование>${escapeXml(config.sellerName)}</ПолноеНаименование>` +
        `<Роль>Продавец</Роль>` +
        (config.sellerInn.trim() !== '' ? `<ИНН>${escapeXml(config.sellerInn)}</ИНН>` : '') +
        `</Контрагент>`
      : '';
  const docRequisites = [
    requisite('Способ доставки', DELIVERY_LABEL[o.deliveryMethod]),
    requisite('Стоимость доставки', kopToAmount(o.deliveryCostKop)),
    requisite('Город доставки', o.deliveryCity, true),
    requisite('Адрес доставки', o.deliveryAddress, true),
    requisite('Код ПВЗ СДЭК', o.deliveryPvzCode, true),
    requisite('Способ оплаты', PAYMENT_LABEL[o.paymentMethod]),
    requisite('Бонус', kopToAmount(o.bonusAmountKop)),
    requisite('Итого к оплате', kopToAmount(o.totalKop)),
    requisite('Комментарий покупателя', o.comment, true),
    requisite('Номер заказа на сайте', o.number),
  ].join('');
  return (
    `<Документ>` +
    `<Ид>${escapeXml(o.number)}</Ид>` +
    `<Номер>${escapeXml(o.number)}</Номер>` +
    `<Дата>${date}</Дата>` +
    `<Время>${time}</Время>` +
    `<ХозОперация>Заказ товара</ХозОперация>` +
    `<Роль>Продавец</Роль>` +
    `<Валюта>${escapeXml(o.currency)}</Валюта>` +
    `<Курс>1</Курс>` +
    `<Сумма>${kopToAmount(o.itemsTotalKop)}</Сумма>` +
    (o.comment ? `<Комментарий>${escapeXml(o.comment)}</Комментарий>` : '') +
    `<Контрагенты>${buildContractor(o)}${seller}</Контрагенты>` +
    `<Товары>${o.items.map(buildItem).join('')}</Товары>` +
    `<ЗначенияРеквизитов>${docRequisites}</ЗначенияРеквизитов>` +
    `</Документ>`
  );
}

/**
 * Собрать ответ sale:query. Пустой список заказов → валидный ПУСТОЙ
 * КоммерческаяИнформация (1С получает корректный документ без <Документ>).
 */
export function buildSaleQueryXml(
  orders: OrderExport[],
  config: SaleExportConfig = DEFAULT_SALE_EXPORT_CONFIG,
  now: Date = new Date(),
): string {
  const { date, time } = formatInZone(now, config.timeZone);
  const head =
    `<?xml version="1.0" encoding="windows-1251"?>\n` +
    `<КоммерческаяИнформация ВерсияСхемы="${escapeXml(config.schemaVersion)}" ` +
    `ДатаФормирования="${date}T${time}">`;
  const body = orders.map((o) => buildDocument(o, config)).join('');
  return `${head}${body}</КоммерческаяИнформация>`;
}
