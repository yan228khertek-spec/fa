import pg from 'pg';
import { CATALOG_DDL } from './schema.js';
import type {
  CatalogBrand,
  CatalogCategory,
  CatalogDictionary,
  CatalogProduct,
  CatalogProperty,
  CatalogRepository,
  CatalogVariant,
  FinishRun,
  ImportMeta,
} from './types.js';

const SOURCE = '1c';

/**
 * Разделитель составного ключа при сверке дочерних строк. NUL в text
 * PostgreSQL недопустим, поэтому берём управляющий символ, которого не бывает
 * в Ид из 1С.
 */
const KEY_SEP = '\u001f';
const KEY_SEP_SQL = String.raw`E'\x1f'`;

type Cell = string | number | boolean | null;

interface Column {
  name: string;
  type: string;
  values: Cell[];
}

function column(name: string, type: string, values: Cell[]): Column {
  return { name, type, values };
}

function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(key(item), item);
  return [...byKey.values()];
}

/** SET-часть upsert'а + WHERE «обновляй только если реально изменилось». */
function updateOnlyIfChanged(table: string, cols: string[], touch: boolean): string {
  const set = cols.map((c) => `${c} = EXCLUDED.${c}`);
  if (touch) set.push('updated_at = now()');
  const left = cols.map((c) => `${table}.${c}`).join(', ');
  const right = cols.map((c) => `EXCLUDED.${c}`).join(', ');
  return `DO UPDATE SET ${set.join(', ')} WHERE (${left}) IS DISTINCT FROM (${right})`;
}

/**
 * INSERT из массивов через unnest: на запрос уходит столько параметров,
 * сколько колонок, а не колонок × строк. Иначе батч из 500 товаров с десятками
 * значений свойств пробивает лимит протокола PostgreSQL (65535 параметров) и
 * вся выгрузка падает — ревью этапа 2, находка 1.
 */
function insertFromArrays(
  table: string,
  cols: Column[],
  conflictCols: string[],
  updateCols: string[],
  touch: boolean,
): { text: string; params: unknown[] } {
  const names = cols.map((c) => c.name).join(', ');
  const arrays = cols.map((c, i) => `$${i + 1}::${c.type}[]`).join(', ');
  const conflict = updateCols.length ? updateOnlyIfChanged(table, updateCols, touch) : 'DO NOTHING';
  return {
    text: `INSERT INTO ${table} (${names})
             SELECT ${names} FROM unnest(${arrays}) AS s(${names})
           ON CONFLICT (${conflictCols.join(', ')}) ${conflict}`,
    params: cols.map((c) => c.values),
  };
}

interface ChildSpec {
  table: string;
  /** Фиксированные колонки ключа, одинаковые для всего батча. */
  fixed?: Record<string, string>;
  ownerCol: string;
  keyCols: string[];
  valueCols?: string[];
  valueTypes?: Record<string, string>;
  touch?: boolean;
}

/**
 * Синхронизирует дочерние строки для набора владельцев: вставляет пришедшие,
 * обновляет изменившиеся, удаляет исчезнувшие. Все ключевые колонки входят в
 * первичный ключ и серийных id нет, поэтому повторная загрузка того же файла
 * не меняет ни одной строки — идемпотентность по счётчикам сохраняется.
 */
async function syncChildren(
  client: pg.PoolClient,
  spec: ChildSpec,
  owners: string[],
  rows: Record<string, Cell>[],
): Promise<void> {
  if (owners.length === 0) return;
  const fixed = spec.fixed ?? {};
  const fixedCols = Object.keys(fixed);
  const keyCols = ['source', ...fixedCols, spec.ownerCol, ...spec.keyCols];
  const valueCols = spec.valueCols ?? [];

  if (rows.length > 0) {
    const cols: Column[] = [
      column(
        'source',
        'text',
        rows.map(() => SOURCE),
      ),
      ...fixedCols.map((c) =>
        column(
          c,
          'text',
          rows.map(() => fixed[c] ?? null),
        ),
      ),
      column(
        spec.ownerCol,
        'text',
        rows.map((r) => r[spec.ownerCol] ?? null),
      ),
      ...spec.keyCols.map((c) =>
        column(
          c,
          'text',
          rows.map((r) => r[c] ?? null),
        ),
      ),
      ...valueCols.map((c) =>
        column(
          c,
          spec.valueTypes?.[c] ?? 'text',
          rows.map((r) => r[c] ?? null),
        ),
      ),
    ];
    const q = insertFromArrays(spec.table, cols, keyCols, valueCols, spec.touch ?? false);
    await client.query(q.text, q.params);
  }

  // Удаляем исчезнувшее: набор «оставить» уходит одним text[]-параметром,
  // поэтому размер батча на число параметров запроса не влияет.
  const identity = [spec.ownerCol, ...spec.keyCols];
  const keep = rows.map((r) => identity.map((c) => String(r[c] ?? '')).join(KEY_SEP));
  const params: unknown[] = [SOURCE];
  const where = ['t.source = $1'];
  for (const col of fixedCols) {
    params.push(fixed[col]);
    where.push(`t.${col} = $${params.length}`);
  }
  params.push(owners);
  where.push(`t.${spec.ownerCol} = ANY($${params.length}::text[])`);
  params.push(keep);
  const expr = identity.map((c) => `t.${c}`).join(` || ${KEY_SEP_SQL} || `);
  where.push(`(${expr}) <> ALL($${params.length}::text[])`);
  await client.query(`DELETE FROM ${spec.table} t WHERE ${where.join(' AND ')}`, params);
}

/**
 * Staging-каталог в PostgreSQL. Каждый батч — одна транзакция, записи
 * идемпотентны по Ид из 1С (и Ид#ИдХарактеристики для SKU).
 * DDL (миграция 002) применяется один раз в ready().
 */
export class PgCatalogRepository implements CatalogRepository {
  private pool: pg.Pool;
  private prepared: Promise<void> | null = null;

  constructor(databaseUrl: string, poolSize = 4) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: poolSize });
  }

  ready(): Promise<void> {
    this.prepared ??= this.pool.query(CATALOG_DDL).then(() => undefined);
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

  async upsertCategories(items: CatalogCategory[]): Promise<void> {
    const rows = dedupe(items, (i) => i.sourceId);
    if (rows.length === 0) return;
    const q = insertFromArrays(
      'categories',
      [
        column(
          'source',
          'text',
          rows.map(() => SOURCE),
        ),
        column(
          'source_id',
          'text',
          rows.map((c) => c.sourceId),
        ),
        column(
          'parent_source_id',
          'text',
          rows.map((c) => c.parentSourceId),
        ),
        column(
          'name',
          'text',
          rows.map((c) => c.name),
        ),
        column(
          'level',
          'integer',
          rows.map((c) => c.level),
        ),
        column(
          'sort_order',
          'integer',
          rows.map((c) => c.sortOrder),
        ),
        column(
          'is_deleted',
          'boolean',
          rows.map((c) => c.isDeleted ?? false),
        ),
      ],
      ['source', 'source_id'],
      ['parent_source_id', 'name', 'level', 'sort_order', 'is_deleted'],
      true,
    );
    await this.tx((client) => client.query(q.text, q.params));
  }

  async upsertBrands(items: CatalogBrand[]): Promise<void> {
    const rows = dedupe(items, (i) => i.sourceId);
    if (rows.length === 0) return;
    const q = insertFromArrays(
      'brands',
      [
        column(
          'source',
          'text',
          rows.map(() => SOURCE),
        ),
        column(
          'source_id',
          'text',
          rows.map((b) => b.sourceId),
        ),
        column(
          'name',
          'text',
          rows.map((b) => b.name),
        ),
      ],
      ['source', 'source_id'],
      ['name'],
      true,
    );
    await this.tx((client) => client.query(q.text, q.params));
  }

  async upsertProperties(items: CatalogProperty[]): Promise<void> {
    const rows = dedupe(items, (i) => i.sourceId);
    if (rows.length === 0) return;
    const q = insertFromArrays(
      'properties',
      [
        column(
          'source',
          'text',
          rows.map(() => SOURCE),
        ),
        column(
          'source_id',
          'text',
          rows.map((p) => p.sourceId),
        ),
        column(
          'name',
          'text',
          rows.map((p) => p.name),
        ),
        column(
          'value_type',
          'text',
          rows.map((p) => p.valueType),
        ),
      ],
      ['source', 'source_id'],
      ['name', 'value_type'],
      true,
    );
    await this.tx(async (client) => {
      await client.query(q.text, q.params);
      const options = rows.flatMap((prop) =>
        prop.options.map((o) => ({
          property_source_id: prop.sourceId,
          source_id: o.sourceId,
          value: o.value,
        })),
      );
      await syncChildren(
        client,
        {
          table: 'property_options',
          ownerCol: 'property_source_id',
          keyCols: ['source_id'],
          valueCols: ['value'],
          touch: true,
        },
        rows.map((prop) => prop.sourceId),
        dedupe(options, (o) => `${o.property_source_id}${KEY_SEP}${o.source_id}`),
      );
    });
  }

  async upsertProducts(items: CatalogProduct[]): Promise<void> {
    const rows = dedupe(items, (i) => i.sourceId);
    if (rows.length === 0) return;
    const owners = rows.map((r) => r.sourceId);
    const q = insertFromArrays(
      'products',
      [
        column(
          'source',
          'text',
          rows.map(() => SOURCE),
        ),
        column(
          'source_id',
          'text',
          rows.map((p) => p.sourceId),
        ),
        column(
          'article',
          'text',
          rows.map((p) => p.article),
        ),
        column(
          'name',
          'text',
          rows.map((p) => p.name),
        ),
        column(
          'full_name',
          'text',
          rows.map((p) => p.fullName),
        ),
        column(
          'description',
          'text',
          rows.map((p) => p.description),
        ),
        column(
          'brand_source_id',
          'text',
          rows.map((p) => p.brandSourceId),
        ),
        column(
          'category_source_id',
          'text',
          rows.map((p) => p.categorySourceIds[0] ?? null),
        ),
        column(
          'base_unit',
          'text',
          rows.map((p) => p.baseUnit),
        ),
        column(
          'is_deleted',
          'boolean',
          rows.map((p) => p.isDeleted),
        ),
      ],
      ['source', 'source_id'],
      [
        'article',
        'name',
        'full_name',
        'description',
        'brand_source_id',
        'category_source_id',
        'base_unit',
        'is_deleted',
      ],
      true,
    );
    await this.tx(async (client) => {
      await client.query(q.text, q.params);

      await syncChildren(
        client,
        {
          table: 'product_categories',
          ownerCol: 'product_source_id',
          keyCols: ['category_source_id'],
        },
        owners,
        rows.flatMap((prod) =>
          prod.categorySourceIds.map((id) => ({
            product_source_id: prod.sourceId,
            category_source_id: id,
          })),
        ),
      );

      await syncChildren(
        client,
        {
          table: 'product_properties',
          ownerCol: 'product_source_id',
          keyCols: ['property_source_id', 'value_raw'],
        },
        owners,
        dedupe(
          rows.flatMap((prod) =>
            prod.properties.map((pv) => ({
              product_source_id: prod.sourceId,
              property_source_id: pv.propertySourceId,
              value_raw: pv.value,
            })),
          ),
          (r) => `${r.product_source_id}${KEY_SEP}${r.property_source_id}${KEY_SEP}${r.value_raw}`,
        ),
      );

      await this.syncImages(client, 'product', owners, rows);
    });
  }

  async upsertVariants(items: CatalogVariant[]): Promise<void> {
    const rows = dedupe(items, (i) => i.sourceId);
    if (rows.length === 0) return;
    const owners = rows.map((r) => r.sourceId);
    const q = insertFromArrays(
      'product_variants',
      [
        column(
          'source',
          'text',
          rows.map(() => SOURCE),
        ),
        column(
          'source_id',
          'text',
          rows.map((v) => v.sourceId),
        ),
        column(
          'product_source_id',
          'text',
          rows.map((v) => v.productSourceId),
        ),
        column(
          'char_source_id',
          'text',
          rows.map((v) => v.charSourceId),
        ),
        column(
          'article',
          'text',
          rows.map((v) => v.article),
        ),
        column(
          'name',
          'text',
          rows.map((v) => v.name),
        ),
        column(
          'size',
          'text',
          rows.map((v) => v.size),
        ),
        column(
          'color',
          'text',
          rows.map((v) => v.color),
        ),
        column(
          'characteristics',
          'jsonb',
          rows.map((v) => JSON.stringify(v.characteristics)),
        ),
        column(
          'is_deleted',
          'boolean',
          rows.map((v) => v.isDeleted),
        ),
      ],
      ['source', 'source_id'],
      [
        'product_source_id',
        'char_source_id',
        'article',
        'name',
        'size',
        'color',
        'characteristics',
        'is_deleted',
      ],
      true,
    );
    await this.tx(async (client) => {
      await client.query(q.text, q.params);
      await this.syncImages(client, 'variant', owners, rows);
    });
  }

  private async syncImages(
    client: pg.PoolClient,
    kind: 'product' | 'variant',
    owners: string[],
    rows: { sourceId: string; images: { path: string; sortOrder: number }[] }[],
  ): Promise<void> {
    await syncChildren(
      client,
      {
        table: 'product_images_meta',
        fixed: { owner_kind: kind },
        ownerCol: 'owner_source_id',
        keyCols: ['path'],
        valueCols: ['sort_order'],
        valueTypes: { sort_order: 'integer' },
      },
      owners,
      dedupe(
        rows.flatMap((row) =>
          row.images.map((img) => ({
            owner_source_id: row.sourceId,
            path: img.path,
            sort_order: img.sortOrder,
          })),
        ),
        (r) => `${r.owner_source_id}${KEY_SEP}${r.path}`,
      ),
    );
  }

  /**
   * Справочник свойств из ранее загруженных файлов: многофайловая выгрузка
   * (import.xml + import0_1.xml) содержит Классификатор только в первой части,
   * а размер/цвет характеристик разворачиваются по нему — ревью, находка 6.
   */
  async loadDictionary(): Promise<CatalogDictionary> {
    await this.ready();
    const propertyNames = new Map<string, string>();
    const optionValues = new Map<string, string>();
    const props = await this.pool.query<{ source_id: string; name: string }>(
      'SELECT source_id, name FROM properties WHERE source = $1',
      [SOURCE],
    );
    for (const row of props.rows) propertyNames.set(row.source_id, row.name);
    const options = await this.pool.query<{
      property_source_id: string;
      source_id: string;
      value: string;
    }>('SELECT property_source_id, source_id, value FROM property_options WHERE source = $1', [
      SOURCE,
    ]);
    for (const row of options.rows) {
      optionValues.set(`${row.property_source_id}:${row.source_id}`, row.value);
    }
    return { propertyNames, optionValues };
  }

  async startRun(filename: string, meta: ImportMeta): Promise<number | null> {
    await this.ready();
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO catalog_import_runs (filename, schema_version, generated_at, only_changes)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [filename, meta.schemaVersion, meta.generatedAt, meta.onlyChanges],
    );
    const id = res.rows[0]?.id;
    return id === undefined ? null : Number(id);
  }

  async finishRun(runId: number | null, result: FinishRun): Promise<void> {
    if (runId === null) return;
    const { counters, meta, status, error } = result;
    await this.pool.query(
      `UPDATE catalog_import_runs
          SET finished_at = now(), status = $2, error = $3,
              schema_version = coalesce($4, schema_version),
              generated_at = coalesce($5, generated_at),
              only_changes = $6,
              categories = $7, brands = $8, properties = $9,
              products = $10, variants = $11, images = $12
        WHERE id = $1`,
      [
        runId,
        status,
        error ?? null,
        meta.schemaVersion,
        meta.generatedAt,
        meta.onlyChanges,
        counters.categories,
        counters.brands,
        counters.properties,
        counters.products,
        counters.variants,
        counters.images,
      ],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
