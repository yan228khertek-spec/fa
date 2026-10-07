import pg from 'pg';
import type { ExchangeLogEntry, ExchangeLogSink } from './types.js';

const DDL = `
CREATE TABLE IF NOT EXISTS exchange_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL,
  type        text NOT NULL,
  mode        text NOT NULL,
  filename    text,
  body_bytes  bigint NOT NULL DEFAULT 0,
  result      text NOT NULL,
  detail      text
);
CREATE INDEX IF NOT EXISTS exchange_log_at_idx ON exchange_log (at);
`;

/** Журнал обмена в PostgreSQL (прод). DDL идемпотентный. */
export class PgExchangeLog implements ExchangeLogSink {
  private pool: pg.Pool;
  private ready: Promise<void>;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    this.ready = this.pool.query(DDL).then(() => undefined);
  }

  async write(entry: ExchangeLogEntry): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO exchange_log (at, type, mode, filename, body_bytes, result, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.at,
        entry.type,
        entry.mode,
        entry.filename,
        entry.bodyBytes,
        entry.result,
        entry.detail,
      ],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
