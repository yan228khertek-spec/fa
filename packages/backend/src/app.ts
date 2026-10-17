import path from 'node:path';
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
import { adminPlugin } from './admin/plugin.js';
import { BrandService } from './admin/service.js';
import { BannerService, type BannerRepository } from './admin/banners.js';
import { MemoryBannerRepository } from './admin/banners-memory.js';
import { PgBannerRepository } from './admin/banners-pg.js';
import {
  ffmpegCompressor,
  ffmpegPoster,
  type PosterMaker,
  type VideoCompressor,
} from './admin/video.js';
import { TickerService, type TickerRepository } from './admin/ticker.js';
import { MemoryTickerRepository } from './admin/ticker-memory.js';
import { PgTickerRepository } from './admin/ticker-pg.js';
import { CardService } from './admin/cards.js';
import { MemoryCardRepository } from './admin/cards-memory.js';
import { PgCardRepository } from './admin/cards-pg.js';
import { MemoryCatalogReader, MemorySiteBrandRepository } from './admin/memory.js';
import { PgCatalogReader, PgSiteBrandRepository } from './admin/pg.js';
import type { CardRepository, CatalogReader, SiteBrandRepository } from './admin/types.js';

export interface BuildAppOptions {
  config?: AppConfig;
  logSink?: ExchangeLogSink;
  catalog?: CatalogRepository;
  offers?: OffersRepository;
  /** Витринные бренды (миграция 004) и чтение staging-каталога для админки. */
  siteBrands?: SiteBrandRepository;
  catalogReader?: CatalogReader;
  /** Карточки товаров витрины (миграция 005). */
  cardRepo?: CardRepository;
  /** Баннеры главной (миграция 007). */
  bannerRepo?: BannerRepository;
  /** Бегущая строка главной (миграция 009). */
  tickerRepo?: TickerRepository;
  /** Сжатие видео баннеров; по умолчанию ffmpeg (в тестах подменяется). */
  videoCompressor?: VideoCompressor;
  /** Кадр из видео для постера; по умолчанию ffmpeg (в тестах подменяется). */
  posterMaker?: PosterMaker;
  /** Часы для календаря акций (тесты). */
  now?: () => Date;
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
  // Витринный слой брендов и админка: подключается, если в конфиге есть секция admin.
  const siteBrands =
    opts.siteBrands ??
    (config.databaseUrl
      ? new PgSiteBrandRepository(config.databaseUrl)
      : new MemorySiteBrandRepository());
  const catalogReader =
    opts.catalogReader ??
    (config.databaseUrl
      ? new PgCatalogReader(config.databaseUrl, {
          priceType: config.sitePriceType,
          warehouse: config.siteWarehouse,
        })
      : new MemoryCatalogReader());

  const cardRepo =
    opts.cardRepo ??
    (config.databaseUrl ? new PgCardRepository(config.databaseUrl) : new MemoryCardRepository());

  const bannerRepo =
    opts.bannerRepo ??
    (config.databaseUrl
      ? new PgBannerRepository(config.databaseUrl)
      : new MemoryBannerRepository());

  const tickerRepo =
    opts.tickerRepo ??
    (config.databaseUrl
      ? new PgTickerRepository(config.databaseUrl)
      : new MemoryTickerRepository());

  const app = Fastify({
    logger: !config.quiet,
    // Глобальный лимит тела маленький: большие тела легальны только в
    // /api/1c-exchange mode=file, где поток пишется на диск и ограничен
    // config.fileLimit внутри appendChunk (ревью этапа 0, пункт 2).
    bodyLimit: 1024 * 1024,
    trustProxy: config.trustProxy ?? false,
  });

  app.get('/healthz', async (_req, reply) => reply.type('text/plain; charset=utf-8').send('ok'));

  await app.register(exchangePlugin, { config, logSink, catalog, offers, jobs });

  if (config.admin) {
    const service = new BrandService(siteBrands, catalogReader);
    await app.register(adminPlugin, {
      admin: config.admin,
      service,
      cards: new CardService(cardRepo, catalogReader, service),
      banners: new BannerService(bannerRepo),
      ticker: new TickerService(tickerRepo, opts.now),
      videoCompressor: opts.videoCompressor ?? ffmpegCompressor(),
      posterMaker: opts.posterMaker ?? ffmpegPoster(),
      // Фото из 1С берём из постоянного хранилища, спул — запасной путь.
      imageDirs: [config.mediaDir, path.join(config.spoolDir, 'unpacked')].filter(Boolean),
    });
  }

  app.addHook('onClose', async () => {
    // Фоновая загрузка каталога должна дописаться до закрытия пулов.
    await jobs.drain();
    await catalog.close();
    await offers.close();
    await siteBrands.close();
    await cardRepo.close();
    await bannerRepo.close();
    await tickerRepo.close();
    await catalogReader.close();
    await logSink.close();
  });

  return app;
}
