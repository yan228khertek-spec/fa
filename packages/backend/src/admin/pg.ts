import pg from 'pg';
import { SOURCE } from '../db/upsert.js';
import { SITE_BRANDS_DDL } from './schema.js';
import {
  AdminError,
  GENDERS,
  type Assignment,
  type BrandPatch,
  type CatalogModel,
  type CatalogReader,
  type ExchangeStatus,
  type Gender,
  type ImageKind,
  type LiveModel,
  type NewBrand,
  type Placements,
  type SiteBrand,
  type SiteBrandRepository,
} from './types.js';

interface BrandRow {
  id: string;
  slug: string;
  name: string;
  photo_file: string | null;
  logo_file: string | null;
}

function conflict(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505') {
    if (e.constraint === 'site_brands_slug_uniq')
      throw new AdminError('Такой адрес бренда уже занят', 409);
    if (e.constraint === 'site_brand_aliases_pkey') {
      throw new AdminError('Одно из написаний уже закреплено за другим брендом', 409);
    }
    throw new AdminError('Конфликт данных', 409);
  }
  throw err;
}

async function inTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function writePlacements(
  c: pg.PoolClient,
  brandId: number,
  placements: Placements,
): Promise<void> {
  for (const g of GENDERS) {
    const p = placements[g];
    if (!p.in) {
      await c.query('DELETE FROM site_brand_placements WHERE brand_id = $1 AND gender = $2', [
        brandId,
        g,
      ]);
      continue;
    }
    await c.query(
      `INSERT INTO site_brand_placements (brand_id, gender, is_top, top_sort)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (brand_id, gender) DO UPDATE SET is_top = EXCLUDED.is_top, top_sort = EXCLUDED.top_sort`,
      [brandId, g, p.top, p.sort],
    );
  }
}

async function writeAliases(c: pg.PoolClient, brandId: number, aliases: string[]): Promise<void> {
  await c.query('DELETE FROM site_brand_aliases WHERE brand_id = $1 AND NOT (alias = ANY($2))', [
    brandId,
    aliases,
  ]);
  if (aliases.length) {
    await c.query(
      `INSERT INTO site_brand_aliases (alias, brand_id) SELECT a, $1 FROM unnest($2::text[]) AS a
       ON CONFLICT (alias) DO UPDATE SET brand_id = EXCLUDED.brand_id
       WHERE site_brand_aliases.brand_id = EXCLUDED.brand_id`,
      [brandId, aliases],
    );
    // Строка с чужим brand_id осталась нетронутой — значит, написание занято.
    const { rows } = await c.query<{ alias: string }>(
      'SELECT alias FROM site_brand_aliases WHERE alias = ANY($1) AND brand_id <> $2',
      [aliases, brandId],
    );
    if (rows[0]) {
      throw new AdminError(`Написание «${rows[0].alias}» уже закреплено за другим брендом`, 409);
    }
  }
}

export class PgSiteBrandRepository implements SiteBrandRepository {
  private readonly pool: pg.Pool;
  private prepared: Promise<unknown> | undefined;

  constructor(databaseUrl: string, poolSize = 3) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: poolSize });
  }

  ready(): Promise<void> {
    // Миграция идемпотентна (CREATE … IF NOT EXISTS); при неудаче пробуем заново.
    this.prepared ??= this.pool.query(SITE_BRANDS_DDL).catch((err: unknown) => {
      this.prepared = undefined;
      throw err;
    });
    return this.prepared.then(() => undefined);
  }

  private async brandsWhere(where: string, params: unknown[]): Promise<SiteBrand[]> {
    await this.ready();
    const { rows } = await this.pool.query<BrandRow>(
      `SELECT id::text, slug, name, photo_file, logo_file FROM site_brands ${where} ORDER BY name, id`,
      params,
    );
    if (!rows.length) return [];
    const ids = rows.map((r) => Number(r.id));
    const aliases = await this.pool.query<{ brand_id: string; alias: string }>(
      'SELECT brand_id::text, alias FROM site_brand_aliases WHERE brand_id = ANY($1) ORDER BY alias',
      [ids],
    );
    const places = await this.pool.query<{
      brand_id: string;
      gender: Gender;
      is_top: boolean;
      top_sort: number;
    }>(
      'SELECT brand_id::text, gender, is_top, top_sort FROM site_brand_placements WHERE brand_id = ANY($1)',
      [ids],
    );
    return rows.map((r) => {
      const placements: Placements = {
        men: { in: false, top: false, sort: 0 },
        women: { in: false, top: false, sort: 0 },
      };
      for (const p of places.rows) {
        if (p.brand_id === r.id)
          placements[p.gender] = { in: true, top: p.is_top, sort: p.top_sort };
      }
      return {
        id: Number(r.id),
        slug: r.slug,
        name: r.name,
        aliases: aliases.rows.filter((a) => a.brand_id === r.id).map((a) => a.alias),
        photo: r.photo_file,
        logo: r.logo_file,
        placements,
      };
    });
  }

  listBrands(): Promise<SiteBrand[]> {
    return this.brandsWhere('', []);
  }

  private async one(id: number): Promise<SiteBrand> {
    const [brand] = await this.brandsWhere('WHERE id = $1', [id]);
    if (!brand) throw new AdminError('Бренд не найден', 404);
    return brand;
  }

  async createBrand(input: NewBrand): Promise<SiteBrand> {
    await this.ready();
    try {
      const id = await inTx(this.pool, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          'INSERT INTO site_brands (slug, name) VALUES ($1, $2) RETURNING id::text',
          [input.slug, input.name],
        );
        const newId = Number(rows[0]!.id);
        await writeAliases(c, newId, input.aliases);
        await writePlacements(c, newId, input.placements);
        return newId;
      });
      return await this.one(id);
    } catch (err) {
      return conflict(err);
    }
  }

  async updateBrand(id: number, patch: BrandPatch): Promise<SiteBrand> {
    await this.ready();
    try {
      await inTx(this.pool, async (c) => {
        const { rowCount } = await c.query(
          `UPDATE site_brands SET name = coalesce($2, name), slug = coalesce($3, slug), updated_at = now()
           WHERE id = $1`,
          [id, patch.name ?? null, patch.slug ?? null],
        );
        if (!rowCount) throw new AdminError('Бренд не найден', 404);
        if (patch.aliases) await writeAliases(c, id, patch.aliases);
        if (patch.placements) await writePlacements(c, id, patch.placements);
      });
    } catch (err) {
      return conflict(err);
    }
    return this.one(id);
  }

  async deleteBrand(id: number): Promise<void> {
    await this.ready();
    const { rowCount } = await this.pool.query('DELETE FROM site_brands WHERE id = $1', [id]);
    if (!rowCount) throw new AdminError('Бренд не найден', 404);
  }

  async setImage(id: number, kind: ImageKind, filename: string | null): Promise<string | null> {
    await this.ready();
    const col = kind === 'photo' ? 'photo_file' : 'logo_file';
    // Прежнее имя читаем и обновляем одним оператором, чтобы не потерять файл-сироту при гонке.
    const { rows } = await this.pool.query<{ prev: string | null }>(
      `UPDATE site_brands n SET ${col} = $2, updated_at = now()
       FROM (SELECT id, ${col} AS prev FROM site_brands WHERE id = $1 FOR UPDATE) o
       WHERE n.id = o.id RETURNING o.prev`,
      [id, filename],
    );
    if (!rows[0]) throw new AdminError('Бренд не найден', 404);
    return rows[0].prev;
  }

  async setTop(gender: Gender, brandIds: number[]): Promise<void> {
    await this.ready();
    await inTx(this.pool, async (c) => {
      if (brandIds.length) {
        const { rows } = await c.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM site_brands WHERE id = ANY($1)',
          [brandIds],
        );
        if (Number(rows[0]!.n) !== new Set(brandIds).size)
          throw new AdminError('Бренд не найден', 404);
      }
      await c.query(
        'UPDATE site_brand_placements SET is_top = false, top_sort = 0 WHERE gender = $1',
        [gender],
      );
      for (const [i, id] of brandIds.entries()) {
        await c.query(
          `INSERT INTO site_brand_placements (brand_id, gender, is_top, top_sort)
           VALUES ($1, $2, true, $3)
           ON CONFLICT (brand_id, gender) DO UPDATE SET is_top = true, top_sort = EXCLUDED.top_sort`,
          [id, gender, i],
        );
      }
    });
  }

  async listAssignments(): Promise<Assignment[]> {
    await this.ready();
    const { rows } = await this.pool.query<{
      model_source_id: string;
      brand_id: string;
      origin: 'auto' | 'manual';
    }>('SELECT model_source_id, brand_id::text, origin FROM site_model_brand');
    return rows.map((r) => ({
      modelId: r.model_source_id,
      brandId: Number(r.brand_id),
      origin: r.origin,
    }));
  }

  async replaceAuto(items: { modelId: string; brandId: number }[]): Promise<void> {
    await this.ready();
    await inTx(this.pool, async (c) => {
      await c.query("DELETE FROM site_model_brand WHERE origin = 'auto'");
      if (!items.length) return;
      await c.query(
        `INSERT INTO site_model_brand (model_source_id, brand_id, origin)
         SELECT m, b, 'auto' FROM unnest($1::text[], $2::bigint[]) AS t(m, b)
         ON CONFLICT (model_source_id) DO NOTHING`,
        [items.map((i) => i.modelId), items.map((i) => i.brandId)],
      );
    });
  }

  async setManual(modelId: string, brandId: number | null): Promise<void> {
    await this.ready();
    if (brandId === null) {
      await this.pool.query(
        "DELETE FROM site_model_brand WHERE model_source_id = $1 AND origin = 'manual'",
        [modelId],
      );
      return;
    }
    try {
      await this.pool.query(
        `INSERT INTO site_model_brand (model_source_id, brand_id, origin) VALUES ($1, $2, 'manual')
         ON CONFLICT (model_source_id) DO UPDATE SET brand_id = EXCLUDED.brand_id, origin = 'manual', updated_at = now()`,
        [modelId, brandId],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23503') throw new AdminError('Бренд не найден', 404);
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Модели каталога и состояние обмена — только SELECT по staging-таблицам. */
const isMissingTable = (err: unknown): boolean => (err as { code?: string }).code === '42P01';

export class PgCatalogReader implements CatalogReader {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string, poolSize = 2) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: poolSize });
  }

  async listModels(): Promise<CatalogModel[]> {
    try {
      return await this.queryModels();
    } catch (err) {
      if (isMissingTable(err)) return []; // обмен ещё ни разу не создавал staging-таблицы
      throw err;
    }
  }

  private async queryModels(): Promise<CatalogModel[]> {
    // Товары-родители в реальной выгрузке могут не приходить (все позиции — SKU),
    // поэтому модель = Ид до «#» из product_variants, а название берём у товара,
    // если он есть, иначе у SKU. Фото — первая картинка товара или любого его SKU.
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      article: string | null;
      skus: number;
      photo: string | null;
    }>(
      `WITH names AS (
         SELECT DISTINCT ON (id) id, name, article FROM (
           SELECT source_id AS id, name, article, 0 AS prio FROM products
            WHERE source = $1 AND NOT is_deleted
           UNION ALL
           SELECT product_source_id, name, article, 1 FROM product_variants
            WHERE source = $1 AND NOT is_deleted AND name IS NOT NULL
         ) n ORDER BY id, prio, name
       ), skus AS (
         SELECT product_source_id AS id, count(*)::int AS n FROM product_variants
          WHERE source = $1 AND NOT is_deleted GROUP BY product_source_id
       ), photos AS (
         SELECT DISTINCT ON (model) model, path FROM (
           SELECT split_part(owner_source_id, '#', 1) AS model, path,
                  (owner_kind = 'product') AS own, sort_order
             FROM product_images_meta WHERE source = $1
         ) i ORDER BY model, own DESC, sort_order, path
       )
       SELECT names.id, names.name, names.article, coalesce(skus.n, 0) AS skus, photos.path AS photo
         FROM names
         LEFT JOIN skus ON skus.id = names.id
         LEFT JOIN photos ON photos.model = names.id
        ORDER BY names.name, names.id`,
      [SOURCE],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      article: r.article,
      skus: r.skus,
      photo: r.photo,
    }));
  }

  async modelImages(modelId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ path: string }>(
      `SELECT path FROM (
         SELECT DISTINCT ON (path) path, (owner_kind = 'product') AS own, sort_order
           FROM product_images_meta
          WHERE source = $1 AND split_part(owner_source_id, '#', 1) = $2
          ORDER BY path
       ) i ORDER BY own DESC, sort_order, path`,
      [SOURCE, modelId],
    );
    return rows.map((r) => r.path);
  }

  async liveData(): Promise<Map<string, LiveModel>> {
    const out = new Map<string, LiveModel>();
    const variants = await this.rowsOrEmpty<{
      model: string;
      id: string;
      size: string | null;
      color: string | null;
    }>(
      `SELECT product_source_id AS model, source_id AS id, size, color FROM product_variants
        WHERE source = '${SOURCE}' AND NOT is_deleted ORDER BY product_source_id, source_id`,
    );
    // offers_* может не существовать (offers.xml ещё не приходил) — тогда остатков и цен нет.
    const offers = await this.rowsOrEmpty<{
      id: string;
      quantity: string | null;
      price: string | null;
    }>(
      `SELECT o.source_id AS id, s.q::text AS quantity, p.price::text AS price
         FROM offers o
         LEFT JOIN (SELECT offer_source_id, sum(quantity) AS q FROM offer_stocks
                     WHERE source = '${SOURCE}' GROUP BY offer_source_id) s
           ON s.offer_source_id = o.source_id
         LEFT JOIN (SELECT offer_source_id, min(value) AS price FROM offer_prices
                     WHERE source = '${SOURCE}' GROUP BY offer_source_id) p
           ON p.offer_source_id = o.source_id
        WHERE o.source = '${SOURCE}' AND NOT coalesce(o.is_deleted, false)`,
    );
    const byOffer = new Map(offers.map((o) => [o.id, o]));
    for (const v of variants) {
      const offer = byOffer.get(v.id);
      const model = out.get(v.model) ?? { variants: [], price: null, stock: null };
      const quantity = offer ? Number(offer.quantity ?? 0) : null;
      model.variants.push({ id: v.id, size: v.size, color: v.color, quantity });
      if (quantity !== null) model.stock = (model.stock ?? 0) + quantity;
      if (offer?.price != null) {
        const price = Number(offer.price);
        model.price = model.price === null ? price : Math.min(model.price, price);
      }
      out.set(v.model, model);
    }
    return out;
  }

  /** Каждую таблицу читаем отдельно: offers_* может не существовать, пока не пришёл offers.xml. */
  private async rowsOrEmpty<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
    try {
      return (await this.pool.query<T>(sql)).rows;
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  }

  async exchangeStatus(): Promise<ExchangeStatus> {
    const [log, catalogRuns, offersRuns] = await Promise.all([
      this.rowsOrEmpty<{
        at: Date;
        type: string;
        mode: string;
        filename: string | null;
        body_bytes: string;
        result: string;
        detail: string | null;
      }>(
        'SELECT at, type, mode, filename, body_bytes::text, result, detail FROM exchange_log ORDER BY id DESC LIMIT 20',
      ),
      this.rowsOrEmpty('SELECT * FROM catalog_import_runs ORDER BY id DESC LIMIT 5'),
      this.rowsOrEmpty('SELECT * FROM offers_import_runs ORDER BY id DESC LIMIT 5'),
    ]);
    return {
      log: log.map((r) => ({
        at: r.at.toISOString(),
        type: r.type,
        mode: r.mode,
        filename: r.filename,
        bodyBytes: Number(r.body_bytes),
        result: r.result,
        detail: r.detail,
      })),
      catalogRuns,
      offersRuns,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
