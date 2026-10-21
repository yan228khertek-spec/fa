import iconv from 'iconv-lite';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { resetSessions } from '../src/exchange/auth.js';
import { MemoryExchangeLog } from '../src/log/memory.js';
import { MemoryOrderRepository } from '../src/orders/memory.js';
import {
  DEFAULT_SALE_EXPORT_CONFIG,
  buildSaleQueryXml,
  escapeXml,
  type OrderExport,
} from '../src/orders/export.js';
import type { NewOrder, OrderInput, OrderLine } from '../src/orders/types.js';

// --- фикстуры снимков заказа для чистого сборщика ---

function exportOrder(over: Partial<OrderExport> = {}): OrderExport {
  const items: OrderExport['items'] = over.items ?? [
    {
      lineNo: 1,
      variantSourceId: 'guid-1#char-44',
      article: 'ART-1',
      name1c: 'Платье Gerry Weber (44)',
      title: 'Платье',
      size: '44',
      color: 'Чёрный',
      priceKop: 499000,
      quantity: 2,
      amountKop: 998000,
    },
  ];
  const itemsTotalKop = over.itemsTotalKop ?? items.reduce((s, i) => s + i.amountKop, 0);
  const deliveryCostKop = over.deliveryCostKop ?? 0;
  const bonusAmountKop = over.bonusAmountKop ?? 0;
  return {
    id: '1',
    number: 'FA-12345678',
    createdAt: new Date('2026-10-21T15:06:09Z'),
    customerName: 'Анна Иванова',
    phoneNormalized: '+79131234567',
    email: 'anna@mail.ru',
    deliveryMethod: 'pickup',
    deliveryCity: null,
    deliveryAddress: null,
    deliveryPvzCode: null,
    paymentMethod: 'on_receipt',
    comment: null,
    currency: 'RUB',
    itemsTotalKop,
    deliveryCostKop,
    bonusAmountKop,
    totalKop: itemsTotalKop + deliveryCostKop - bonusAmountKop,
    items,
    ...over,
  };
}

/** Значение реквизита документа по имени (для проверки инвариантов сумм). */
function requisiteValue(xml: string, name: string): string | undefined {
  const m = xml.match(
    new RegExp(
      `<ЗначениеРеквизита><Наименование>${name}</Наименование><Значение>([^<]*)</Значение>`,
    ),
  );
  return m?.[1];
}

describe('escapeXml', () => {
  it('экранирует все пять спецсимволов', () => {
    expect(escapeXml(`A & B < C > D " E ' F`)).toBe('A &amp; B &lt; C &gt; D &quot; E &apos; F');
  });
});

describe('buildSaleQueryXml — пустой случай', () => {
  it('нет заказов → валидный пустой КоммерческаяИнформация', () => {
    const xml = buildSaleQueryXml([]);
    expect(xml).toContain('<?xml version="1.0" encoding="windows-1251"?>');
    expect(xml).toContain('<КоммерческаяИнформация ВерсияСхемы="2.05"');
    expect(xml).toContain('</КоммерческаяИнформация>');
    expect(xml).not.toContain('<Документ>');
  });

  it('кодируется в windows-1251 без потерь и без BOM', () => {
    const buf = iconv.encode(buildSaleQueryXml([]), 'win1251');
    expect(buf[0]).not.toBe(0xef); // нет BOM
    expect(iconv.decode(buf, 'win1251')).toBe(buildSaleQueryXml([]));
  });
});

describe('buildSaleQueryXml — документ заказа', () => {
  it('собирает Документ с ключевыми полями и Товаром', () => {
    const xml = buildSaleQueryXml([exportOrder()]);
    expect(xml).toContain('<Документ>');
    // Ид и Номер документа = FA-номер (внутренний), НЕ публичный токен.
    expect(xml).toContain('<Ид>FA-12345678</Ид>');
    expect(xml).toContain('<Номер>FA-12345678</Номер>');
    expect(xml).toContain('<ХозОперация>Заказ товара</ХозОперация>');
    expect(xml).toContain('<Роль>Продавец</Роль>');
    expect(xml).toContain('<Валюта>RUB</Валюта>');
    // Контрагент-покупатель
    expect(xml).toContain('<Роль>Покупатель</Роль>');
    expect(xml).toContain('<Наименование>Анна Иванова</Наименование>');
    expect(xml).toContain('<Контакт><Тип>Телефон</Тип><Значение>+79131234567</Значение></Контакт>');
    expect(xml).toContain('<Контакт><Тип>Почта</Тип><Значение>anna@mail.ru</Значение></Контакт>');
    // Товар: Ид = снимок Ид#ИдХарактеристики
    expect(xml).toContain('<Ид>guid-1#char-44</Ид>');
    expect(xml).toContain('<ЦенаЗаЕдиницу>4990.00</ЦенаЗаЕдиницу>');
    expect(xml).toContain('<Количество>2</Количество>');
    expect(xml).toContain('<Сумма>9980.00</Сумма>');
    // Реквизиты документа
    expect(requisiteValue(xml, 'Способ доставки')).toBe('Самовывоз');
    expect(requisiteValue(xml, 'Способ оплаты')).toBe('При получении');
    expect(requisiteValue(xml, 'Бонус')).toBe('0.00');
    expect(requisiteValue(xml, 'Номер заказа на сайте')).toBe('FA-12345678');
  });

  it('дата/время документа — в часовом поясе бизнеса (Europe/Moscow)', () => {
    // 15:06:09 UTC → 18:06:09 MSK, та же дата.
    const xml = buildSaleQueryXml([exportOrder()]);
    expect(xml).toContain('<Дата>2026-10-21</Дата>');
    expect(xml).toContain('<Время>18:06:09</Время>');
  });

  it('заказ без имени токена: публичный токен нигде не фигурирует', () => {
    // В OrderExport токена нет вовсе — защита на уровне типа; проверяем, что Ид = номер.
    const xml = buildSaleQueryXml([exportOrder()]);
    expect(xml).not.toContain('token');
    expect(xml).toContain('<Ид>FA-12345678</Ид>');
  });

  it('экранирует значения (XML-инъекция невозможна)', () => {
    const xml = buildSaleQueryXml([
      exportOrder({ customerName: 'A & B <x>', comment: `</Документ><evil>` }),
    ]);
    expect(xml).toContain('<Наименование>A &amp; B &lt;x&gt;</Наименование>');
    expect(xml).toContain('&lt;evil&gt;');
    expect(xml).not.toContain('<evil>');
    // ровно один документ, инъекция не разорвала структуру
    expect(xml.match(/<Документ>/g)).toHaveLength(1);
    expect(xml.match(/<\/Документ>/g)).toHaveLength(1);
  });

  it('кириллица кодируется в windows-1251 без потерь', () => {
    const xml = buildSaleQueryXml([exportOrder({ comment: 'Позвонить перед доставкой' })]);
    const buf = iconv.encode(xml, 'win1251');
    // лоссы iconv заменяет на «?»; проверяем, что обратное декодирование совпадает
    expect(iconv.decode(buf, 'win1251')).toBe(xml);
    // 'З' из «Заказ товара» в win-1251 = 0xC7
    expect(buf.includes(0xc7)).toBe(true);
  });

  it('СДЭК: адрес покупателя и реквизиты доставки', () => {
    const xml = buildSaleQueryXml([
      exportOrder({
        deliveryMethod: 'cdek',
        deliveryCity: 'Омск',
        deliveryAddress: 'ул. Ленина, 10',
        deliveryPvzCode: 'OMS42',
        deliveryCostKop: 50000,
      }),
    ]);
    expect(xml).toContain(
      '<АдресРегистрации><Представление>Омск, ул. Ленина, 10</Представление></АдресРегистрации>',
    );
    expect(requisiteValue(xml, 'Способ доставки')).toBe('СДЭК');
    expect(requisiteValue(xml, 'Город доставки')).toBe('Омск');
    expect(requisiteValue(xml, 'Адрес доставки')).toBe('ул. Ленина, 10');
    expect(requisiteValue(xml, 'Код ПВЗ СДЭК')).toBe('OMS42');
    expect(requisiteValue(xml, 'Стоимость доставки')).toBe('500.00');
  });

  it('самовывоз: адрес покупателя не выводится', () => {
    const xml = buildSaleQueryXml([exportOrder({ deliveryMethod: 'pickup' })]);
    expect(xml).not.toContain('<АдресРегистрации>');
    expect(requisiteValue(xml, 'Способ доставки')).toBe('Самовывоз');
  });

  it('инвариант сумм: Сумма документа = items_total, Итого = items_total + доставка − бонус', () => {
    const xml = buildSaleQueryXml([
      exportOrder({
        items: [
          {
            lineNo: 1,
            variantSourceId: 'g#1',
            article: null,
            name1c: null,
            title: 'Товар',
            size: null,
            color: null,
            priceKop: 100000,
            quantity: 3,
            amountKop: 300000,
          },
        ],
        deliveryCostKop: 50000,
        bonusAmountKop: 20000,
        // total = 3000 + 500 − 200 = 3300
        totalKop: 330000,
      }),
    ]);
    expect(xml).toContain('<Сумма>3000.00</Сумма>'); // документ: сумма строк Товаров
    expect(requisiteValue(xml, 'Стоимость доставки')).toBe('500.00');
    expect(requisiteValue(xml, 'Бонус')).toBe('200.00');
    expect(requisiteValue(xml, 'Итого к оплате')).toBe('3300.00');
  });

  it('несколько заказов → несколько Документов по порядку', () => {
    const xml = buildSaleQueryXml([
      exportOrder({ id: '1', number: 'FA-00000001' }),
      exportOrder({ id: '2', number: 'FA-00000002' }),
    ]);
    expect(xml.match(/<Документ>/g)).toHaveLength(2);
    expect(xml.indexOf('FA-00000001')).toBeLessThan(xml.indexOf('FA-00000002'));
  });

  it('продавец выводится только если задан в конфиге', () => {
    const withSeller = buildSaleQueryXml([exportOrder()], {
      ...DEFAULT_SALE_EXPORT_CONFIG,
      sellerName: 'ИП Астафьев Константин Валентинович',
      sellerInn: '550700629713',
    });
    expect(withSeller).toContain(
      '<Наименование>ИП Астафьев Константин Валентинович</Наименование>',
    );
    expect(withSeller).toContain('<ИНН>550700629713</ИНН>');
    // по умолчанию (пустой sellerName) контрагент-продавец не выводится
    expect(buildSaleQueryXml([exportOrder()])).not.toContain('<ИНН>');
  });
});

// --- MemoryOrderRepository: очередь и пометка ---

const customer: OrderInput['customer'] = {
  name: 'Анна',
  phone: '8 (913) 123-45-67',
  phoneNormalized: '+79131234567',
  email: 'anna@mail.ru',
};
const line: OrderLine = {
  lineNo: 1,
  cardId: 9,
  modelId: 'guid-1',
  variantId: 'guid-1#char-44',
  article: 'ART-1',
  title: 'Платье',
  name1c: 'Платье (44)',
  size: '44',
  color: null,
  priceKop: 499000,
  quantity: 1,
  amountKop: 499000,
};

function makeOrder(over: Partial<NewOrder> = {}): NewOrder {
  const input: OrderInput = {
    customer,
    delivery: { method: 'pickup', city: null, address: null, pvzCode: null },
    payment: { method: 'on_receipt' },
    comment: null,
    items: [{ cardId: 9, variantId: line.variantId, quantity: 1, priceKop: 499000 }],
    expectedTotalKop: null,
    consents: { personalData: true, marketing: false },
    ...over.input,
  };
  return {
    number: over.number ?? `FA-${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`,
    publicToken:
      over.publicToken ?? Math.random().toString(36).slice(2).padEnd(43, 'x').slice(0, 43),
    idempotencyKey: over.idempotencyKey ?? Math.random().toString(36).slice(2),
    requestHash: 'hash',
    input,
    lines: over.lines ?? [line],
    itemsTotalKop: 499000,
    deliveryCostKop: 0,
    bonusAmountKop: 0,
    totalKop: 499000,
    pdPolicyVersion: 'draft-2026-10',
    offerVersion: 'draft-2026-10',
    marketingConsentVersion: 'draft-2026-10',
    clientIp: null,
    userAgent: null,
    ...over,
  };
}

describe('MemoryOrderRepository — выгрузка', () => {
  it('listPendingExport возвращает невыгруженные, markExported помечает идемпотентно', async () => {
    const repo = new MemoryOrderRepository();
    await repo.create(makeOrder({ number: 'FA-00000001', idempotencyKey: 'k1' }));
    await repo.create(makeOrder({ number: 'FA-00000002', idempotencyKey: 'k2' }));

    const pending = await repo.listPendingExport(100);
    expect(pending.map((o) => o.number)).toEqual(['FA-00000001', 'FA-00000002']);
    expect(pending[0]!.items[0]!.variantSourceId).toBe('guid-1#char-44');

    const marked = await repo.markExported([pending[0]!.id]);
    expect(marked).toBe(1);

    const rest = await repo.listPendingExport(100);
    expect(rest.map((o) => o.number)).toEqual(['FA-00000002']);

    // повторная пометка той же пачки — no-op
    expect(await repo.markExported([pending[0]!.id])).toBe(0);
  });
});

// --- Рукопожатие query→success на HTTP-слое ---

const LOGIN = 'site';
const PASSWORD = 'secret-1c';
const basic = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');

function cfg(): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    exchangeLogin: LOGIN,
    exchangePassword: PASSWORD,
    fileLimit: 1024 * 1024,
    spoolDir: '/tmp/fa-sale-spool',
    mediaDir: '/tmp/fa-sale-media',
    importWaitMs: 1000,
    unpackLimit: 64 * 1024 * 1024,
    databaseUrl: undefined,
    quiet: true,
  };
}

let app: FastifyInstance;
let logSink: MemoryExchangeLog;
let orderRepo: MemoryOrderRepository;

async function cookieHeader(): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/1c-exchange?type=catalog&mode=checkauth',
    headers: { authorization: basic },
  });
  const [, name, value] = res.body.split('\n');
  return `${name}=${value}`;
}

function saleQuery(cookie: string) {
  return app.inject({
    method: 'GET',
    url: '/api/1c-exchange?type=sale&mode=query',
    headers: { cookie },
  });
}
function saleSuccess(cookie: string) {
  return app.inject({
    method: 'GET',
    url: '/api/1c-exchange?type=sale&mode=success',
    headers: { cookie },
  });
}

describe('sale:query/success — рукопожатие и идемпотентность', () => {
  beforeEach(async () => {
    resetSessions();
    logSink = new MemoryExchangeLog();
    orderRepo = new MemoryOrderRepository();
    app = await buildApp({ config: cfg(), logSink, orderRepo });
  });
  afterEach(async () => {
    await app.close();
  });

  it('query отдаёт заказ, success его помечает, повторный query — пустой', async () => {
    await orderRepo.create(makeOrder({ number: 'FA-10000001', idempotencyKey: 'a' }));
    const cookie = await cookieHeader();

    const q1 = await saleQuery(cookie);
    expect(q1.headers['content-type']).toBe('text/xml; charset=windows-1251');
    const xml1 = iconv.decode(q1.rawPayload, 'win1251');
    expect(xml1).toContain('<Номер>FA-10000001</Номер>');

    const s1 = await saleSuccess(cookie);
    expect(iconv.decode(s1.rawPayload, 'win1251')).toBe('success');

    const q2 = await saleQuery(cookie);
    const xml2 = iconv.decode(q2.rawPayload, 'win1251');
    expect(xml2).not.toContain('<Документ>');
    expect(xml2).toContain('</КоммерческаяИнформация>');
  });

  it('query без success → следующий query шлёт заказ снова (нет потери)', async () => {
    await orderRepo.create(makeOrder({ number: 'FA-10000002', idempotencyKey: 'b' }));
    const cookie = await cookieHeader();

    const first = iconv.decode((await saleQuery(cookie)).rawPayload, 'win1251');
    expect(first).toContain('FA-10000002');
    // success не пришёл — повторный query шлёт снова
    const again = iconv.decode((await saleQuery(cookie)).rawPayload, 'win1251');
    expect(again).toContain('FA-10000002');
  });

  it('success до query ничего не ломает (пачки нет — no-op)', async () => {
    const cookie = await cookieHeader();
    const s = await saleSuccess(cookie);
    expect(iconv.decode(s.rawPayload, 'win1251')).toBe('success');
    expect(logSink.entries.at(-1)).toMatchObject({
      type: 'sale',
      mode: 'success',
      detail: 'exported 0',
    });
  });

  it('success помечает только пачку последнего query, а не заказы из зазора', async () => {
    await orderRepo.create(makeOrder({ number: 'FA-10000003', idempotencyKey: 'c' }));
    const cookie = await cookieHeader();
    await saleQuery(cookie); // пачка = [c]
    // заказ пришёл В ЗАЗОРЕ между query и success
    await orderRepo.create(makeOrder({ number: 'FA-10000004', idempotencyKey: 'd' }));
    await saleSuccess(cookie); // помечает только c

    const xml = iconv.decode((await saleQuery(cookie)).rawPayload, 'win1251');
    expect(xml).not.toContain('FA-10000003'); // уже выгружен
    expect(xml).toContain('FA-10000004'); // из зазора — всё ещё в очереди
  });

  it('каждый sale-запрос попадает в exchange_log', async () => {
    const cookie = await cookieHeader();
    await saleQuery(cookie);
    await saleSuccess(cookie);
    const sale = logSink.entries.filter((e) => e.type === 'sale');
    expect(sale.map((e) => e.mode)).toEqual(['query', 'success']);
    expect(sale.every((e) => e.result === 'success')).toBe(true);
  });

  it('sale:query без сессии — failure', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/1c-exchange?type=sale&mode=query' });
    expect(res.body.startsWith('failure')).toBe(true);
  });
});
