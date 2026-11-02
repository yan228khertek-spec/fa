import { timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { AUTH_DDL } from './schema.js';
import type { Account, AuthRepository, IssueChallenge, VerifyChallenge } from './types.js';

interface AccountRow {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  created_at: Date;
}
const columns = 'id::text, phone, name, email, created_at';
const account = (row: AccountRow): Account => ({
  id: row.id,
  phone: row.phone,
  name: row.name,
  email: row.email,
  createdAt: row.created_at.toISOString(),
});

export class PgAuthRepository implements AuthRepository {
  private readonly pool: pg.Pool;
  private prepared?: Promise<void>;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 4 });
  }

  ready(): Promise<void> {
    this.prepared ??= this.pool
      .query(AUTH_DDL)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.prepared = undefined;
        throw error;
      });
    return this.prepared;
  }

  async issue({ challenge: c, phoneKey, ipKey, now }: IssueChallenge): Promise<boolean> {
    await this.ready();
    // Bounded cleanup; skip rows locked by a concurrent verifier/rate-limit transaction.
    for (const [table, key] of [
      ['auth_challenges', 'id'],
      ['auth_sessions', 'token_hash'],
      ['auth_limits', 'key'],
    ]) {
      await this.pool.query(
        `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE expires_at <= $1 LIMIT 1000 FOR UPDATE SKIP LOCKED)`,
        [now],
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rules = [
        { key: `cooldown:${phoneKey}`, max: 1, window: 60_000 },
        { key: `phone:${phoneKey}`, max: 5, window: 3600_000 },
        { key: `ip:${ipKey}`, max: 20, window: 3600_000 },
      ].sort((a, b) => a.key.localeCompare(b.key));
      for (const rule of rules) {
        const result = await client.query<{ count: number }>(
          `INSERT INTO auth_limits (key, count, expires_at) VALUES ($1, 1, $3)
           ON CONFLICT (key) DO UPDATE SET
             count = CASE WHEN auth_limits.expires_at <= $2 THEN 1 ELSE auth_limits.count + 1 END,
             expires_at = CASE WHEN auth_limits.expires_at <= $2 THEN $3 ELSE auth_limits.expires_at END
           RETURNING count`,
          [rule.key, now, new Date(now.getTime() + rule.window)],
        );
        if (result.rows[0]!.count > rule.max) {
          await client.query('ROLLBACK');
          return false;
        }
      }
      await client.query(
        "UPDATE auth_challenges SET state = 'used' WHERE phone = $1 AND state <> 'used'",
        [c.phone],
      );
      await client.query(
        'INSERT INTO auth_challenges (id, phone, digest, attempts, state, expires_at) VALUES ($1, $2, $3, 0, $4, $5)',
        [c.id, c.phone, c.digest, c.state, c.expiresAt],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async activate(id: string): Promise<void> {
    await this.ready();
    await this.pool.query(
      "UPDATE auth_challenges SET state = 'active' WHERE id = $1 AND state = 'pending'",
      [id],
    );
  }

  async discard(id: string): Promise<void> {
    await this.ready();
    await this.pool.query("UPDATE auth_challenges SET state = 'used' WHERE id = $1", [id]);
  }

  async verify(input: VerifyChallenge): Promise<Account | null> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ phone: string; digest: string }>(
        "SELECT phone, digest FROM auth_challenges WHERE id = $1 AND state = 'active' AND attempts < 5 AND expires_at > $2 FOR UPDATE",
        [input.id, input.now],
      );
      const row = rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return null;
      }
      const valid = timingSafeEqual(
        Buffer.from(row.digest, 'hex'),
        Buffer.from(input.digest, 'hex'),
      );
      await client.query(
        "UPDATE auth_challenges SET attempts = attempts + 1, state = CASE WHEN $2 THEN 'used' ELSE state END WHERE id = $1",
        [input.id, valid],
      );
      if (!valid) {
        await client.query('COMMIT');
        return null;
      }
      const result = await client.query<AccountRow>(
        `INSERT INTO customer_accounts (phone, created_at) VALUES ($1, $2)
         ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING ${columns}`,
        [row.phone, input.now],
      );
      const user = account(result.rows[0]!);
      await client.query(
        'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
        [input.sessionHash, user.id, input.sessionExpiresAt],
      );
      await client.query('COMMIT');
      return user;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async session(hash: string, now: Date): Promise<Account | null> {
    await this.ready();
    const { rows } = await this.pool.query<AccountRow>(
      `SELECT a.id::text, a.phone, a.name, a.email, a.created_at FROM customer_accounts a
       JOIN auth_sessions s ON s.user_id = a.id WHERE s.token_hash = $1 AND s.expires_at > $2`,
      [hash, now],
    );
    return rows[0] ? account(rows[0]) : null;
  }

  async revoke(hash: string): Promise<void> {
    await this.ready();
    await this.pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [hash]);
  }

  async updateProfile(
    id: string,
    patch: { name?: string | null; email?: string | null },
  ): Promise<Account> {
    await this.ready();
    const { rows } = await this.pool.query<AccountRow>(
      `UPDATE customer_accounts SET name = CASE WHEN $2 THEN $3 ELSE name END,
       email = CASE WHEN $4 THEN $5 ELSE email END, updated_at = now() WHERE id = $1 RETURNING ${columns}`,
      [id, 'name' in patch, patch.name ?? null, 'email' in patch, patch.email ?? null],
    );
    if (!rows[0]) throw new Error('Account missing');
    return account(rows[0]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
