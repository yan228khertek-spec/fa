import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Создаёт экземпляр приложения.
 *
 * Здесь появится endpoint /api/1c-exchange (этап 1 мастердока):
 * checkauth → init → file → import, ответы — строго plain text.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true,
    // Файлы от 1С приходят чанками до сотен МБ — лимит тела задаём явно,
    // точное значение согласуем с file_limit на этапе 1.
    bodyLimit: 512 * 1024 * 1024,
  });

  app.get('/healthz', async () => 'ok');

  return app;
}
