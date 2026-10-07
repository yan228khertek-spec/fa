import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryOffersRepository } from '../src/offers/memory.js';
import { importOffersFile } from '../src/offers/offers-runner.js';
import { parse1cNumber } from '../src/offers/offers-parser.js';
import { buildOffersXml, writeOffersXml, type OffersSpec } from '../src/offers/fixtures.js';

const SPEC: OffersSpec = {
  priceTypes: [
    { id: 'pt-retail', name: 'Розничная', currency: 'RUB' },
    { id: 'pt-sale', name: 'Распродажа', currency: 'RUB' },
  ],
  warehouses: [
    { id: 'wh-main', name: 'Основной склад' },
    { id: 'wh-shop', name: 'Магазин Concept' },
  ],
  offers: [
    {
      id: 'p1#ch1',
      name: 'Платье 44 Красный',
      article: 'ART-1-44',
      chars: [
        { name: 'Размер', value: '44' },
        { name: 'Цвет', value: 'Красный' },
      ],
      prices: [
        { priceTypeId: 'pt-retail', value: 4990 },
        { priceTypeId: 'pt-sale', value: '3 490,50' },
      ],
      stocks: [
        { warehouseId: 'wh-main', quantity: 3 },
        { warehouseId: 'wh-shop', quantity: '1,5' },
      ],
    },
    {
      id: 'p2',
      name: 'Ремень',
      prices: [{ priceTypeId: 'pt-retail', value: 1990 }],
      quantity: 7,
    },
  ],
};

let repo: MemoryOffersRepository;
let dir: string;

const load = async (spec: OffersSpec, name = 'offers.xml', encoding = 'win1251') => {
  const file = path.join(dir, name);
  await writeOffersXml(file, buildOffersXml(spec), encoding);
  return importOffersFile(repo, file, 'offers.xml');
};

beforeEach(async () => {
  repo = new MemoryOffersRepository();
  dir = await mkdtemp(path.join(tmpdir(), 'fa-offers-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parse1cNumber', () => {
  it.each([
    ['4990', 4990],
    ['4990.50', 4990.5],
    ['3 490,50', 3490.5],
    ['1,5', 1.5],
    ['0', 0],
    ['', null],
    ['нет', null],
  ])('%s -> %s', (raw, expected) => {
    expect(parse1cNumber(raw)).toBe(expected);
  });
});

describe('парсер offers.xml', () => {
  it('windows-1251: типы цен, склады, предложения, цены и остатки', async () => {
    const summary = await load(SPEC);

    expect(summary.encoding).toBe('win1251');
    expect(summary).toMatchObject({
      priceTypes: 2,
      warehouses: 2,
      offers: 2,
      prices: 3,
      stocks: 3,
    });

    expect(repo.priceTypes.get('pt-retail')).toMatchObject({ name: 'Розничная', currency: 'RUB' });
    expect(repo.warehouses.get('wh-shop')?.name).toBe('Магазин Concept');

    const sku = repo.offers.get('p1#ch1');
    expect(sku).toMatchObject({
      productSourceId: 'p1',
      charSourceId: 'ch1',
      article: 'ART-1-44',
      characteristics: { Размер: '44', Цвет: 'Красный' },
    });
    expect(sku?.prices).toEqual([
      { priceTypeSourceId: 'pt-retail', value: 4990, currency: 'RUB' },
      { priceTypeSourceId: 'pt-sale', value: 3490.5, currency: 'RUB' },
    ]);
    expect(sku?.stocks).toEqual([
      { warehouseSourceId: 'wh-main', quantity: 3 },
      { warehouseSourceId: 'wh-shop', quantity: 1.5 },
    ]);

    // Предложение без «#»: товар без характеристик, общий остаток — Количество.
    const plain = repo.offers.get('p2');
    expect(plain).toMatchObject({ productSourceId: 'p2', charSourceId: null });
    expect(plain?.stocks).toEqual([{ warehouseSourceId: '', quantity: 7 }]);
  });

  it('UTF-8 выгрузка разбирается по объявлению в заголовке', async () => {
    const summary = await load(SPEC, 'offers-utf8.xml', 'utf8');
    expect(summary.encoding).toBe('utf8');
    expect(repo.offers.size).toBe(2);
    expect(repo.offers.get('p1#ch1')?.characteristics['Цвет']).toBe('Красный');
  });

  it('повторная загрузка того же файла не меняет счётчики строк', async () => {
    await load(SPEC);
    const before = repo.rowCounts();
    await load(SPEC, 'offers2.xml');
    expect(repo.rowCounts()).toEqual(before);
  });

  it('СодержитТолькоИзменения попадает в шапку и журнал прогонов', async () => {
    const summary = await load({ ...SPEC, onlyChanges: true });
    expect(summary.meta.onlyChanges).toBe(true);
    expect(repo.runs[0]?.meta.onlyChanges).toBe(true);
    expect(repo.runs[0]?.status).toBe('success');
  });

  it('инкремент не затирает не-пришедшие предложения', async () => {
    await load(SPEC);
    await load(
      {
        onlyChanges: true,
        offers: [{ id: 'p1#ch1', prices: [{ priceTypeId: 'pt-retail', value: 5990 }] }],
      },
      'inc.xml',
    );

    // пришедшее — обновлено (и набор цен заменён на пришедший)
    expect(repo.offers.get('p1#ch1')?.prices).toEqual([
      { priceTypeSourceId: 'pt-retail', value: 5990, currency: 'RUB' },
    ]);
    // не-пришедшее p2 цело: и цена, и остаток
    expect(repo.offers.get('p2')?.prices).toEqual([
      { priceTypeSourceId: 'pt-retail', value: 1990, currency: 'RUB' },
    ]);
    expect(repo.offers.get('p2')?.stocks).toEqual([{ warehouseSourceId: '', quantity: 7 }]);
  });

  it('блока Цены нет вовсе — цены не трогаются; пустой <Цены/> — очищаются', async () => {
    await load(SPEC);

    // «только остатки»: тега Цены нет — цены предложения сохраняются
    await load({ onlyChanges: true, offers: [{ id: 'p1#ch1', quantity: 2 }] }, 'stock-only.xml');
    expect(repo.offers.get('p1#ch1')?.prices).toHaveLength(2);
    expect(repo.offers.get('p1#ch1')?.stocks).toEqual([{ warehouseSourceId: '', quantity: 2 }]);

    // явный пустой блок — «цен больше нет»
    await load({ onlyChanges: true, offers: [{ id: 'p1#ch1', prices: [] }] }, 'no-prices.xml');
    expect(repo.offers.get('p1#ch1')?.prices).toEqual([]);
  });

  it('инкремент «только остатки» не затирает name/article/characteristics (ревью, находка 1)', async () => {
    await load(SPEC);
    await load({ onlyChanges: true, offers: [{ id: 'p1#ch1', quantity: 2 }] }, 'stock-only.xml');

    const sku = repo.offers.get('p1#ch1');
    expect(sku?.name).toBe('Платье 44 Красный');
    expect(sku?.article).toBe('ART-1-44');
    expect(sku?.characteristics).toEqual({ Размер: '44', Цвет: 'Красный' });
    expect(sku?.isDeleted).toBe(false);
  });

  it('битый XML — прогон failure, запись с фактическими счётчиками', async () => {
    const file = path.join(dir, 'broken.xml');
    await writeOffersXml(file, buildOffersXml(SPEC).slice(0, 300));

    await expect(importOffersFile(repo, file, 'offers.xml')).rejects.toThrow();
    expect(repo.runs[0]?.status).toBe('failure');
    expect(repo.runs[0]?.error).toBeTruthy();
  });

  it('несовпадение кодировки не превращается в success нуля предложений', async () => {
    // Байты windows-1251 при объявленном UTF-8: теги из U+FFFD, корень не тот.
    const file = path.join(dir, 'bad-encoding.xml');
    const xml = buildOffersXml(SPEC).replace('windows-1251', 'UTF-8');
    const iconv = (await import('iconv-lite')).default;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, iconv.encode(xml, 'win1251'));

    await expect(importOffersFile(repo, file, 'offers.xml')).rejects.toThrow(/кодировк|корень/);
    expect(repo.offers.size).toBe(0);
  });

  it('цена с непарсибельным числом пропускается, остальные записываются', async () => {
    await load(
      {
        priceTypes: [{ id: 'pt-retail', name: 'Розничная' }],
        offers: [
          {
            id: 'p1',
            prices: [
              { priceTypeId: 'pt-retail', value: 'договорная' },
              { priceTypeId: 'pt-sale', value: 100 },
            ],
          },
        ],
      },
      'strange.xml',
    );
    expect(repo.offers.get('p1')?.prices).toEqual([
      { priceTypeSourceId: 'pt-sale', value: 100, currency: 'RUB' },
    ]);
  });
});
