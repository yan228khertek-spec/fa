import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { OrderableCard } from '../admin/cards.js';
import {
  NumberTakenError,
  OrderError,
  type CreateResult,
  type OrderInput,
  type OrderLine,
  type OrderRepository,
  type OrdersConfig,
  type OrderView,
} from './types.js';

/** Источник живых данных каталога: видимые карточки и их SKU (CardService.orderable). */
export interface OrderableSource {
  orderable(ids: number[]): Promise<Map<number, OrderableCard>>;
}

export interface ItemProblem {
  index: number;
  cardId: number;
  variantId: string;
  code:
    | 'CARD_NOT_AVAILABLE'
    | 'VARIANT_NOT_FOUND'
    | 'NO_PRICE'
    | 'OUT_OF_STOCK'
    | 'INSUFFICIENT_STOCK'
    | 'PRICE_CHANGED';
  available?: number;
  price?: number;
}

const rub = (kop: number) => kop / 100;

/** Канонический JSON (ключи по алфавиту): хеш не зависит от порядка полей в запросе. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Хеш нормализованного запроса: тот же ключ + то же содержимое = повтор, а не новый заказ. */
export function requestHash(input: OrderInput): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}

export const newOrderNumber = () => `FA-${randomInt(10_000_000, 100_000_000)}`;
export const newPublicToken = () => randomBytes(32).toString('base64url');
export const PUBLIC_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Оформление заказа: перепроверка позиций по живым данным витрины, расчёт сумм,
 * идемпотентная запись. Клиенту не верим: цена, остаток, видимость, доставка и итог —
 * серверные. Резерва нет — остаток проверяется в момент оформления (источник истины — 1С).
 */
export class OrderService {
  constructor(
    readonly repo: OrderRepository,
    private readonly catalog: OrderableSource,
    readonly config: OrdersConfig,
  ) {}

  deliveryCostKop(method: 'pickup' | 'cdek', itemsTotalKop: number): number {
    if (method === 'pickup') return 0;
    const free = this.config.freeDeliveryFrom;
    if (free !== null && itemsTotalKop >= Math.round(free * 100)) return 0;
    return Math.round(this.config.cdekFee * 100);
  }

  /** Сверка позиций с витриной: все проблемы разом или снимок строк заказа. */
  private async checkItems(input: OrderInput): Promise<OrderLine[]> {
    const cards = await this.catalog.orderable([...new Set(input.items.map((i) => i.cardId))]);
    const problems: ItemProblem[] = [];
    const lines: OrderLine[] = [];
    input.items.forEach((it, index) => {
      const base = { index, cardId: it.cardId, variantId: it.variantId };
      const card = cards.get(it.cardId);
      if (!card) return problems.push({ ...base, code: 'CARD_NOT_AVAILABLE' });
      const v = card.variants.get(it.variantId);
      if (!v) return problems.push({ ...base, code: 'VARIANT_NOT_FOUND' });
      // Цена 0 или отрицательная в 1С — мусор, не продаём (как и отсутствие цены).
      if (v.price === null || !(v.price > 0)) return problems.push({ ...base, code: 'NO_PRICE' });
      // Остаток неизвестен (null) — не продаём: без данных 1С нельзя обещать товар.
      if (v.quantity === null || v.quantity <= 0)
        return problems.push({ ...base, code: 'OUT_OF_STOCK' });
      if (v.quantity < it.quantity) {
        return problems.push({
          ...base,
          code: 'INSUFFICIENT_STOCK',
          available: Math.floor(v.quantity),
        });
      }
      const priceKop = Math.round(v.price * 100);
      if (priceKop !== it.priceKop) {
        return problems.push({ ...base, code: 'PRICE_CHANGED', price: rub(priceKop) });
      }
      return lines.push({
        lineNo: index + 1,
        cardId: card.cardId,
        modelId: card.modelId,
        variantId: it.variantId,
        article: card.article,
        title: card.title,
        name1c: v.name,
        size: v.size,
        color: v.color,
        priceKop,
        quantity: it.quantity,
        amountKop: priceKop * it.quantity,
      });
    });
    if (problems.length) {
      throw new OrderError(409, 'ITEMS_UNAVAILABLE', 'Некоторые товары нельзя заказать', {
        items: problems,
      });
    }
    return lines;
  }

  async create(
    input: OrderInput,
    meta: { idempotencyKey: string; clientIp: string | null; userAgent: string | null },
  ): Promise<{ replayed: boolean; order: OrderView }> {
    const hash = requestHash(input);
    // Повтор проверяем ДО каталога: заказ уже создан, даже если товар с тех пор закончился.
    const prior = await this.repo.findByIdempotencyKey(meta.idempotencyKey);
    if (prior) return this.replay(prior.requestHash, hash, prior.order);

    const lines = await this.checkItems(input);
    const itemsTotalKop = lines.reduce((s, l) => s + l.amountKop, 0);
    const deliveryCostKop = this.deliveryCostKop(input.delivery.method, itemsTotalKop);
    const bonusAmountKop = 0; // программа лояльности — отдельный шаг; в v1 бонусы не списываются
    const totalKop = itemsTotalKop + deliveryCostKop - bonusAmountKop;
    if (input.expectedTotalKop !== null && input.expectedTotalKop !== totalKop) {
      throw new OrderError(409, 'TOTAL_CHANGED', 'Сумма заказа изменилась', {
        itemsTotal: rub(itemsTotalKop),
        deliveryCost: rub(deliveryCostKop),
        bonusAmount: rub(bonusAmountKop),
        total: rub(totalKop),
      });
    }

    for (let attempt = 0; ; attempt++) {
      let res: CreateResult;
      try {
        res = await this.repo.create({
          number: newOrderNumber(),
          publicToken: newPublicToken(),
          idempotencyKey: meta.idempotencyKey,
          requestHash: hash,
          input,
          lines,
          itemsTotalKop,
          deliveryCostKop,
          bonusAmountKop,
          totalKop,
          pdPolicyVersion: this.config.pdPolicyVersion,
          offerVersion: this.config.offerVersion,
          marketingConsentVersion: this.config.marketingConsentVersion,
          clientIp: meta.clientIp,
          userAgent: meta.userAgent,
        });
      } catch (err) {
        // 90 млн номеров: совпадение — редкость, но не ошибка покупателя.
        if (err instanceof NumberTakenError && attempt < 5) continue;
        throw err;
      }
      if (res.kind === 'created') return { replayed: false, order: res.order };
      // Параллельный запрос с тем же ключом успел первым — отвечаем его заказом.
      const winner = await this.repo.findByIdempotencyKey(meta.idempotencyKey);
      if (!winner) throw new Error('Заказ по ключу идемпотентности не найден после конфликта');
      return this.replay(winner.requestHash, hash, winner.order);
    }
  }

  private replay(
    priorHash: string,
    hash: string,
    order: OrderView,
  ): { replayed: boolean; order: OrderView } {
    if (priorHash !== hash) {
      throw new OrderError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'Ключ Idempotency-Key уже использован для другого заказа',
      );
    }
    return { replayed: true, order };
  }

  async byToken(token: string): Promise<OrderView | null> {
    if (!PUBLIC_TOKEN.test(token)) return null;
    return this.repo.findByToken(token);
  }
}
