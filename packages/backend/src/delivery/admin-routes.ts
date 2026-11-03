import type { FastifyInstance } from 'fastify';
import { RateLimiter } from '../orders/plugin.js';
import { CdekError, type CdekCalculator } from './cdek.js';
import { parseCdekInput } from './validate.js';

/** Register only inside the existing authenticated, CSRF-protected admin scope. */
export function registerCdekRoutes(adm: FastifyInstance, calculator?: CdekCalculator): void {
  const limiter = new RateLimiter(20, 60000);
  adm.post('/admin/api/cdek/calculate', { bodyLimit: 32 * 1024 }, async (req, reply) => {
    if (limiter.hit(req.ip))
      return reply.code(429).header('retry-after', '60').send({ error: 'CDEK_RATE_LIMITED' });
    if (!calculator) return reply.code(503).send({ error: 'CDEK_DISABLED' });
    try {
      return await calculator.calculate(parseCdekInput(req.body));
    } catch (error) {
      if (error instanceof CdekError) return reply.code(error.status).send({ error: error.code });
      // Do not log provider exceptions: they may contain request credentials or addresses.
      return reply.code(503).send({ error: 'CDEK_UNAVAILABLE' });
    }
  });
}
