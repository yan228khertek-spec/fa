import type { NewSchedule, TickerRepository, TickerSchedule, TickerStyle } from './ticker.js';
import { AdminError } from './types.js';

/** Хранилище бегущей строки в памяти: dev без БД и тесты (контракт как у PgTickerRepository). */
export class MemoryTickerRepository implements TickerRepository {
  private def: TickerStyle | null = null;
  private rows = new Map<number, TickerSchedule>();
  private seq = 0;

  async ready(): Promise<void> {}

  async getDefault(): Promise<TickerStyle | null> {
    return this.def ? structuredClone(this.def) : null;
  }

  async setDefault(style: TickerStyle): Promise<void> {
    this.def = structuredClone(style);
  }

  async resetDefault(): Promise<void> {
    this.def = null;
  }

  async listSchedules(): Promise<TickerSchedule[]> {
    return [...this.rows.values()]
      .sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.id - b.id)
      .map((s) => structuredClone(s));
  }

  async createSchedule(input: NewSchedule): Promise<TickerSchedule> {
    const s: TickerSchedule = { ...structuredClone(input), id: ++this.seq };
    this.rows.set(s.id, s);
    return structuredClone(s);
  }

  async updateSchedule(id: number, input: NewSchedule): Promise<TickerSchedule> {
    if (!this.rows.has(id)) throw new AdminError('Период не найден', 404);
    const s: TickerSchedule = { ...structuredClone(input), id };
    this.rows.set(id, s);
    return structuredClone(s);
  }

  async deleteSchedule(id: number): Promise<void> {
    if (!this.rows.delete(id)) throw new AdminError('Период не найден', 404);
  }

  async close(): Promise<void> {}
}
