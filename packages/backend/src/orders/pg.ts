import { isIP } from 'node:net';
import pg from 'pg';
import { ORDERS_DDL } from './schema.js';
import type { OrderExport, OrderExportItem, OrderExportSource } from './export.js';
import {
  NumberTakenError,
  type CreateResult,
  type NewOrder,
  type OrderRepository,
  type OrderView,
} from './types.js';

/** Копейки → numeric-строка «123.45» без плавающей точки. */
export const kopToNumeric = (kop: number): string =>
  `${Math.trunc(kop / 100)}.${String(kop % 100).padStart(2, '0')}`;
const numericToKop = (v: string): number => Math.round(Number(v) * 100);

interface OrderRow {
  id: string;
  number: string;
  public_token: string;
  request_hash: string;
  created_at: Date;
  status: OrderView['status'];
  payment_status: OrderView['paymentStatus'];
  payment_method: OrderView['paymentMethod'];
  delivery_method: OrderView['delivery']['method'];
  items_total: string;
  delivery_cost: string;
  bonus_amount: string;
  total: string;
}

interface ItemRow {
  card_id: string | null;
  title: string;
  article: string | null;
  size: string | null;
  color: string | null;
  price: string;
  quantity: number;
  amount: string;
}

const ORDER_COLS = `id::text, number, public_token, request_hash, created_at, status, payment_status,
  payment_method, delivery_method, items_total::text, delivery_cost::text, bonus_amount::text,
  total::text`;

const inet = (ip: string | null) => (ip && isIP(ip) ? ip : null);

interface ExportOrderRow {
  id: string;
  number: string;
  created_at: Date;
  customer_name: string;
  phone_normalized: string;
  customer_email: string;
  delivery_method: OrderExport['deliveryMethod'];
  delivery_city: string | null;
  delivery_address: string | null;
  delivery_pvz_code: string | null;
  payment_method: OrderExport['paymentMethod'];
  comment: string | null;
  currency: string;
  items_total: string;
  delivery_cost: string;
  bonus_amount: string;
  total: string;
}

interface ExportItemRow {
  order_id: string;
  line_no: number;
  variant_source_id: string;
  article: string | null;
  name_1c: string | null;
  title: string;
  size: string | null;
  color: string | null;
  price: string;
  quantity: number;
  amount: string;
}

/** Заказы в PostgreSQL (миграция 014). Staging не читает и не пишет. */
export class PgOrderRepository implements OrderRepository, OrderExportSource {
  private readonly pool: pg.Pool;
  private prepared: Promise<unknown> | undefined;

  constructor(databaseUrl: string, poolSize = 3) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: poolSize });
  }

  ready(): Promise<void> {
    // Миграция идемпотентна (CREATE … IF NOT EXISTS); при неудаче пробуем заново.
    this.prepared ??= this.pool.query(ORDERS_DDL).catch((err: unknown) => {
      this.prepared = undefined;
      throw err;
    });
    return this.prepared.then(() => undefined);
  }

  private async view(row: OrderRow, db: pg.Pool | pg.PoolClient = this.pool): Promise<OrderView> {
    const { rows } = await db.query<ItemRow>(
      `SELECT card_id::text, title, article, size, color, price::text, quantity, amount::text
         FROM order_items WHERE order_id = $1 ORDER BY line_no`,
      [row.id],
    );
    return {
      number: row.number,
      token: row.public_token,
      createdAt: row.created_at.toISOString(),
      status: row.status,
      paymentStatus: row.payment_status,
      paymentMethod: row.payment_method,
      delivery: { method: row.delivery_method },
      currency: 'RUB',
      itemsTotalKop: numericToKop(row.items_total),
      deliveryCostKop: numericToKop(row.delivery_cost),
      bonusAmountKop: numericToKop(row.bonus_amount),
      totalKop: numericToKop(row.total),
      items: rows.map((i) => ({
        cardId: i.card_id === null ? null : Number(i.card_id),
        title: i.title,
        article: i.article,
        size: i.size,
        color: i.color,
        priceKop: numericToKop(i.price),
        quantity: i.quantity,
        amountKop: numericToKop(i.amount),
      })),
    };
  }

  private async one(where: string, value: string) {
    await this.ready();
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT ${ORDER_COLS} FROM orders WHERE ${where} = $1`,
      [value],
    );
    return rows[0] ? { row: rows[0], order: await this.view(rows[0]) } : null;
  }

  async findByIdempotencyKey(key: string) {
    const hit = await this.one('idempotency_key', key);
    return hit ? { requestHash: hit.row.request_hash, order: hit.order } : null;
  }

  async findByToken(token: string): Promise<OrderView | null> {
    return (await this.one('public_token', token))?.order ?? null;
  }

  async create(o: NewOrder): Promise<CreateResult> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { input } = o;
      // ON CONFLICT DO NOTHING без цели: параллельный запрос с тем же ключом ждёт коммита
      // первого на уникальном индексе и не вставляет вторую строку (и не обрывает транзакцию).
      const ins = await client.query<OrderRow>(
        `INSERT INTO orders (number, public_token, idempotency_key, request_hash, payment_method,
           customer_name, customer_phone, phone_normalized, customer_email, comment,
           delivery_method, delivery_city, delivery_address, delivery_pvz_code,
           items_total, delivery_cost, bonus_amount, total,
           pd_consent_at, pd_policy_version, offer_version, client_ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15::numeric, $16::numeric, $17::numeric, $18::numeric, now(), $19, $20, $21::inet, $22)
         ON CONFLICT DO NOTHING
         RETURNING ${ORDER_COLS}`,
        [
          o.number,
          o.publicToken,
          o.idempotencyKey,
          o.requestHash,
          input.payment.method,
          input.customer.name,
          input.customer.phone,
          input.customer.phoneNormalized,
          input.customer.email,
          input.comment,
          input.delivery.method,
          input.delivery.city,
          input.delivery.address,
          input.delivery.pvzCode,
          kopToNumeric(o.itemsTotalKop),
          kopToNumeric(o.deliveryCostKop),
          kopToNumeric(o.bonusAmountKop),
          kopToNumeric(o.totalKop),
          o.pdPolicyVersion,
          o.offerVersion,
          inet(o.clientIp),
          o.userAgent,
        ],
      );
      const row = ins.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        // Тем же соединением, не из пула: держа клиент, второй брать нельзя — при гонке
        // все соединения пула ждали бы друг друга (найдено тестом гонки).
        const taken = await client.query('SELECT 1 FROM orders WHERE idempotency_key = $1', [
          o.idempotencyKey,
        ]);
        if (taken.rowCount) return { kind: 'key-taken' };
        throw new NumberTakenError(); // совпал номер или токен — сервис выдаст новые
      }
      const L = o.lines;
      await client.query(
        `INSERT INTO order_items (order_id, line_no, card_id, model_source_id, variant_source_id,
           article, title, name_1c, size, color, price, quantity, amount)
         SELECT $1, * FROM unnest($2::int[], $3::bigint[], $4::text[], $5::text[], $6::text[],
           $7::text[], $8::text[], $9::text[], $10::text[], $11::numeric[], $12::int[],
           $13::numeric[])`,
        [
          row.id,
          L.map((l) => l.lineNo),
          L.map((l) => l.cardId),
          L.map((l) => l.modelId),
          L.map((l) => l.variantId),
          L.map((l) => l.article),
          L.map((l) => l.title),
          L.map((l) => l.name1c),
          L.map((l) => l.size),
          L.map((l) => l.color),
          L.map((l) => kopToNumeric(l.priceKop)),
          L.map((l) => l.quantity),
          L.map((l) => kopToNumeric(l.amountKop)),
        ],
      );
      await client.query(
        `INSERT INTO order_status_history (order_id, field, old_value, new_value, source, note)
         VALUES ($1, 'status', NULL, 'new', 'site', 'заказ оформлен на сайте')`,
        [row.id],
      );
      // Согласие на рассылку — отдельной записью и только при поставленной галочке.
      if (input.consents.marketing) {
        await client.query(
          `INSERT INTO marketing_consents (email, phone_normalized, order_id, source,
             consent_text_version, ip, user_agent)
           VALUES ($1, $2, $3, 'checkout', $4, $5::inet, $6)`,
          [
            input.customer.email,
            input.customer.phoneNormalized,
            row.id,
            o.marketingConsentVersion,
            inet(o.clientIp),
            o.userAgent,
          ],
        );
      }
      const order = await this.view(row, client);
      await client.query('COMMIT');
      return { kind: 'created', order };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Очередь на выгрузку в 1С (F2): невыгруженные заказы с полными ПД и позициями.
   * Отбор `exported_at IS NULL AND status='new'` идёт по индексу orders_not_exported_idx;
   * гостевые (user_id IS NULL) — наравне со всеми. Позиции берём одним запросом (без N+1).
   */
  async listPendingExport(limit: number): Promise<OrderExport[]> {
    await this.ready();
    const { rows } = await this.pool.query<ExportOrderRow>(
      `SELECT id::text, number, created_at, customer_name, phone_normalized, customer_email,
         delivery_method, delivery_city, delivery_address, delivery_pvz_code, payment_method,
         comment, currency, items_total::text, delivery_cost::text, bonus_amount::text, total::text
         FROM orders
         WHERE exported_at IS NULL AND status = 'new'
         ORDER BY created_at, id
         LIMIT $1`,
      [limit],
    );
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const { rows: itemRows } = await this.pool.query<ExportItemRow>(
      `SELECT order_id::text, line_no, variant_source_id, article, name_1c, title, size, color,
         price::text, quantity, amount::text
         FROM order_items WHERE order_id = ANY($1::bigint[]) ORDER BY order_id, line_no`,
      [ids],
    );
    const itemsByOrder = new Map<string, OrderExportItem[]>();
    for (const it of itemRows) {
      const list = itemsByOrder.get(it.order_id) ?? [];
      list.push({
        lineNo: it.line_no,
        variantSourceId: it.variant_source_id,
        article: it.article,
        name1c: it.name_1c,
        title: it.title,
        size: it.size,
        color: it.color,
        priceKop: numericToKop(it.price),
        quantity: it.quantity,
        amountKop: numericToKop(it.amount),
      });
      itemsByOrder.set(it.order_id, list);
    }
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      createdAt: r.created_at,
      customerName: r.customer_name,
      phoneNormalized: r.phone_normalized,
      email: r.customer_email,
      deliveryMethod: r.delivery_method,
      deliveryCity: r.delivery_city,
      deliveryAddress: r.delivery_address,
      deliveryPvzCode: r.delivery_pvz_code,
      paymentMethod: r.payment_method,
      comment: r.comment,
      currency: r.currency,
      itemsTotalKop: numericToKop(r.items_total),
      deliveryCostKop: numericToKop(r.delivery_cost),
      bonusAmountKop: numericToKop(r.bonus_amount),
      totalKop: numericToKop(r.total),
      items: itemsByOrder.get(r.id) ?? [],
    }));
  }

  /**
   * Пометить заказы выгруженными (sale:success), идемпотентно, в транзакции.
   * `AND exported_at IS NULL` делает повторный success no-op. Возвращает число помеченных.
   */
  async markExported(ids: string[], now: Date = new Date()): Promise<number> {
    if (ids.length === 0) return 0;
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `UPDATE orders SET exported_at = $2, updated_at = now()
           WHERE id = ANY($1::bigint[]) AND exported_at IS NULL`,
        [ids, now],
      );
      await client.query('COMMIT');
      return res.rowCount ?? 0;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
