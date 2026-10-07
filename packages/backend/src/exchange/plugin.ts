import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import type { AppConfig } from '../config.js';
import type { ExchangeLogSink } from '../log/types.js';
import { SESSION_COOKIE, checkBasicAuth, createSession, isAuthorized } from './auth.js';
import { appendChunk, isZip, safeRelativeName, unzipSafely } from './files.js';
import { emptyCommerceInfoXml, sendFailure, sendPlain, sendSuccess, sendXml } from './protocol.js';

interface ExchangeQuery {
  type?: string;
  mode?: string;
  filename?: string;
}

export interface ExchangeOptions {
  config: AppConfig;
  logSink: ExchangeLogSink;
}

/**
 * Endpoint штатного «Обмена с сайтом» 1С (CommerceML 2).
 * Последовательность 1С: checkauth → init → file (чанками) → import.
 * Ответы — plain text windows-1251, формат байт-точный (см. скилл commerceml-exchange).
 */
export async function exchangePlugin(app: FastifyInstance, opts: ExchangeOptions): Promise<void> {
  const { config, logSink } = opts;
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
        try {
          // Этап 1: файл собран — если это zip, распаковываем; сам парсинг
          // import.xml/offers.xml подключается на этапах 2–3.
          const extracted = isZip(relative)
            ? await unzipSafely(inboxDir, relative, unpackedDir)
            : [];
          await log(req, q, 0, 'success', extracted.length ? `unzipped ${extracted.length}` : null);
          return sendSuccess(reply);
        } catch (err) {
          await log(req, q, 0, 'failure', String(err));
          return sendFailure(reply, 'Файл не найден или повреждён');
        }
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
