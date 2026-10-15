import { describe, expect, it } from 'vitest';
import { requestHash } from '../src/orders/service.js';
import { OrderError } from '../src/orders/types.js';
import { normalizePhone, parseOrderInput, toKopecks } from '../src/orders/validate.js';

const valid = () => ({
  customer: { name: '  Анна   Петрова ', phone: '8 (913) 123-45-67', email: ' Anna@Mail.RU ' },
  delivery: { method: 'cdek', city: 'Омск', address: 'ул. Ленина, 10', pvzCode: null },
  payment: { method: 'on_receipt' },
  comment: 'Позвоните\nза час',
  items: [{ cardId: 1, variantId: 'm1#a', quantity: 2, price: 8000 }],
  consents: { personalData: true },
});

const fieldsOf = (fn: () => unknown): { field: string; code: string }[] => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OrderError);
    return ((err as OrderError).extra.fields as { field: string; code: string }[]) ?? [];
  }
  throw new Error('ожидалась ошибка валидации');
};
const parse = (b: unknown) => parseOrderInput(b, { onlinePayment: false });

describe('normalizePhone — ключ будущего личного кабинета', () => {
  it.each([
    ['+7 913 123-45-67', '+79131234567'],
    ['8 (913) 123-45-67', '+79131234567'],
    ['7-913-123-45-67', '+79131234567'],
    ['9131234567', '+79131234567'],
    ['+7 (3812) 39-00-77', '+73812390077'],
    ['8.913.123.45.67', '+79131234567'],
  ])('%s → %s', (raw, want) => expect(normalizePhone(raw)).toBe(want));

  it.each([
    '',
    '123',
    '+8 913 123 45 67',
    '+1 202 555 0100',
    '89131234567x',
    '8913123456789',
    '+7913',
  ])('отклоняет %j', (raw) => expect(normalizePhone(raw)).toBeNull());
});

describe('toKopecks', () => {
  it('рубли с копейками → целые копейки без плавающей ошибки', () => {
    expect(toKopecks(18990)).toBe(1899000);
    expect(toKopecks(0.1)).toBe(10);
    expect(toKopecks(499.99)).toBe(49999);
  });
  it('отклоняет 0, отрицательные, NaN, строки и больше двух знаков', () => {
    for (const v of [0, -1, Number.NaN, '100', 1.005, Infinity]) expect(toKopecks(v)).toBeNull();
    expect(toKopecks(0, true)).toBe(0);
  });
});

describe('parseOrderInput', () => {
  it('нормализует контакт и сохраняет многострочный комментарий', () => {
    const r = parse(valid());
    expect(r.customer).toEqual({
      name: 'Анна Петрова',
      phone: '8 (913) 123-45-67',
      phoneNormalized: '+79131234567',
      email: 'anna@mail.ru',
    });
    expect(r.comment).toBe('Позвоните\nза час');
    expect(r.items).toEqual([{ cardId: 1, variantId: 'm1#a', quantity: 2, priceKop: 800000 }]);
    expect(r.consents).toEqual({ personalData: true, marketing: false });
    expect(r.expectedTotalKop).toBeNull();
  });

  it('email ОБЯЗАТЕЛЕН и проверяется', () => {
    const b = valid();
    delete (b.customer as Partial<typeof b.customer>).email;
    expect(fieldsOf(() => parse(b))).toContainEqual({ field: 'customer.email', code: 'REQUIRED' });
    expect(
      fieldsOf(() => parse({ ...valid(), customer: { ...valid().customer, email: 'a@b' } })),
    ).toContainEqual({ field: 'customer.email', code: 'INVALID_EMAIL' });
  });

  it('согласие на ПД обязательно; на рассылку — отдельно и по умолчанию нет', () => {
    expect(fieldsOf(() => parse({ ...valid(), consents: { personalData: false } }))).toEqual([
      { field: 'consents.personalData', code: 'PD_CONSENT_REQUIRED' },
    ]);
    expect(fieldsOf(() => parse({ ...valid(), consents: undefined }))).toContainEqual({
      field: 'consents',
      code: 'REQUIRED',
    });
    const r = parse({ ...valid(), consents: { personalData: true, marketing: true } });
    expect(r.consents.marketing).toBe(true);
    // «Галочка» строкой — не согласие
    expect(
      fieldsOf(() => parse({ ...valid(), consents: { personalData: true, marketing: 'yes' } })),
    ).toEqual([{ field: 'consents.marketing', code: 'INVALID_TYPE' }]);
  });

  it('СДЭК требует город и адрес; самовывоз адрес игнорирует', () => {
    const f = fieldsOf(() => parse({ ...valid(), delivery: { method: 'cdek' } }));
    expect(f).toEqual([
      { field: 'delivery.city', code: 'REQUIRED' },
      { field: 'delivery.address', code: 'REQUIRED' },
    ]);
    const pickup = parse({
      ...valid(),
      delivery: { method: 'pickup', city: 'Омск', address: 'что-то', pvzCode: 'X' },
    });
    expect(pickup.delivery).toEqual({ method: 'pickup', city: null, address: null, pvzCode: null });
    expect(
      fieldsOf(() =>
        parse({ ...valid(), delivery: { ...valid().delivery, pvzCode: 'OMS 12;DROP' } }),
      ),
    ).toEqual([{ field: 'delivery.pvzCode', code: 'INVALID_FORMAT' }]);
    expect(fieldsOf(() => parse({ ...valid(), delivery: { method: 'post' } }))).toEqual([
      { field: 'delivery.method', code: 'INVALID_VALUE' },
    ]);
  });

  it('онлайн-оплата до F4 — PAYMENT_METHOD_UNAVAILABLE', () => {
    expect(() => parse({ ...valid(), payment: { method: 'online' } })).toThrow(
      expect.objectContaining({ code: 'PAYMENT_METHOD_UNAVAILABLE', status: 422 }),
    );
    expect(
      parseOrderInput({ ...valid(), payment: { method: 'online' } }, { onlinePayment: true })
        .payment.method,
    ).toBe('online');
  });

  it('позиции: количество 1–10, дубли SKU, цена, лимит строк', () => {
    const items = [
      { cardId: 1, variantId: 'm1#a', quantity: 0, price: 100 },
      { cardId: 1, variantId: 'm1#b', quantity: 11, price: 100 },
      { cardId: 1, variantId: 'm1#c', quantity: 1.5, price: 100 },
      { cardId: 1, variantId: 'm1#d', quantity: 1, price: -5 },
      { cardId: 1, variantId: 'm1#e', quantity: 1, price: 100 },
      { cardId: 1, variantId: 'm1#e', quantity: 1, price: 100 },
      { cardId: 0, variantId: 'm1#f', quantity: 1, price: 100 },
      { cardId: 1, variantId: 'm1 f', quantity: 1, price: 100 },
      'строка',
    ];
    expect(fieldsOf(() => parse({ ...valid(), items }))).toEqual([
      { field: 'items[0].quantity', code: 'INVALID_QUANTITY' },
      { field: 'items[1].quantity', code: 'INVALID_QUANTITY' },
      { field: 'items[2].quantity', code: 'INVALID_QUANTITY' },
      { field: 'items[3].price', code: 'INVALID_VALUE' },
      { field: 'items[5].variantId', code: 'DUPLICATE_ITEM' },
      { field: 'items[6].cardId', code: 'INVALID_VALUE' },
      { field: 'items[7].variantId', code: 'INVALID_FORMAT' },
      { field: 'items[8]', code: 'INVALID_TYPE' },
    ]);
    expect(fieldsOf(() => parse({ ...valid(), items: [] }))).toEqual([
      { field: 'items', code: 'REQUIRED' },
    ]);
    const many = Array.from({ length: 31 }, (_, i) => ({
      cardId: 1,
      variantId: `m1#${i}`,
      quantity: 1,
      price: 1,
    }));
    expect(fieldsOf(() => parse({ ...valid(), items: many }))).toEqual([
      { field: 'items', code: 'TOO_MANY_ITEMS' },
    ]);
  });

  it('управляющие символы и длины полей', () => {
    const f = fieldsOf(() =>
      parse({
        ...valid(),
        customer: { name: 'А', phone: '+7 913 123 45 67', email: 'a@b.ru' },
        comment: 'x'.repeat(1001),
      }),
    );
    expect(f).toEqual([
      { field: 'customer.name', code: 'TOO_SHORT' },
      { field: 'comment', code: 'TOO_LONG' },
    ]);
    expect(
      fieldsOf(() =>
        parse({ ...valid(), customer: { ...valid().customer, name: 'Анна\nПетрова' } }),
      ),
    ).toEqual([{ field: 'customer.name', code: 'INVALID_FORMAT' }]);
    expect(fieldsOf(() => parse({ ...valid(), comment: 'a\u0000b' }))).toEqual([
      { field: 'comment', code: 'INVALID_FORMAT' },
    ]);
  });

  it('все ошибки разом; не объект — ошибка', () => {
    expect(fieldsOf(() => parse({})).map((e) => e.field)).toEqual([
      'customer',
      'delivery',
      'payment',
      'items',
      'consents',
    ]);
    expect(() => parse([])).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => parse(null)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('неизвестные поля отбрасываются и не влияют на хеш идемпотентности', () => {
    const a = parse(valid());
    const b = parse({ ...valid(), utm: 'x', customer: { ...valid().customer, role: 'admin' } });
    expect(b).toEqual(a);
    expect(requestHash(b)).toBe(requestHash(a));
    const c = parse({ ...valid(), comment: 'другое' });
    expect(requestHash(c)).not.toBe(requestHash(a));
  });
});
