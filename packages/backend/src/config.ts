/** Витринный слой брендов и админка (миграция 004). */
export interface AdminConfig {
  /** Basic auth админки. Пусто — админка выключена, публичное API брендов работает. */
  login: string;
  password: string;
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
   * Сколько ждать завершения разбора import.xml перед ответом `progress`, мс.
   * Короткие выгрузки успевают за один запрос, длинные грузятся в фоне.
   */
  importWaitMs: number;
  /** Предел суммарного распакованного размера одного zip, байт. */
  unpackLimit: number;
  /** Строка подключения PostgreSQL; пусто — журнал пишется в память (dev/тесты). */
  databaseUrl: string | undefined;
  /** Отключает логгер (тесты). */
  quiet: boolean;
  /** Админка брендов; не задано — модуль не подключается (старые тесты и dev без неё). */
  admin?: AdminConfig;
  /** За reverse-proxy (Caddy): брать адрес клиента из X-Forwarded-For. */
  trustProxy?: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    exchangeLogin: env.EXCHANGE_LOGIN ?? '',
    exchangePassword: env.EXCHANGE_PASSWORD ?? '',
    fileLimit: Number(env.EXCHANGE_FILE_LIMIT ?? 10 * 1024 * 1024),
    spoolDir: env.EXCHANGE_SPOOL_DIR ?? 'spool',
    importWaitMs: Number(env.EXCHANGE_IMPORT_WAIT_MS ?? 5000),
    unpackLimit: Number(env.EXCHANGE_UNPACK_LIMIT ?? 2 * 1024 * 1024 * 1024),
    databaseUrl: env.DATABASE_URL || undefined,
    quiet: env.NODE_ENV === 'test',
    admin: {
      login: env.ADMIN_LOGIN ?? '',
      password: env.ADMIN_PASSWORD ?? '',
      uploadsDir: env.ADMIN_UPLOADS_DIR ?? 'uploads',
      publicBaseUrl: env.PUBLIC_BASE_URL ?? '',
      imagesBaseUrl: env.IMAGES_BASE_URL ?? '',
    },
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  };
}
