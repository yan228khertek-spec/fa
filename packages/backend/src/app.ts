import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from './config.js';
import { exchangePlugin } from './exchange/plugin.js';
import type { ExchangeLogSink } from './log/types.js';
import { MemoryExchangeLog } from './log/memory.js';
import { PgExchangeLog } from './log/pg.js';

export interface BuildAppOptions {
  config?: AppConfig;
  logSink?: ExchangeLogSink;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();
  const logSink =
    opts.logSink ??
    (config.databaseUrl ? new PgExchangeLog(config.databaseUrl) : new MemoryExchangeLog());

  const app = Fastify({
    logger: !config.quiet,
    // Глобальный лимит тела маленький: большие тела легальны только в
    // /api/1c-exchange mode=file, где поток пишется на диск и ограничен
    // config.fileLimit внутри appendChunk (ревью этапа 0, пункт 2).
    bodyLimit: 1024 * 1024,
  });

  app.get('/healthz', async (_req, reply) => reply.type('text/plain; charset=utf-8').send('ok'));

  await app.register(exchangePlugin, { config, logSink });

  app.addHook('onClose', async () => {
    await logSink.close();
  });

  return app;
}
