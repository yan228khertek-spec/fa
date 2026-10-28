import { DEFAULT_ORDERS_CONFIG, type OrdersConfig } from './orders/types.js';
import { DEFAULT_SALE_EXPORT_CONFIG, type SaleExportConfig } from './orders/export.js';

/** Витринный слой брендов и админка (миграция 004). */
export interface AdminConfig {
  /** Basic auth админки. Пусто — админка выключена, публичное API брендов работает. */
  login: string;
  password: string;
  /** Дополнительные полноценные аккаунты (ADMIN_LOGIN_2/ADMIN_PASSWORD_2, _3): права те же, что у основного. */
  extraUsers?: { login: string; password: string }[];
  /** Каталог для загруженных фото и логотипов брендов (в проде — volume). */
  uploadsDir: string;
  /** Публичный адрес бэкенда (https://…), чтобы API отдавало абсолютные ссылки; пусто — относительные. */
  publicBaseUrl: string;
  /** Откуда сайт берёт фото товаров из 1С; по умолчанию `${publicBaseUrl}/images/` (план A2). */
  imagesBaseUrl: string;
}

export interface AppConfig {
  port: number;
  host: string;
  /** Логин/пароль Basic auth для «Обмена с сайтом» (1С). Только из env. */
  exchangeLogin: string;
  exchangePassword: string;
  /** Максимальный размер одного POST-куска от 1С, байт (ответ init: file_limit). */
  fileLimit: number;
  /** Каталог, куда складываются принятые файлы обмена. */
  spoolDir: string;
  /**
   * Постоянное хранилище фото из 1С (A2/M1): после успешного import сюда
   * переносится spool/unpacked/import_files, отсюда их отдаёт Caddy по
   * /images/*. Пусто — хранилище выключено (dev/тесты без тома).
   */
  mediaDir: string;
  /**
   * Сколько ждать завершения разбора import.xml перед ответом `progress`, мс.
   * Короткие выгрузки успевают за один запрос, длинные грузятся в фоне.
   */
  importWaitMs: number;
  /** Предел суммарного распакованного размера одного zip, байт. */
  unpackLimit: number;
  /** Строка подключения PostgreSQL; пусто — журнал пишется в память (dev/тесты). */
  databaseUrl: string | undefined;
  /**
   * Тип цены 1С, который витрина показывает как цену товара (имя из ТипыЦен).
   * Пусто — цена = минимум по всем типам (легаси). Решение 13.10: «Розничные».
   */
  sitePriceType: string;
  /**
   * Склад 1С, по которому считается остаток витрины (имя из Склады).
   * Пусто — сумма по всем складам, включая общий остаток (легаси; двоит остатки).
   * Решение 13.10: «Касса ТЗ 2 Fashion Avenue».
   */
  siteWarehouse: string;
  /** Отключает логгер (тесты). */
  quiet: boolean;
  /** Админка брендов; не задано — модуль не подключается (старые тесты и dev без неё). */
  admin?: AdminConfig;
  /** За reverse-proxy (Caddy): брать адрес клиента из X-Forwarded-For. */
  trustProxy?: boolean;
  /** Приём заказов (F1). Не задано — значения по умолчанию (DEFAULT_ORDERS_CONFIG). */
  orders?: OrdersConfig;
  /** Выгрузка заказов в 1С (F2, sale:query). Не задано — DEFAULT_SALE_EXPORT_CONFIG. */
  saleExport?: SaleExportConfig;
}

/**
 * Сумма в рублях из env: не задано → fallback; пустая строка → null, только если `nullable`
 * (иначе ошибка: пустой тариф не должен тихо стать бесплатной доставкой);
 * не число или < 0 — ошибка старта (деньги не угадываем).
 */
function money(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number | null,
  nullable = false,
): number | null {
  const raw = env[key]?.trim();
  if (raw === undefined) return fallback;
  if (raw === '') {
    if (nullable) return null;
    throw new Error(`${key}: пусто — задайте сумму в рублях или уберите переменную`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key}: ожидается сумма в рублях ≥ 0`);
  return n;
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${key}: ожидается целое > 0`);
  return n;
}

export function loadOrdersConfig(env: NodeJS.ProcessEnv = process.env): OrdersConfig {
  const d = DEFAULT_ORDERS_CONFIG;
  const enabled = (env.ORDERS_ENABLED ?? '1').trim().toLowerCase();
  return {
    enabled: !['0', 'false', 'no', 'off'].includes(enabled),
    cdekFee: money(env, 'ORDER_CDEK_FEE', d.cdekFee)!,
    freeDeliveryFrom: money(env, 'ORDER_FREE_DELIVERY_FROM', d.freeDeliveryFrom, true),
    pickupAddress: env.ORDER_PICKUP_ADDRESS?.trim() ?? d.pickupAddress,
    offerVersion: env.ORDER_OFFER_VERSION?.trim() || d.offerVersion,
    pdPolicyVersion: env.ORDER_PD_POLICY_VERSION?.trim() || d.pdPolicyVersion,
    marketingConsentVersion:
      env.ORDER_MARKETING_CONSENT_VERSION?.trim() || d.marketingConsentVersion,
    // Онлайн-оплата включается вместе с интеграцией ЮKassa (F4), не переменной окружения.
    onlinePayment: false,
    rateLimit: positiveInt(env, 'ORDER_RATE_LIMIT', d.rateLimit),
    rateWindowMs: positiveInt(env, 'ORDER_RATE_WINDOW_MS', d.rateWindowMs),
  };
}

export function loadSaleExportConfig(env: NodeJS.ProcessEnv = process.env): SaleExportConfig {
  const d = DEFAULT_SALE_EXPORT_CONFIG;
  return {
    schemaVersion: env.SALE_SCHEMA_VERSION?.trim() || d.schemaVersion,
    timeZone: env.SALE_TIME_ZONE?.trim() || d.timeZone,
    // Идентичность продавца (ИП Астафьев) — через env, в код не зашита; пусто → не выводится.
    sellerName: env.SALE_SELLER_NAME?.trim() ?? d.sellerName,
    sellerInn: env.SALE_SELLER_INN?.trim() ?? d.sellerInn,
    batchLimit: positiveInt(env, 'SALE_BATCH_LIMIT', d.batchLimit),
  };
}

/** Дополнительные аккаунты админки: пары ADMIN_LOGIN_n / ADMIN_PASSWORD_n, n = 2…5; неполная пара игнорируется. */
export function loadExtraAdmins(env: NodeJS.ProcessEnv): { login: string; password: string }[] {
  const users: { login: string; password: string }[] = [];
  for (let n = 2; n <= 5; n++) {
    const login = env[`ADMIN_LOGIN_${n}`] ?? '';
    const password = env[`ADMIN_PASSWORD_${n}`] ?? '';
    if (login && password) users.push({ login, password });
  }
  return users;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    exchangeLogin: env.EXCHANGE_LOGIN ?? '',
    exchangePassword: env.EXCHANGE_PASSWORD ?? '',
    fileLimit: Number(env.EXCHANGE_FILE_LIMIT ?? 10 * 1024 * 1024),
    spoolDir: env.EXCHANGE_SPOOL_DIR ?? 'spool',
    mediaDir: env.EXCHANGE_MEDIA_DIR ?? 'media',
    importWaitMs: Number(env.EXCHANGE_IMPORT_WAIT_MS ?? 5000),
    unpackLimit: Number(env.EXCHANGE_UNPACK_LIMIT ?? 2 * 1024 * 1024 * 1024),
    databaseUrl: env.DATABASE_URL || undefined,
    sitePriceType: env.SITE_PRICE_TYPE ?? 'Розничные',
    siteWarehouse: env.SITE_STOCK_WAREHOUSE ?? 'Касса ТЗ 2 Fashion Avenue',
    quiet: env.NODE_ENV === 'test',
    admin: {
      login: env.ADMIN_LOGIN ?? '',
      password: env.ADMIN_PASSWORD ?? '',
      extraUsers: loadExtraAdmins(env),
      uploadsDir: env.ADMIN_UPLOADS_DIR ?? 'uploads',
      publicBaseUrl: env.PUBLIC_BASE_URL ?? '',
      imagesBaseUrl: env.IMAGES_BASE_URL ?? '',
    },
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    orders: loadOrdersConfig(env),
    saleExport: loadSaleExportConfig(env),
  };
}
