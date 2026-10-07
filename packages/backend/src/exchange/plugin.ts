import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import type { AppConfig } from '../config.js';
import type { ExchangeLogSink } from '../log/types.js';
import type { CatalogRepository } from '../catalog/types.js';
import { findImportFile, importCatalogFile } from '../catalog/import-runner.js';
import { ImportParseError } from '../catalog/import-parser.js';
import type { OffersRepository } from '../offers/types.js';
import { importOffersFile } from '../offers/offers-runner.js';
import { SESSION_COOKIE, checkBasicAuth, createSession, isAuthorized } from './auth.js';
import {
  appendChunk,
  isZip,
  safeRelativeName,
  resetSpool,
  unzipPendingArchives,
  unzipSafely,
} from './files.js';
import { type ImportJobRegistry, settleWithin } from './import-jobs.js';
import { emptyCommerceInfoXml, sendFailure, sendPlain, sendSuccess, sendXml } from './protocol.js';

interface ExchangeQuery {
  type?: string;
  mode?: string;
  filename?: string;
}

export interface ExchangeOptions {
  config: AppConfig;
  logSink: ExchangeLogSink;
  catalog: CatalogRepository;
  offers: OffersRepository;
  /** Реестр фоновых загрузок — создаётся в buildApp, он же их и дожидается. */
  jobs: ImportJobRegistry;
}

/** Файл выгрузки не доехал: куска нет ни в inbox, ни в unpacked. */
class ImportFileMissing extends Error {}

/**
 * Что сказать 1С при отказе. Внутренние тексты (пути, сообщения PostgreSQL)
 * наружу не отдаём — они уходят в exchange_log (ревью этапа 2, п. 14).
 */
function failureReason(err: unknown): string {
  if (err instanceof ImportFileMissing) return 'Файл выгрузки не найден';
  if (err instanceof ImportParseError) return `Ошибка разбора выгрузки: ${err.message}`;
  return 'Внутренняя ошибка загрузки каталога, см. журнал обмена';
}

/** import.xml, import0_1.xml, …: 1С нумерует части выгрузки. */
function classifyImportFile(relative: string): 'catalog' | 'offers' | 'other' {
  const base = path.basename(relative).toLowerCase();
  if (!base.endsWith('.xml')) return 'other';
  if (base.startsWith('import')) return 'catalog';
  if (base.startsWith('offers')) return 'offers';
  return 'other';
}

/**
 * Endpoint штатного «Обмена с сайтом» 1С (CommerceML 2).
 * Последовательность 1С: checkauth → init → file (чанками) → import.
 * Ответы — plain text windows-1251, формат байт-точный (см. скилл commerceml-exchange).
 */
export async function exchangePlugin(app: FastifyInstance, opts: ExchangeOptions): Promise<void> {
  const { config, logSink, catalog, offers, jobs } = opts;
  const inboxDir = path.join(config.spoolDir, 'inbox');
  const unpackedDir = path.join(config.spoolDir, 'unpacked');

  // Тело POST не буферизуем: отдаём сырой поток обработчику.
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  const log = async (
    req: FastifyRequest,
    q: ExchangeQuery,
    bodyBytes: number,
    result: string,
    detail: string | null = null,
  ) => {
    try {
      await logSink.write({
        at: new Date(),
        type: q.type ?? '',
        mode: q.mode ?? '',
        filename: q.filename ?? null,
        bodyBytes,
        result,
        detail,
      });
    } catch (err) {
      req.log.error({ err }, 'exchange_log write failed');
    }
  };

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as ExchangeQuery;
    const mode = q.mode ?? '';
    const type = q.type ?? '';

    // --- без авторизации доступен только checkauth ---
    if (mode === 'checkauth') {
      if (!checkBasicAuth(req, config.exchangeLogin, config.exchangePassword)) {
        await log(req, q, 0, 'failure', 'bad credentials');
        return sendFailure(reply, 'Неверный логин или пароль');
      }
      const token = createSession();
      reply.header('set-cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/`);
      await log(req, q, 0, 'success', null);
      // Ровно три строки: success, имя cookie, значение cookie.
      return sendPlain(reply, ['success', SESSION_COOKIE, token]);
    }

    if (!isAuthorized(req, config.exchangeLogin, config.exchangePassword)) {
      await log(req, q, 0, 'failure', 'no session');
      return sendFailure(reply, 'Нет сессии обмена — выполните checkauth');
    }

    switch (`${type}:${mode}`) {
      case 'catalog:init':
        // Начало новой выгрузки: чистим spool, иначе куски дозапишутся
        // к файлам прошлой сессии (см. resetSpool). Задания из прошлой сессии
        // не ждём — 1С отвалилась бы по таймауту; они дописываются сами.
        try {
          jobs.clear();
          await resetSpool(inboxDir, unpackedDir);
        } catch (err) {
          await log(req, q, 0, 'failure', String(err));
          return sendFailure(reply, 'Не удалось подготовить каталог обмена');
        }
        await log(req, q, 0, 'success', `file_limit=${config.fileLimit}`);
        return sendPlain(reply, ['zip=yes', `file_limit=${config.fileLimit}`]);

      case 'catalog:file': {
        const relative = safeRelativeName(q.filename ?? '');
        if (!relative) {
          await log(req, q, 0, 'failure', `bad filename: ${q.filename ?? ''}`);
          return sendFailure(reply, 'Недопустимое имя файла');
        }
        try {
          const { bytes } = await appendChunk(
            inboxDir,
            relative,
            req.body as Readable,
            config.fileLimit,
          );
          await log(req, q, bytes, 'success', null);
          return sendSuccess(reply);
        } catch (err) {
          await log(req, q, 0, 'failure', String(err));
          return sendFailure(reply, 'Ошибка записи файла');
        }
      }

      case 'catalog:import': {
        const relative = safeRelativeName(q.filename ?? '');
        if (!relative) {
          await log(req, q, 0, 'failure', `bad filename: ${q.filename ?? ''}`);
          return sendFailure(reply, 'Недопустимое имя файла');
        }
        // 1С может вызвать import прямо на архиве — распаковываем и выходим.
        if (isZip(relative)) {
          try {
            const extracted = await unzipSafely(
              inboxDir,
              relative,
              unpackedDir,
              config.unpackLimit,
            );
            await log(req, q, 0, 'success', `unzipped ${extracted.length}`);
            return sendSuccess(reply);
          } catch (err) {
            await log(req, q, 0, 'failure', String(err));
            return sendFailure(reply, 'Файл не найден или повреждён');
          }
        }

        const kind = classifyImportFile(relative);

        if (kind === 'other') {
          await log(req, q, 0, 'success', 'не каталог — обработка не требуется');
          return sendSuccess(reply);
        }

        // --- import.xml / offers.xml: потоковый разбор в staging ---
        // Задание заводится ДО любого await: иначе ретрай 1С успевает
        // проскочить проверку и запустить второй разбор того же файла.
        // Поиск файла поэтому живёт внутри задачи.
        const job = jobs.start(relative, async () => {
          let file = await findImportFile(config.spoolDir, relative);
          if (!file) {
            // 1С присылает архив, а import вызывает именем файла ВНУТРИ него.
            await unzipPendingArchives(inboxDir, unpackedDir, config.unpackLimit).catch(() => []);
            file = await findImportFile(config.spoolDir, relative);
          }
          if (!file) throw new ImportFileMissing(`файл выгрузки ${relative} не найден в spool`);
          if (kind === 'offers') {
            const s = await importOffersFile(offers, file, relative);
            return `${s.encoding}; типов цен ${s.priceTypes}, складов ${s.warehouses}, предложений ${s.offers}, цен ${s.prices}, остатков ${s.stocks}, ${s.durationMs} мс`;
          }
          const s = await importCatalogFile(catalog, file, relative);
          return `${s.encoding}; категорий ${s.categories}, брендов ${s.brands}, свойств ${s.properties}, товаров ${s.products}, SKU ${s.variants}, картинок ${s.images}, ${s.durationMs} мс`;
        });

        const settled = await settleWithin(job, config.importWaitMs);
        if (!settled) {
          await log(req, q, 0, 'progress', `идёт загрузка ${relative}`);
          return sendPlain(reply, ['progress', 'Каталог загружается']);
        }

        const { status, detail, error } = job;
        jobs.delete(relative);
        if (status === 'failed') {
          await log(req, q, 0, 'failure', detail);
          // Подробности — в журнал; наружу только причина, пригодная оператору.
          return sendFailure(reply, failureReason(error));
        }
        await log(req, q, 0, 'success', detail);
        return sendSuccess(reply);
      }

      case 'sale:query':
        // Заглушка этапа 1: заказов пока нет — валидный пустой документ.
        await log(req, q, 0, 'success', 'empty orders');
        return sendXml(reply, emptyCommerceInfoXml());

      case 'sale:success':
        await log(req, q, 0, 'success', null);
        return sendSuccess(reply);

      default:
        await log(req, q, 0, 'failure', `unknown type/mode: ${type}/${mode}`);
        return sendFailure(reply, `Неизвестный режим: ${type}/${mode}`);
    }
  };

  app.get('/api/1c-exchange', handler);
  app.post('/api/1c-exchange', handler);
}
