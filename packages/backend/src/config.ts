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
  /** Строка подключения PostgreSQL; пусто — журнал пишется в память (dev/тесты). */
  databaseUrl: string | undefined;
  /** Отключает логгер (тесты). */
  quiet: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    exchangeLogin: env.EXCHANGE_LOGIN ?? '',
    exchangePassword: env.EXCHANGE_PASSWORD ?? '',
    fileLimit: Number(env.EXCHANGE_FILE_LIMIT ?? 10 * 1024 * 1024),
    spoolDir: env.EXCHANGE_SPOOL_DIR ?? 'spool',
    databaseUrl: env.DATABASE_URL || undefined,
    quiet: env.NODE_ENV === 'test',
  };
}
