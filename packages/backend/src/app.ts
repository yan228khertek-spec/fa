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
import { PostService, type PostRepository } from './admin/posts.js';
import { MemoryPostRepository } from './admin/posts-memory.js';
import { PgPostRepository } from './admin/posts-pg.js';
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
import { ordersPlugin } from './orders/plugin.js';
import { MemoryOrderRepository } from './orders/memory.js';
import { PgOrderRepository } from './orders/pg.js';
import { OrderService } from './orders/service.js';
import { DEFAULT_ORDERS_CONFIG, type OrderRepository } from './orders/types.js';
import { DEFAULT_SALE_EXPORT_CONFIG, type OrderExportSource } from './orders/export.js';

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
  /** Блог главной (миграция 016). */
  postRepo?: PostRepository;
  /** Бегущая строка главной (миграция 009). */
  tickerRepo?: TickerRepository;
  /** Сжатие видео баннеров; по умолчанию ffmpeg (в тестах подменяется). */
  videoCompressor?: VideoCompressor;
  /** Кадр из видео для постера; по умолчанию ffmpeg (в тестах подменяется). */
  posterMaker?: PosterMaker;
  /** Часы для календаря акций (тесты). */
  now?: () => Date;
  /** Заказы (миграция 014): приём (F1) и выгрузка в 1С (F2). */
  orderRepo?: OrderRepository & OrderExportSource;
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
  const orderRepo =
    opts.orderRepo ??
    (config.databaseUrl ? new PgOrderRepository(config.databaseUrl) : new MemoryOrderRepository());

  const bannerRepo =
    opts.bannerRepo ??
    (config.databaseUrl
      ? new PgBannerRepository(config.databaseUrl)
      : new MemoryBannerRepository());

  const postRepo =
    opts.postRepo ??
    (config.databaseUrl ? new PgPostRepository(config.databaseUrl) : new MemoryPostRepository());

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

  await app.register(exchangePlugin, {
    config,
    logSink,
    catalog,
    offers,
    jobs,
    // Тот же экземпляр, что обслуживает приём заказов, — отдельного пула нет.
    orders: orderRepo,
    saleExport: config.saleExport ?? DEFAULT_SALE_EXPORT_CONFIG,
  });

  const brandService = new BrandService(siteBrands, catalogReader);
  const cardService = new CardService(cardRepo, catalogReader, brandService);
  if (config.admin) {
    await app.register(adminPlugin, {
      admin: config.admin,
      service: brandService,
      cards: cardService,
      banners: new BannerService(bannerRepo),
      posts: new PostService(postRepo),
      ticker: new TickerService(tickerRepo, opts.now),
      videoCompressor: opts.videoCompressor ?? ffmpegCompressor(),
      posterMaker: opts.posterMaker ?? ffmpegPoster(),
      // Фото из 1С берём из постоянного хранилища, спул — запасной путь.
      imageDirs: [config.mediaDir, path.join(config.spoolDir, 'unpacked')].filter(Boolean),
    });
  }

  // Заказы проверяют позиции по той же выдаче, что видит витрина (CardService.orderable).
  await app.register(ordersPlugin, {
    orders: new OrderService(orderRepo, cardService, config.orders ?? DEFAULT_ORDERS_CONFIG),
  });

  app.addHook('onClose', async () => {
    // Фоновая загрузка каталога должна дописаться до закрытия пулов.
    await jobs.drain();
    await catalog.close();
    await offers.close();
    await siteBrands.close();
    await cardRepo.close();
    await bannerRepo.close();
    await postRepo.close();
    await tickerRepo.close();
    await orderRepo.close();
    await catalogReader.close();
    await logSink.close();
  });

  return app;
}
