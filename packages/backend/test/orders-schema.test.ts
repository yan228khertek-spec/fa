import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ORDERS_DDL } from '../src/orders/schema.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABLES = [
  'orders',
  'order_items',
  'order_payments',
  'order_status_history',
  'marketing_consents',
];

describe('миграция 014 и ORDERS_DDL', () => {
  it('совпадают ДОСЛОВНО: автоприменение = psql -f migrations/014', async () => {
    const file = await readFile(path.join(root, 'migrations', '014_orders.sql'), 'utf8');
    expect(ORDERS_DDL).toBe(file.replace(/\n+$/, ''));
  });

  it('идемпотентна: только CREATE … IF NOT EXISTS, ничего не удаляет', () => {
    for (const t of TABLES) expect(ORDERS_DDL).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`);
    expect(ORDERS_DDL).not.toMatch(/\bDROP\b/i);
    expect(ORDERS_DDL).not.toMatch(/\bTRUNCATE\b/i);
    expect(ORDERS_DDL).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(ORDERS_DDL).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
  });

  it('не ссылается на staging и сайтовые таблицы: заказ хранит снимок', () => {
    expect(ORDERS_DDL).not.toMatch(
      /REFERENCES\s+(products|product_variants|offers|offer_prices|offer_stocks|site_cards)\b/,
    );
  });

  it('инвариант суммы и задел F2–F5 и лояльности — в схеме', () => {
    expect(ORDERS_DDL).toContain('CHECK (total = items_total + delivery_cost - bonus_amount)');
    for (const col of [
      'user_id             bigint,',
      'bonus_amount        numeric(14,2) NOT NULL DEFAULT 0',
      'loyalty_account_ref text,',
      'phone_normalized    text NOT NULL',
      'exported_at         timestamptz,',
      'status_1c           text,',
    ]) {
      expect(ORDERS_DDL).toContain(col);
    }
    // Нормализованный телефон — с индексом: ключ будущей склейки с аккаунтом.
    expect(ORDERS_DDL).toContain('ON orders (phone_normalized)');
    // Регулярка CHECK доезжает до SQL с обратным слэшем (String.raw).
    expect(ORDERS_DDL).toContain(String.raw`'^\+7[0-9]{10}$'`);
  });
});
