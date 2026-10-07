import path from 'node:path';
import { access } from 'node:fs/promises';
import { parseImportXmlFile, type ParseImportOptions } from './import-parser.js';
import type { CatalogRepository, ImportCounters, ImportMeta, ImportSummary } from './types.js';

export interface ImportRunResult extends ImportSummary {
  encoding: string;
}

/** Каталоги spool, в которых может лежать собранный файл выгрузки. */
const SPOOL_SUBDIRS = ['unpacked', 'inbox'] as const;

/**
 * Где искать собранный файл выгрузки: 1С присылает либо zip (мы распаковали
 * его в spool/unpacked), либо сами xml по mode=file (они лежат в spool/inbox).
 * Возвращает абсолютный путь или null. Каждый кандидат проверяется на выход
 * за пределы СВОЕГО подкаталога, а не только за пределы spool.
 */
export async function findImportFile(spoolDir: string, relative: string): Promise<string | null> {
  for (const sub of SPOOL_SUBDIRS) {
    const base = path.resolve(spoolDir, sub);
    const candidate = path.resolve(base, relative);
    if (!candidate.startsWith(base + path.sep)) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // следующий каталог
    }
  }
  return null;
}

/**
 * Загрузка import.xml в staging: потоковый разбор + идемпотентная запись.
 * Результат пишется в catalog_import_runs, счётчики возвращаются наружу
 * (их же сверяем с 1С на этапе 6).
 */
export async function importCatalogFile(
  repo: CatalogRepository,
  filePath: string,
  filename: string,
  opts: ParseImportOptions = {},
): Promise<ImportRunResult> {
  await repo.ready();
  const startedAt = Date.now();
  let meta: ImportMeta = { schemaVersion: null, generatedAt: null, onlyChanges: false };
  // Прогон открываем до разбора: иначе обрыв до первого батча нигде не виден,
  // а СодержитТолькоИзменения из шапки дошло бы в журнал не всегда.
  const runId = await repo.startRun(filename, meta);
  // Записано фактически на момент отказа: «failure и ноль» вводит в
  // заблуждение, если половина каталога уже закоммичена (ревью, находка 5).
  const written: ImportCounters = {
    categories: 0,
    brands: 0,
    properties: 0,
    products: 0,
    variants: 0,
    images: 0,
  };

  try {
    const dictionary = opts.dictionary ?? (await repo.loadDictionary());
    const result = await parseImportXmlFile(
      filePath,
      {
        onMeta: (m) => {
          meta = m;
        },
        onCategories: async (items) => {
          await repo.upsertCategories(items);
          written.categories += items.length;
        },
        onBrands: async (items) => {
          await repo.upsertBrands(items);
          written.brands += items.length;
        },
        onProperties: async (items) => {
          await repo.upsertProperties(items);
          written.properties += items.length;
        },
        onProducts: async (items) => {
          await repo.upsertProducts(items);
          written.products += items.length;
          written.images += items.reduce((n, p) => n + p.images.length, 0);
        },
        onVariants: async (items) => {
          await repo.upsertVariants(items);
          written.variants += items.length;
          written.images += items.reduce((n, v) => n + v.images.length, 0);
        },
      },
      { ...opts, fileName: filename, dictionary },
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
    await repo.finishRun(runId, {
      counters: written,
      meta,
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
