import pg from 'pg';
import { SITE_TICKER_DDL } from './ticker-schema.js';
import type {
  NewSchedule,
  TickerItem,
  TickerRepository,
  TickerSchedule,
  TickerStyle,
} from './ticker.js';
import { AdminError } from './types.js';

interface ScheduleRow {
  id: string;
  title: string;
  starts_on: string;
  ends_on: string;
  items: TickerItem[];
  bg_color: string;
  text_color: string;
  active: boolean;
}

// to_char: дата без часового пояса — ровно ГГГГ-ММ-ДД, как её ввели в админке
const COLS = `id::text, title, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
  to_char(ends_on, 'YYYY-MM-DD') AS ends_on, items, bg_color, text_color, active`;

const view = (r: ScheduleRow): TickerSchedule => ({
  id: Number(r.id),
  title: r.title,
  startsOn: r.starts_on,
  endsOn: r.ends_on,
  items: r.items,
  bgColor: r.bg_color,
  textColor: r.text_color,
  active: r.active,
});

export class PgTickerRepository implements TickerRepository {
  private readonly pool: pg.Pool;
  private prepared: Promise<unknown> | undefined;

  constructor(databaseUrl: string, poolSize = 3) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: poolSize });
  }

  ready(): Promise<void> {
    this.prepared ??= this.pool.query(SITE_TICKER_DDL).catch((err: unknown) => {
      this.prepared = undefined;
      throw err;
    });
    return this.prepared.then(() => undefined);
  }

  async getDefault(): Promise<TickerStyle | null> {
    await this.ready();
    const { rows } = await this.pool.query<{
      items: TickerItem[];
      bg_color: string;
      text_color: string;
    }>('SELECT items, bg_color, text_color FROM site_ticker_default WHERE id = 1');
    const r = rows[0];
    return r ? { items: r.items, bgColor: r.bg_color, textColor: r.text_color } : null;
  }

  async setDefault(style: TickerStyle): Promise<void> {
    await this.ready();
    await this.pool.query(
      `INSERT INTO site_ticker_default (id, items, bg_color, text_color)
       VALUES (1, $1::jsonb, $2, $3)
       ON CONFLICT (id) DO UPDATE SET items = $1::jsonb, bg_color = $2, text_color = $3,
         updated_at = now()`,
      [JSON.stringify(style.items), style.bgColor, style.textColor],
    );
  }

  async resetDefault(): Promise<void> {
    await this.ready();
    await this.pool.query('DELETE FROM site_ticker_default WHERE id = 1');
  }

  async listSchedules(): Promise<TickerSchedule[]> {
    await this.ready();
    const { rows } = await this.pool.query<ScheduleRow>(
      `SELECT ${COLS} FROM site_ticker_schedules ORDER BY starts_on, id`,
    );
    return rows.map(view);
  }

  async createSchedule(i: NewSchedule): Promise<TickerSchedule> {
    await this.ready();
    const { rows } = await this.pool.query<ScheduleRow>(
      `INSERT INTO site_ticker_schedules (title, starts_on, ends_on, items, bg_color, text_color, active)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING ${COLS}`,
      [i.title, i.startsOn, i.endsOn, JSON.stringify(i.items), i.bgColor, i.textColor, i.active],
    );
    return view(rows[0]!);
  }

  async updateSchedule(id: number, i: NewSchedule): Promise<TickerSchedule> {
    await this.ready();
    const { rows } = await this.pool.query<ScheduleRow>(
      `UPDATE site_ticker_schedules SET title = $2, starts_on = $3, ends_on = $4,
         items = $5::jsonb, bg_color = $6, text_color = $7, active = $8, updated_at = now()
       WHERE id = $1 RETURNING ${COLS}`,
      [
        id,
        i.title,
        i.startsOn,
        i.endsOn,
        JSON.stringify(i.items),
        i.bgColor,
        i.textColor,
        i.active,
      ],
    );
    if (!rows[0]) throw new AdminError('Период не найден', 404);
    return view(rows[0]);
  }

  async deleteSchedule(id: number): Promise<void> {
    await this.ready();
    const { rowCount } = await this.pool.query('DELETE FROM site_ticker_schedules WHERE id = $1', [
      id,
    ]);
    if (!rowCount) throw new AdminError('Период не найден', 404);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
