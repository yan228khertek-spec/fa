import type { CreateResult, NewOrder, OrderRepository, OrderView } from './types.js';

/** Заказы в памяти: dev без БД и тесты HTTP-слоя (тот же контракт, что у PgOrderRepository). */
export class MemoryOrderRepository implements OrderRepository {
  readonly orders: (NewOrder & { view: OrderView })[] = [];

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
    const view: OrderView = {
      number: o.number,
      token: o.publicToken,
      createdAt: new Date().toISOString(),
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
    this.orders.push({ ...structuredClone(o), view });
    return { kind: 'created', order: structuredClone(view) };
  }

  async close(): Promise<void> {}
}
