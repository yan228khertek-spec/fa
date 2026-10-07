import pg from 'pg';
import { SOURCE, column, dedupe, insertFromArrays, syncChildren, KEY_SEP } from '../db/upsert.js';
import { OFFERS_DDL } from './schema.js';
import type {
  Offer,
  OfferPriceType,
  OfferWarehouse,
  OffersFinishRun,
  OffersMeta,
  OffersRepository,
} from './types.js';

/**
 * Staging-предложения в PostgreSQL. Каждый батч — одна транзакция, записи
 * идемпотентны по Ид предложения (Ид#ИдХарактеристики для SKU).
 *
 * Инкрементальная семантика (DoD этапа 3): предложение, ПРИШЕДШЕЕ в файле,
 * несёт полный актуальный набор своих цен/остатков — его дочерние строки
 * синхронизируются (вставка/обновление/удаление исчезнувших). Предложение,
 * которого в файле НЕТ, не трогается вовсе. Если у пришедшего предложения
 * блок Цены или Количество/Склад отсутствовал (prices/stocks === null),
 * его существующие цены/остатки тоже не трогаются: 1С штатно шлёт отдельные
 * выгрузки «только цены» и «только остатки».
 */
export class PgOffersRepository implements OffersRepository {
  private pool: pg.Pool;
  private prepared: Promise<void> | null = null;

  constructor(databaseUrl: string, poolSize = 4) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: poolSize });
  }

  ready(): Promise<void> {
    // Неудачный DDL не кэшируем: иначе мигнувшая при старте БД оставляет
    // все последующие импорты падать до рестарта (ревью этапа 3, находка 3).
    this.prepared ??= this.pool.query(OFFERS_DDL).then(
      () => undefined,
      (err: unknown) => {
        this.prepared = null;
        throw err;
      },
    );
    return this.prepared;
  }

  private async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertPriceTypes(items: OfferPriceType[]): Promise<void> {
    const rows = dedupe(items, (i) => i.sourceId);
    if (rows.length === 0) return;
    const q = insertFromArrays(
      'price_types',
      [
        column(
          'source',
          'text',
          rows.map(() => SOURCE),
        ),
        column(
          'source_id',
          'text',
          rows.map((t) => t.sourceId),
        ),
        column(
          'name',
          'text',
          rows.map((t) => t.name),
        ),
        column(
          'currency',
          'text',
          rows.map((t) => t.currency),
        ),
      ],
      ['source', 'source_id'],
      ['name', 'currency'],
      true,
    );
    await this.tx((client) => client.query(q.text, q.params));
  }

  async upsertWarehouses(items: OfferWarehouse[]): Promise<void> {
    const rows = dedupe(items, (i) => i.sourceId);
    if (rows.length === 0) return;
    const q = insertFromArrays(
      'warehouses',
      [
        column(
          'source',
          'text',
          rows.map(() => SOURCE),
        ),
        column(
          'source_id',
          'text',
          rows.map((w) => w.sourceId),
        ),
        column(
          'name',
          'text',
          rows.map((w) => w.name),
        ),
      ],
      ['source', 'source_id'],
      ['name'],
      true,
    );
    await this.tx((client) => client.query(q.text, q.params));
  }

  async upsertOffers(items: Offer[]): Promise<void> {
    const rows = dedupe(items, (i) => i.sourceId);
    if (rows.length === 0) return;
    const q = insertFromArrays(
      'offers',
      [
        column(
          'source',
          'text',
          rows.map(() => SOURCE),
        ),
        column(
          'source_id',
          'text',
          rows.map((o) => o.sourceId),
        ),
        column(
          'product_source_id',
          'text',
          rows.map((o) => o.productSourceId),
        ),
        column(
          'char_source_id',
          'text',
          rows.map((o) => o.charSourceId),
        ),
        column(
          'article',
          'text',
          rows.map((o) => o.article),
        ),
        column(
          'name',
          'text',
          rows.map((o) => o.name),
        ),
        column(
          'characteristics',
          'jsonb',
          rows.map((o) => (o.characteristics === null ? null : JSON.stringify(o.characteristics))),
        ),
        column(
          'is_deleted',
          'boolean',
          rows.map((o) => o.isDeleted),
        ),
      ],
      ['source', 'source_id'],
      ['product_source_id', 'char_source_id', 'article', 'name', 'characteristics', 'is_deleted'],
      true,
      // NULL = «тега в файле не было» → оставить существующее значение
      // (инкремент «только остатки»; ревью этапа 3, находка 1).
      ['article', 'name', 'characteristics', 'is_deleted'],
    );

    // Дочерние строки синхронизируются ТОЛЬКО для предложений, у которых
    // соответствующий блок был в файле (см. комментарий класса).
    const withPrices = rows.filter((o) => o.prices !== null);
    const withStocks = rows.filter((o) => o.stocks !== null);

    await this.tx(async (client) => {
      await client.query(q.text, q.params);

      await syncChildren(
        client,
        {
          table: 'offer_prices',
          ownerCol: 'offer_source_id',
          keyCols: ['price_type_source_id'],
          valueCols: ['value', 'currency'],
          valueTypes: { value: 'numeric' },
          touch: true,
        },
        withPrices.map((o) => o.sourceId),
        dedupe(
          withPrices.flatMap((o) =>
            (o.prices ?? []).map((p) => ({
              offer_source_id: o.sourceId,
              price_type_source_id: p.priceTypeSourceId,
              value: p.value,
              currency: p.currency,
            })),
          ),
          (r) => `${r.offer_source_id}${KEY_SEP}${r.price_type_source_id}`,
        ),
      );

      await syncChildren(
        client,
        {
          table: 'offer_stocks',
          ownerCol: 'offer_source_id',
          keyCols: ['warehouse_source_id'],
          valueCols: ['quantity'],
          valueTypes: { quantity: 'numeric' },
          touch: true,
        },
        withStocks.map((o) => o.sourceId),
        dedupe(
          withStocks.flatMap((o) =>
            (o.stocks ?? []).map((s) => ({
              offer_source_id: o.sourceId,
              warehouse_source_id: s.warehouseSourceId,
              quantity: s.quantity,
            })),
          ),
          (r) => `${r.offer_source_id}${KEY_SEP}${r.warehouse_source_id}`,
        ),
      );
    });
  }

  async startRun(filename: string, meta: OffersMeta): Promise<number | null> {
    await this.ready();
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO offers_import_runs (filename, schema_version, generated_at, only_changes)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [filename, meta.schemaVersion, meta.generatedAt, meta.onlyChanges],
    );
    const id = res.rows[0]?.id;
    return id === undefined ? null : Number(id);
  }

  async finishRun(runId: number | null, result: OffersFinishRun): Promise<void> {
    if (runId === null) return;
    const { counters, meta, status, error } = result;
    await this.pool.query(
      `UPDATE offers_import_runs
          SET finished_at = now(), status = $2, error = $3,
              schema_version = coalesce($4, schema_version),
              generated_at = coalesce($5, generated_at),
              only_changes = $6,
              price_types = $7, warehouses = $8, offers = $9, prices = $10, stocks = $11
        WHERE id = $1`,
      [
        runId,
        status,
        error ?? null,
        meta.schemaVersion,
        meta.generatedAt,
        meta.onlyChanges,
        counters.priceTypes,
        counters.warehouses,
        counters.offers,
        counters.prices,
        counters.stocks,
      ],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
