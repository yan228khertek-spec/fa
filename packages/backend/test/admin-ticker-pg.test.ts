import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgTickerRepository } from '../src/admin/ticker-pg.js';
import { TickerService } from '../src/admin/ticker.js';

/** Бегущая строка против живого PostgreSQL: TEST_DATABASE_URL=postgresql://… npm test -w @fa/backend */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('бегущая строка в PostgreSQL', () => {
  let pool: pg.Pool;
  let repo: PgTickerRepository;
  let svc: TickerService;
  let clock = new Date('2026-10-15T12:00:00Z');

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2 });
    repo = new PgTickerRepository(url!);
    svc = new TickerService(repo, () => clock);
    await repo.ready();
  });
  afterAll(async () => {
    await repo.close();
    await pool.end();
  });
  beforeEach(async () => {
    clock = new Date('2026-10-15T12:00:00Z');
    await pool.query('TRUNCATE site_ticker_schedules RESTART IDENTITY');
    await pool.query('DELETE FROM site_ticker_default');
  });

  const style = {
    items: [{ text: 'Привет', link: 'club.html' }],
    bgColor: '#101010',
    textColor: '#fafafa',
  };

  it('стандартная строка: встроенная → правка → сброс', async () => {
    expect((await svc.getDefault()).isBuiltin).toBe(true);
    await svc.setDefault(style);
    expect(await repo.getDefault()).toEqual(style);
    await svc.setDefault({ ...style, bgColor: '#202020' });
    expect((await repo.getDefault())?.bgColor).toBe('#202020');
    await repo.resetDefault();
    expect(await repo.getDefault()).toBeNull();
  });

  it('периоды: даты приходят как ГГГГ-ММ-ДД, порядок по началу', async () => {
    await svc.createSchedule({
      ...style,
      title: 'Б',
      startsOn: '2026-12-01',
      endsOn: '2026-12-31',
    });
    const a = await svc.createSchedule({
      ...style,
      title: 'А',
      startsOn: '2026-11-01',
      endsOn: '2026-11-02',
    });
    expect(a).toMatchObject({ startsOn: '2026-11-01', endsOn: '2026-11-02', active: true });
    expect((await svc.listSchedules()).map((s) => s.title)).toEqual(['А', 'Б']);
    const u = await svc.updateSchedule(a.id, {
      ...style,
      title: 'А2',
      startsOn: '2026-11-01',
      endsOn: '2026-11-03',
    });
    expect(u).toMatchObject({ title: 'А2', endsOn: '2026-11-03' });
    await expect(
      svc.updateSchedule(999, {
        ...style,
        title: '',
        startsOn: '2026-11-01',
        endsOn: '2026-11-02',
        active: true,
      }),
    ).rejects.toThrow('Период не найден');
  });

  it('БД не пускает конец раньше начала', async () => {
    await expect(
      pool.query(
        `INSERT INTO site_ticker_schedules (starts_on, ends_on, items, bg_color, text_color)
         VALUES ('2026-11-10', '2026-11-01', '[]', '#000000', '#ffffff')`,
      ),
    ).rejects.toThrow();
  });

  it('текущая строка по календарю Омска', async () => {
    await svc.createSchedule({
      ...style,
      title: 'Акция',
      startsOn: '2026-11-20',
      endsOn: '2026-11-30',
      bgColor: '#c8452f',
    });
    clock = new Date('2026-11-19T18:30:00Z'); // в Омске уже 20-е
    expect((await svc.current()).source).toBe('schedule');
    clock = new Date('2026-11-30T17:59:00Z'); // 23:59 по Омску, последний день
    expect((await svc.current()).source).toBe('schedule');
    clock = new Date('2026-11-30T18:00:00Z'); // 1 декабря по Омску
    expect((await svc.current()).source).toBe('default');
  });

  it('удаление', async () => {
    const s = await svc.createSchedule({
      ...style,
      title: '',
      startsOn: '2026-11-01',
      endsOn: '2026-11-02',
    });
    await repo.deleteSchedule(s.id);
    expect(await svc.listSchedules()).toEqual([]);
    await expect(repo.deleteSchedule(s.id)).rejects.toThrow('Период не найден');
  });
});
