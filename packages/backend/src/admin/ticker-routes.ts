import type { FastifyInstance } from 'fastify';
import { parseId } from './http.js';
import { DEFAULT_TICKER, SHOP_TIME_ZONE, type TickerService } from './ticker.js';

/** Маршруты админки бегущей строки (внутри защищённой области /admin). */
export function registerTickerRoutes(adm: FastifyInstance, ticker: TickerService): void {
  adm.get('/admin/api/ticker', async () => {
    const today = ticker.today();
    const [def, schedules, current] = await Promise.all([
      ticker.getDefault(),
      ticker.listSchedules(),
      ticker.current(today),
    ]);
    return {
      today,
      timeZone: SHOP_TIME_ZONE,
      builtin: DEFAULT_TICKER,
      default: def,
      schedules,
      current,
    };
  });

  adm.put('/admin/api/ticker/default', async (req) => {
    await ticker.setDefault((req.body ?? {}) as Record<string, unknown>);
    return ticker.getDefault();
  });

  // Вернуть стандартное содержание и цвета (те, что были до редактора)
  adm.delete('/admin/api/ticker/default', async () => {
    await ticker.repo.resetDefault();
    return ticker.getDefault();
  });

  adm.post('/admin/api/ticker/schedules', async (req, reply) =>
    reply.code(201).send(await ticker.createSchedule((req.body ?? {}) as Record<string, unknown>)),
  );

  adm.put('/admin/api/ticker/schedules/:id', async (req) =>
    ticker.updateSchedule(
      parseId((req.params as { id: string }).id, 'периода'),
      (req.body ?? {}) as Record<string, unknown>,
    ),
  );

  adm.delete('/admin/api/ticker/schedules/:id', async (req) => {
    await ticker.repo.deleteSchedule(parseId((req.params as { id: string }).id, 'периода'));
    return { ok: true };
  });
}
