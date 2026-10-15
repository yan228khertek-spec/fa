/** Доменные типы заказов (трек F1, миграция 007). Деньги внутри — в копейках (целые). */

export type DeliveryMethod = 'pickup' | 'cdek';
export type PaymentMethod = 'on_receipt' | 'online';
export type OrderStatus =
  | 'new'
  | 'confirmed'
  | 'processing'
  | 'ready_for_pickup'
  | 'shipped'
  | 'delivered'
  | 'completed'
  | 'cancelled';
export type PaymentStatus =
  'unpaid' | 'pending' | 'paid' | 'canceled' | 'refunded' | 'partially_refunded';

/** Настройки приёма заказов (env). Суммы — в рублях, как в конфиге. */
export interface OrdersConfig {
  /** Выключатель приёма заказов: false → 503 ORDERS_DISABLED. */
  enabled: boolean;
  /** Фикс-тариф СДЭК v1, ₽. ⚠️ С заказчиком не согласован. */
  cdekFee: number;
  /** Порог бесплатной доставки СДЭК по сумме товаров, ₽; null — порога нет. ⚠️ Не согласован. */
  freeDeliveryFrom: number | null;
  /** Адрес магазина для самовывоза (для чекаута); пусто — неизвестен. */
  pickupAddress: string;
  offerVersion: string;
  pdPolicyVersion: string;
  marketingConsentVersion: string;
  /** Онлайн-оплата (F4). До интеграции ЮKassa — false. */
  onlinePayment: boolean;
  /** Не больше `rateLimit` попыток POST /api/orders с одного IP за `rateWindowMs`. */
  rateLimit: number;
  rateWindowMs: number;
}

export const DEFAULT_ORDERS_CONFIG: OrdersConfig = {
  enabled: true,
  cdekFee: 500,
  freeDeliveryFrom: 20000,
  pickupAddress: '',
  offerVersion: 'draft-2026-10',
  pdPolicyVersion: 'draft-2026-10',
  marketingConsentVersion: 'draft-2026-10',
  onlinePayment: false,
  rateLimit: 20,
  rateWindowMs: 10 * 60 * 1000,
};

export const MAX_ITEMS = 30;
export const MAX_QUANTITY = 10;

/** Позиция запроса после валидации формы (без проверки по каталогу). */
export interface OrderItemInput {
  cardId: number;
  variantId: string;
  quantity: number;
  /** Цена, которую видел покупатель, в копейках. */
  priceKop: number;
}

/** Запрос после валидации и нормализации: только известные поля. */
export interface OrderInput {
  customer: { name: string; phone: string; phoneNormalized: string; email: string };
  delivery: {
    method: DeliveryMethod;
    city: string | null;
    address: string | null;
    pvzCode: string | null;
  };
  payment: { method: PaymentMethod };
  comment: string | null;
  items: OrderItemInput[];
  expectedTotalKop: number | null;
  consents: { personalData: true; marketing: boolean };
}

/** Позиция, прошедшая проверку по каталогу: снимок для order_items. */
export interface OrderLine {
  lineNo: number;
  cardId: number;
  modelId: string;
  variantId: string;
  article: string | null;
  title: string;
  name1c: string | null;
  size: string | null;
  color: string | null;
  priceKop: number;
  quantity: number;
  amountKop: number;
}

/** Всё, что пишется в БД одной транзакцией. */
export interface NewOrder {
  number: string;
  publicToken: string;
  idempotencyKey: string;
  requestHash: string;
  input: OrderInput;
  lines: OrderLine[];
  itemsTotalKop: number;
  deliveryCostKop: number;
  bonusAmountKop: number;
  totalKop: number;
  pdPolicyVersion: string;
  offerVersion: string;
  marketingConsentVersion: string;
  clientIp: string | null;
  userAgent: string | null;
}

/** Заказ, как его видит страница «Спасибо»: без имени, телефона, email и адреса. */
export interface OrderView {
  number: string;
  token: string;
  createdAt: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  delivery: { method: DeliveryMethod };
  currency: 'RUB';
  itemsTotalKop: number;
  deliveryCostKop: number;
  bonusAmountKop: number;
  totalKop: number;
  items: {
    cardId: number | null;
    title: string;
    article: string | null;
    size: string | null;
    color: string | null;
    priceKop: number;
    quantity: number;
    amountKop: number;
  }[];
}

/** created — заказ записан; key-taken — ключ идемпотентности уже у другого (параллельного) запроса. */
export type CreateResult = { kind: 'created'; order: OrderView } | { kind: 'key-taken' };

export interface OrderRepository {
  ready(): Promise<void>;
  /** Заказ по ключу идемпотентности: hash — для сверки «тот же запрос или нет». */
  findByIdempotencyKey(key: string): Promise<{ requestHash: string; order: OrderView } | null>;
  /**
   * Создаёт заказ атомарно (заказ, позиции, история, согласие на рассылку).
   * Ключ идемпотентности уже занят → key-taken, второй заказ не создаётся.
   * Совпадение номера → бросает NumberTakenError, сервис генерирует новый.
   */
  create(order: NewOrder): Promise<CreateResult>;
  findByToken(token: string): Promise<OrderView | null>;
  close(): Promise<void>;
}

export class NumberTakenError extends Error {
  constructor() {
    super('Номер заказа уже занят');
    this.name = 'NumberTakenError';
  }
}

/** Ошибка API заказов с машиночитаемым кодом (см. docs/api-contract.md, раздел «Заказы»). */
export class OrderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'OrderError';
  }
}
