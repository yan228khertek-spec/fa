import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from './config.js';
import { exchangePlugin } from './exchange/plugin.js';
import { ImportJobRegistry } from './exchange/import-jobs.js';
import type { ExchangeLogSink } from './log/types.js';
import { MemoryExchangeLog } from './log/memory.js';
import { PgExchangeLog } from './log/pg.js';
import type { CatalogRepository } from './catalog/types.js';
import { MemoryCatalogRepository } from './catalog/memory.js';
import { PgCatalogRepository } from './catalog/pg.js';
import type { OffersRepository } from './offers/types.js';
import { MemoryOffersRepository } from './offers/memory.js';
import { PgOffersRepository } from './offers/pg.js';

export interface BuildAppOptions {
  config?: AppConfig;
  logSink?: ExchangeLogSink;
  catalog?: CatalogRepository;
  offers?: OffersRepository;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();
  const logSink =
    opts.logSink ??
    (config.databaseUrl ? new PgExchangeLog(config.databaseUrl) : new MemoryExchangeLog());
  // Без DATABASE_URL каталог живёт в памяти — как журнал обмена: dev и тесты
  // работают без БД, прод пишет в PostgreSQL (миграции 001–002).
  const catalog =
    opts.catalog ??
    (config.databaseUrl
      ? new PgCatalogRepository(config.databaseUrl)
      : new MemoryCatalogRepository());
  // Предложения (offers.xml, этап 3) — отдельное хранилище, та же логика выбора.
  const offers =
    opts.offers ??
    (config.databaseUrl
      ? new PgOffersRepository(config.databaseUrl)
      : new MemoryOffersRepository());
  const jobs = new ImportJobRegistry();

  const app = Fastify({
    logger: !config.quiet,
    // Глобальный лимит тела маленький: большие тела легальны только в
    // /api/1c-exchange mode=file, где поток пишется на диск и ограничен
    // config.fileLimit внутри appendChunk (ревью этапа 0, пункт 2).
    bodyLimit: 1024 * 1024,
  });

  app.get('/healthz', async (_req, reply) => reply.type('text/plain; charset=utf-8').send('ok'));

  await app.register(exchangePlugin, { config, logSink, catalog, offers, jobs });

  app.addHook('onClose', async () => {
    // Фоновая загрузка каталога должна дописаться до закрытия пулов.
    await jobs.drain();
    await catalog.close();
    await offers.close();
    await logSink.close();
  });

  return app;
}
