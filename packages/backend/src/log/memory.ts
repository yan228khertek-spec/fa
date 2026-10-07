import type { ExchangeLogEntry, ExchangeLogSink } from './types.js';

/** Журнал в памяти — dev и тесты. */
export class MemoryExchangeLog implements ExchangeLogSink {
  readonly entries: ExchangeLogEntry[] = [];

  async write(entry: ExchangeLogEntry): Promise<void> {
    this.entries.push(entry);
  }

  async close(): Promise<void> {
    // ничего
  }
}
