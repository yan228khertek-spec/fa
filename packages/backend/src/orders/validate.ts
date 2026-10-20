import {
  MAX_ITEMS,
  MAX_QUANTITY,
  OrderError,
  type DeliveryMethod,
  type OrderInput,
  type OrderItemInput,
  type PaymentMethod,
} from './types.js';

export interface FieldError {
  field: string;
  code: string;
}

/**
 * Российский номер в любом написании → +7XXXXXXXXXX; иначе null.
 * Принимаем +7…, 8…, 7… (11 цифр) и 10 цифр без кода страны; разделители — пробел,
 * скобки, дефис, точка. Нормализованный номер — ключ склейки заказов с аккаунтом (F5),
 * поэтому правило одно на весь проект: менять только вместе с миграцией данных.
 */
export function normalizePhone(raw: string): string | null {
  const s = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(s)) return null;
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (plus) return digits.length === 11 && digits[0] === '7' ? `+${digits}` : null;
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8'))
    return `+7${digits.slice(1)}`;
  if (digits.length === 10) return `+7${digits}`;
  return null;
}

// Управляющие символы недопустимы нигде; переводы строк — только в комментарии.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_NEWLINE = /[\u0000-\u001f\u007f\u2028\u2029]/;
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const PVZ = /^[A-Za-z0-9-]{1,50}$/;
// Ид SKU 1С («Ид#ИдХарактеристики»); принадлежность карточке проверяет OrderService.
// eslint-disable-next-line no-control-regex
const VARIANT = /^[^\s\u0000-\u001f]{1,201}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Рубли из JSON → копейки; null — не деньги (не число, ≤0 при strict, больше 2 знаков). */
export function toKopecks(v: unknown, allowZero = false): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < 0 || (!allowZero && v === 0) || v > 1e10) return null;
  const kop = Math.round(v * 100);
  if (Math.abs(v * 100 - kop) > 1e-6) return null;
  return kop;
}

/**
 * Проверка и нормализация тела POST /api/orders. Клиенту не верим: всё, что не прошло
 * правила контракта, — ошибка поля; неизвестные поля отбрасываются (не сохраняются).
 * Проверка по каталогу (цена, остаток, видимость) — отдельно, в OrderService.
 */
export function parseOrderInput(body: unknown, opts: { onlinePayment: boolean }): OrderInput {
  const errors: FieldError[] = [];
  const err = (field: string, code: string) => {
    errors.push({ field, code });
    return null;
  };
  const text = (
    obj: Record<string, unknown> | null,
    key: string,
    field: string,
    min: number,
    max: number,
    { required = true, multiline = false } = {},
  ): string | null => {
    if (obj === null) return null; // раздел целиком отсутствует — ошибка уже записана на него
    const v = obj[key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      return required ? err(field, 'REQUIRED') : null;
    }
    if (typeof v !== 'string') return err(field, 'INVALID_TYPE');
    if ((multiline ? CONTROL : CONTROL_OR_NEWLINE).test(v)) return err(field, 'INVALID_FORMAT');
    const s = multiline
      ? v.normalize('NFC').trim()
      : v.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (s.length < min) return err(field, 'TOO_SHORT');
    if (s.length > max) return err(field, 'TOO_LONG');
    return s;
  };
  const section = (key: string): Record<string, unknown> | null => {
    const v = (body as Record<string, unknown>)[key];
    if (v === undefined || v === null) return err(key, 'REQUIRED');
    if (!isObj(v)) return err(key, 'INVALID_TYPE');
    return v;
  };

  if (!isObj(body)) {
    throw new OrderError(422, 'VALIDATION_ERROR', 'Ожидается объект заказа', {
      fields: [{ field: '', code: 'INVALID_TYPE' }],
    });
  }

  // --- покупатель ---
  const customer = section('customer');
  const name = text(customer, 'name', 'customer.name', 2, 100);
  const phone = text(customer, 'phone', 'customer.phone', 1, 40);
  const phoneNormalized = phone === null ? null : normalizePhone(phone);
  if (phone !== null && phoneNormalized === null) err('customer.phone', 'INVALID_PHONE');
  let email = text(customer, 'email', 'customer.email', 3, 254);
  if (email !== null) {
    email = email.toLowerCase();
    if (!EMAIL.test(email)) email = err('customer.email', 'INVALID_EMAIL');
  }

  // --- доставка ---
  const delivery = section('delivery');
  let method: DeliveryMethod | null = null;
  if (delivery) {
    if (delivery.method === 'pickup' || delivery.method === 'cdek') method = delivery.method;
    else if (delivery.method === undefined || delivery.method === null)
      err('delivery.method', 'REQUIRED');
    else err('delivery.method', 'INVALID_VALUE');
  }
  let city: string | null = null;
  let address: string | null = null;
  let pvzCode: string | null = null;
  if (method === 'cdek') {
    // Для самовывоза адресные поля игнорируются (фронт мог оставить их после переключения).
    city = text(delivery, 'city', 'delivery.city', 2, 100);
    address = text(delivery, 'address', 'delivery.address', 5, 300);
    pvzCode = text(delivery, 'pvzCode', 'delivery.pvzCode', 1, 50, { required: false });
    if (pvzCode !== null && !PVZ.test(pvzCode)) pvzCode = err('delivery.pvzCode', 'INVALID_FORMAT');
  }

  // --- оплата ---
  const payment = section('payment');
  let paymentMethod: PaymentMethod | null = null;
  if (payment) {
    if (payment.method === 'on_receipt' || payment.method === 'online')
      paymentMethod = payment.method;
    else if (payment.method === undefined || payment.method === null)
      err('payment.method', 'REQUIRED');
    else err('payment.method', 'INVALID_VALUE');
  }

  const comment = text(body, 'comment', 'comment', 1, 1000, { required: false, multiline: true });

  // --- позиции ---
  const items: OrderItemInput[] = [];
  const rawItems = body.items;
  if (rawItems === undefined || rawItems === null) err('items', 'REQUIRED');
  else if (!Array.isArray(rawItems)) err('items', 'INVALID_TYPE');
  else if (rawItems.length === 0) err('items', 'REQUIRED');
  else if (rawItems.length > MAX_ITEMS) err('items', 'TOO_MANY_ITEMS');
  else {
    const seen = new Set<string>();
    rawItems.forEach((it: unknown, i) => {
      const f = `items[${i}]`;
      if (!isObj(it)) return err(f, 'INVALID_TYPE');
      let ok = true;
      const cardId = it.cardId;
      if (!Number.isSafeInteger(cardId) || (cardId as number) <= 0) {
        err(`${f}.cardId`, cardId === undefined ? 'REQUIRED' : 'INVALID_VALUE');
        ok = false;
      }
      const variantId = it.variantId;
      if (typeof variantId !== 'string' || !VARIANT.test(variantId)) {
        err(`${f}.variantId`, variantId === undefined ? 'REQUIRED' : 'INVALID_FORMAT');
        ok = false;
      } else if (seen.has(variantId)) {
        err(`${f}.variantId`, 'DUPLICATE_ITEM');
        ok = false;
      } else seen.add(variantId);
      const quantity = it.quantity;
      if (!Number.isInteger(quantity) || (quantity as number) < 1) {
        err(`${f}.quantity`, quantity === undefined ? 'REQUIRED' : 'INVALID_QUANTITY');
        ok = false;
      } else if ((quantity as number) > MAX_QUANTITY) {
        err(`${f}.quantity`, 'INVALID_QUANTITY');
        ok = false;
      }
      const priceKop = toKopecks(it.price);
      if (priceKop === null) {
        err(`${f}.price`, it.price === undefined ? 'REQUIRED' : 'INVALID_VALUE');
        ok = false;
      }
      if (ok) {
        items.push({
          cardId: cardId as number,
          variantId: variantId as string,
          quantity: quantity as number,
          priceKop: priceKop!,
        });
      }
      return null;
    });
  }

  let expectedTotalKop: number | null = null;
  if (body.expectedTotal !== undefined && body.expectedTotal !== null) {
    expectedTotalKop = toKopecks(body.expectedTotal, true);
    if (expectedTotalKop === null) err('expectedTotal', 'INVALID_VALUE');
  }

  // --- согласия: ПД обязательно, рассылка — отдельная галочка, по умолчанию нет ---
  const consents = section('consents');
  let marketing = false;
  if (consents) {
    if (consents.personalData !== true) err('consents.personalData', 'PD_CONSENT_REQUIRED');
    if (consents.marketing === true) marketing = true;
    else if (
      consents.marketing !== undefined &&
      consents.marketing !== null &&
      consents.marketing !== false
    ) {
      err('consents.marketing', 'INVALID_TYPE');
    }
  }

  if (errors.length) {
    throw new OrderError(422, 'VALIDATION_ERROR', 'Проверьте поля формы', { fields: errors });
  }
  if (paymentMethod === 'online' && !opts.onlinePayment) {
    throw new OrderError(
      422,
      'PAYMENT_METHOD_UNAVAILABLE',
      'Онлайн-оплата пока недоступна: выберите оплату при получении',
    );
  }

  return {
    customer: {
      name: name!,
      phone: phone!,
      phoneNormalized: phoneNormalized!,
      email: email!,
    },
    delivery: { method: method!, city, address, pvzCode },
    payment: { method: paymentMethod! },
    comment,
    items,
    expectedTotalKop,
    consents: { personalData: true, marketing },
  };
}
