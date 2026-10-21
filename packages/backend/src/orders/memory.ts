import type { OrderExport, OrderExportItem, OrderExportSource } from './export.js';
import type { CreateResult, NewOrder, OrderRepository, OrderView } from './types.js';

/** Хранимый заказ: поля NewOrder (как в F1) + id, createdAt и метка выгрузки (F2). */
type StoredOrder = NewOrder & {
  id: string;
  createdAt: Date;
  exportedAt: Date | null;
  view: OrderView;
};

/** Заказы в памяти: dev без БД и тесты HTTP-слоя (тот же контракт, что у PgOrderRepository). */
export class MemoryOrderRepository implements OrderRepository, OrderExportSource {
  readonly orders: StoredOrder[] = [];
  private seq = 0;

  async ready(): Promise<void> {}

  async findByIdempotencyKey(key: string) {
    const o = this.orders.find((x) => x.idempotencyKey === key);
    return o ? { requestHash: o.requestHash, order: structuredClone(o.view) } : null;
  }

  async findByToken(token: string): Promise<OrderView | null> {
    const o = this.orders.find((x) => x.publicToken === token);
    return o ? structuredClone(o.view) : null;
  }

  async create(o: NewOrder): Promise<CreateResult> {
    if (this.orders.some((x) => x.idempotencyKey === o.idempotencyKey))
      return { kind: 'key-taken' };
    const createdAt = new Date();
    const view: OrderView = {
      number: o.number,
      token: o.publicToken,
      createdAt: createdAt.toISOString(),
      status: 'new',
      paymentStatus: 'unpaid',
      paymentMethod: o.input.payment.method,
      delivery: { method: o.input.delivery.method },
      currency: 'RUB',
      itemsTotalKop: o.itemsTotalKop,
      deliveryCostKop: o.deliveryCostKop,
      bonusAmountKop: o.bonusAmountKop,
      totalKop: o.totalKop,
      items: o.lines.map((l) => ({
        cardId: l.cardId,
        title: l.title,
        article: l.article,
        size: l.size,
        color: l.color,
        priceKop: l.priceKop,
        quantity: l.quantity,
        amountKop: l.amountKop,
      })),
    };
    this.orders.push({
      ...structuredClone(o),
      id: String(++this.seq),
      createdAt,
      exportedAt: null,
      view,
    });
    return { kind: 'created', order: structuredClone(view) };
  }

  async listPendingExport(limit: number): Promise<OrderExport[]> {
    return this.orders
      .filter((x) => x.exportedAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || Number(a.id) - Number(b.id))
      .slice(0, limit)
      .map((x) => {
        const items: OrderExportItem[] = x.lines.map((l) => ({
          lineNo: l.lineNo,
          variantSourceId: l.variantId,
          article: l.article,
          name1c: l.name1c,
          title: l.title,
          size: l.size,
          color: l.color,
          priceKop: l.priceKop,
          quantity: l.quantity,
          amountKop: l.amountKop,
        }));
        return {
          id: x.id,
          number: x.number,
          createdAt: x.createdAt,
          customerName: x.input.customer.name,
          phoneNormalized: x.input.customer.phoneNormalized,
          email: x.input.customer.email,
          deliveryMethod: x.input.delivery.method,
          deliveryCity: x.input.delivery.city,
          deliveryAddress: x.input.delivery.address,
          deliveryPvzCode: x.input.delivery.pvzCode,
          paymentMethod: x.input.payment.method,
          comment: x.input.comment,
          currency: 'RUB',
          itemsTotalKop: x.itemsTotalKop,
          deliveryCostKop: x.deliveryCostKop,
          bonusAmountKop: x.bonusAmountKop,
          totalKop: x.totalKop,
          items,
        };
      });
  }

  async markExported(ids: string[], now: Date = new Date()): Promise<number> {
    const wanted = new Set(ids);
    let marked = 0;
    for (const x of this.orders) {
      if (wanted.has(x.id) && x.exportedAt === null) {
        x.exportedAt = now;
        marked++;
      }
    }
    return marked;
  }

  async close(): Promise<void> {}
}
