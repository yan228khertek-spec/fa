import { parseOffersXmlFile, type ParseOffersOptions } from './offers-parser.js';
import type { OffersCounters, OffersMeta, OffersRepository, OffersSummary } from './types.js';

export interface OffersRunResult extends OffersSummary {
  encoding: string;
}

/**
 * Загрузка offers.xml в staging: потоковый разбор + идемпотентная запись.
 * Зеркало importCatalogFile (этап 2): прогон открывается до разбора, при
 * отказе в журнал пишутся фактически записанные счётчики, а не нули.
 */
export async function importOffersFile(
  repo: OffersRepository,
  filePath: string,
  filename: string,
  opts: ParseOffersOptions = {},
): Promise<OffersRunResult> {
  await repo.ready();
  const startedAt = Date.now();
  let meta: OffersMeta = { schemaVersion: null, generatedAt: null, onlyChanges: false };
  const runId = await repo.startRun(filename, meta);
  const written: OffersCounters = { priceTypes: 0, warehouses: 0, offers: 0, prices: 0, stocks: 0 };

  try {
    const result = await parseOffersXmlFile(
      filePath,
      {
        onMeta: (m) => {
          meta = m;
        },
        onPriceTypes: async (items) => {
          await repo.upsertPriceTypes(items);
          written.priceTypes += items.length;
        },
        onWarehouses: async (items) => {
          await repo.upsertWarehouses(items);
          written.warehouses += items.length;
        },
        onOffers: async (items) => {
          await repo.upsertOffers(items);
          written.offers += items.length;
          written.prices += items.reduce((n, o) => n + (o.prices?.length ?? 0), 0);
          written.stocks += items.reduce((n, o) => n + (o.stocks?.length ?? 0), 0);
        },
      },
      { ...opts, fileName: filename },
    );
    await repo.finishRun(runId, {
      counters: result.counters,
      meta: result.meta,
      status: 'success',
    });
    return {
      ...result.counters,
      filename,
      meta: result.meta,
      encoding: result.encoding,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    // Отказ finishRun (БД отвалилась между батчем и финишем) не должен
    // подменять исходную причину в журнале обмена (ревью этапа 3, находка 2).
    await repo
      .finishRun(runId, {
        counters: written,
        meta,
        status: 'failure',
        error: err instanceof Error ? err.message : String(err),
      })
      .catch(() => undefined);
    throw err;
  }
}
