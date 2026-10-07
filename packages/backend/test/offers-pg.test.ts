import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildOffersXml,
  fixturePrice,
  fixtureQuantity,
  generateLargeOffers,
  writeOffersXml,
  type OffersSpec,
} from '../src/offers/fixtures.js';
import { importOffersFile } from '../src/offers/offers-runner.js';
import { PgOffersRepository } from '../src/offers/pg.js';

/**
 * Интеграционные тесты схемы предложений против живого PostgreSQL.
 * Запускаются только при заданном TEST_DATABASE_URL (как catalog-pg.test.ts):
 *   TEST_DATABASE_URL=postgresql://fa@127.0.0.1:5432/fa_test npm test -w @fa/backend
 */
const url = process.env.TEST_DATABASE_URL;

const TABLES = [
  'offers_import_runs',
  'offer_stocks',
  'offer_prices',
  'offers',
  'warehouses',
  'price_types',
];

const SPEC: OffersSpec = {
  priceTypes: [
    { id: 'pt-retail', name: 'Розничная', currency: 'RUB' },
    { id: 'pt-sale', name: 'Распродажа', currency: 'RUB' },
  ],
  warehouses: [{ id: 'wh-main', name: 'Основной склад' }],
  offers: [
    {
      id: 'p1#ch1',
      name: 'Платье 44',
      chars: [{ name: 'Размер', value: '44' }],
      prices: [
        { priceTypeId: 'pt-retail', value: 4990 },
        { priceTypeId: 'pt-sale', value: 3490.5 },
      ],
      stocks: [{ warehouseId: 'wh-main', quantity: 3 }],
    },
    {
      id: 'p2',
      name: 'Ремень',
      prices: [{ priceTypeId: 'pt-retail', value: 1990 }],
      quantity: 7,
    },
  ],
};

describe.skipIf(!url)('PostgreSQL staging-предложения', () => {
  let pool: pg.Pool;
  let repo: PgOffersRepository;
  let dir: string;

  const count = async (table: string): Promise<number> => {
    const res = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    return Number(res.rows[0]?.n ?? 0);
  };

  const counts = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const table of TABLES) out[table] = await count(table);
    return out;
  };

  const load = async (spec: OffersSpec, name = 'offers.xml') => {
    const file = path.join(dir, name);
    await writeOffersXml(file, buildOffersXml(spec));
    return importOffersFile(repo, file, 'offers.xml');
  };

  const price = async (offer: string, type: string): Promise<string | undefined> => {
    const res = await pool.query<{ value: string }>(
      `SELECT value::text AS value FROM offer_prices
        WHERE offer_source_id = $1 AND price_type_source_id = $2`,
      [offer, type],
    );
    return res.rows[0]?.value;
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    repo = new PgOffersRepository(url as string);
    await repo.ready();
  });

  afterAll(async () => {
    await repo.close();
    await pool.end();
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fa-offers-pg-'));
    await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY`);
    return async () => {
      await rm(dir, { recursive: true, force: true });
    };
  });

  it('миграция 003 применяется идемпотентно', async () => {
    await repo.ready();
    const res = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() ORDER BY table_name`,
    );
    const present = res.rows.map((r) => r.table_name);
    for (const table of TABLES) expect(present).toContain(table);
  });

  it('первая загрузка раскладывает предложения по таблицам', async () => {
    const summary = await load(SPEC);
    expect(summary).toMatchObject({
      priceTypes: 2,
      warehouses: 1,
      offers: 2,
      prices: 3,
      stocks: 2,
    });

    expect(await counts()).toMatchObject({
      price_types: 2,
      warehouses: 1,
      offers: 2,
      offer_prices: 3,
      offer_stocks: 2,
      offers_import_runs: 1,
    });

    const sku = await pool.query(
      `SELECT product_source_id, char_source_id, characteristics FROM offers WHERE source_id = 'p1#ch1'`,
    );
    expect(sku.rows[0]).toMatchObject({
      product_source_id: 'p1',
      char_source_id: 'ch1',
      characteristics: { Размер: '44' },
    });

    expect(await price('p1#ch1', 'pt-sale')).toBe('3490.50');

    const stock = await pool.query(
      `SELECT warehouse_source_id, quantity::text AS q FROM offer_stocks WHERE offer_source_id = 'p2'`,
    );
    expect(stock.rows[0]).toMatchObject({ warehouse_source_id: '', q: '7.000' });

    const run = await pool.query(`SELECT status, offers, prices, stocks FROM offers_import_runs`);
    expect(run.rows[0]).toMatchObject({ status: 'success', offers: 2, prices: 3, stocks: 2 });
  });

  it('повторная загрузка того же файла не меняет ни строк, ни updated_at', async () => {
    await load(SPEC);
    const before = await counts();
    const stamps = await pool.query<{ o: string; p: string; s: string }>(
      `SELECT (SELECT max(updated_at)::text FROM offers) AS o,
              (SELECT max(updated_at)::text FROM offer_prices) AS p,
              (SELECT max(updated_at)::text FROM offer_stocks) AS s`,
    );

    await load(SPEC, 'offers2.xml');

    const after = await counts();
    expect({ ...after, offers_import_runs: before.offers_import_runs }).toEqual(before);
    expect(after.offers_import_runs).toBe(2);
    const again = await pool.query<{ o: string; p: string; s: string }>(
      `SELECT (SELECT max(updated_at)::text FROM offers) AS o,
              (SELECT max(updated_at)::text FROM offer_prices) AS p,
              (SELECT max(updated_at)::text FROM offer_stocks) AS s`,
    );
    expect(again.rows[0]).toEqual(stamps.rows[0]);
  });

  it('инкремент обновляет пришедшее и не затирает остальное', async () => {
    await load(SPEC);
    await load(
      {
        onlyChanges: true,
        offers: [
          {
            id: 'p1#ch1',
            prices: [{ priceTypeId: 'pt-retail', value: 5990 }],
            quantity: 1,
          },
        ],
      },
      'inc.xml',
    );

    // пришедшее: цена обновлена, исчезнувший из файла тип цены удалён,
    // остаток заменён на общий
    expect(await price('p1#ch1', 'pt-retail')).toBe('5990.00');
    expect(await price('p1#ch1', 'pt-sale')).toBeUndefined();
    const stock = await pool.query(
      `SELECT warehouse_source_id FROM offer_stocks WHERE offer_source_id = 'p1#ch1'`,
    );
    expect(stock.rows).toEqual([{ warehouse_source_id: '' }]);

    // не-пришедшее p2 цело
    expect(await price('p2', 'pt-retail')).toBe('1990.00');
    expect(await count('offers')).toBe(2);
  });

  it('выгрузка «только остатки» (без блока Цены) не трогает цены', async () => {
    await load(SPEC);
    await load({ onlyChanges: true, offers: [{ id: 'p1#ch1', quantity: 9 }] }, 'stock-only.xml');

    expect(await price('p1#ch1', 'pt-retail')).toBe('4990.00');
    expect(await price('p1#ch1', 'pt-sale')).toBe('3490.50');
    const stock = await pool.query<{ q: string }>(
      `SELECT quantity::text AS q FROM offer_stocks WHERE offer_source_id = 'p1#ch1'`,
    );
    expect(stock.rows).toEqual([{ q: '9.000' }]);
  });

  it('«только остатки» не затирает name/article/characteristics (ревью, находка 1)', async () => {
    await load(SPEC);
    const stamps = await pool.query<{ u: string }>(
      `SELECT max(updated_at)::text AS u FROM offer_prices`,
    );

    await load({ onlyChanges: true, offers: [{ id: 'p1#ch1', quantity: 9 }] }, 'stock-only.xml');

    const row = await pool.query(
      `SELECT name, article, characteristics, is_deleted FROM offers WHERE source_id = 'p1#ch1'`,
    );
    // is_deleted null = «ПометкаУдаления из 1С не приходила» (не false)
    expect(row.rows[0]).toMatchObject({
      name: 'Платье 44',
      characteristics: { Размер: '44' },
      is_deleted: null,
    });
    // цены предложения не перезаписывались даже без изменения значения
    const again = await pool.query<{ u: string }>(
      `SELECT max(updated_at)::text AS u FROM offer_prices`,
    );
    expect(again.rows[0]).toEqual(stamps.rows[0]);
  });

  it('битый файл: прогон failure, предложения не меняются', async () => {
    await load(SPEC);
    const before = await counts();
    const file = path.join(dir, 'broken.xml');
    await writeOffersXml(file, buildOffersXml(SPEC).slice(0, 300));

    await expect(importOffersFile(repo, file, 'offers.xml')).rejects.toThrow();

    const run = await pool.query<{ status: string }>(
      `SELECT status FROM offers_import_runs ORDER BY id DESC LIMIT 1`,
    );
    expect(run.rows[0]?.status).toBe('failure');
    const after = await counts();
    expect({ ...after, offers_import_runs: before.offers_import_runs }).toEqual(before);
  });

  it('DoD этапа 3: 1500 позиций, цены и остатки совпадают с фикстурой, без дублей', async () => {
    const spec = generateLargeOffers(300, 4);
    const summary = await load(spec, 'big.xml');
    expect(summary.offers).toBe(1200);
    expect(summary.durationMs).toBeLessThan(60_000);
    expect(await count('offers')).toBe(1200);
    expect(await count('offer_prices')).toBe(1200);
    expect(await count('offer_stocks')).toBe(1200);

    // точечная сверка значений с генератором фикстуры
    expect(await price('p-17#ch-2', 'pt-retail')).toBe(`${fixturePrice(17)}.00`);
    const stock = await pool.query<{ q: string }>(
      `SELECT quantity::text AS q FROM offer_stocks WHERE offer_source_id = 'p-17#ch-2'`,
    );
    expect(Number(stock.rows[0]?.q)).toBe(fixtureQuantity(17, 2));

    const before = await counts();
    await load(spec, 'big2.xml');
    const after = await counts();
    expect({ ...after, offers_import_runs: before.offers_import_runs }).toEqual(before);
  }, 120_000);
});
