import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgAuthRepository } from '../src/auth/pg.js';
import { AUTH_DDL } from '../src/auth/schema.js';
import { AuthService } from '../src/auth/service.js';

it('миграция аккаунтов совпадает с автоматически применяемой схемой', async () => {
  const sql = await readFile(new URL('../migrations/019_accounts.sql', import.meta.url), 'utf8');
  expect(AUTH_DDL).toBe(sql.trimEnd());
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('аккаунты PostgreSQL, изолированная схема', () => {
  const schema = `auth_test_${randomUUID().replaceAll('-', '')}`;
  let pool: pg.Pool;
  let repo: PgAuthRepository;
  let auth: AuthService;
  let now = new Date('2026-11-02T12:00:00Z');
  const codes: string[] = [];
  const secret = 'test-secret-that-is-at-least-32-characters';
  let connection: string;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    connection = url.toString();
    repo = new PgAuthRepository(connection);
    await repo.ready();
    await repo.ready();
    auth = new AuthService(
      repo,
      {
        kind: 'test',
        async send(_phone, code) {
          codes.push(code);
        },
      },
      secret,
      () => now,
    );
  });
  afterAll(async () => {
    await repo?.close();
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool?.end();
  });
  it('один код создаёт ровно одну сессию при гонке', async () => {
    const c = await auth.requestCode('+79131234567', '127.0.0.1');
    const results = await Promise.allSettled([
      auth.verifyCode(c.challengeId, codes[0]),
      auth.verifyCode(c.challengeId, codes[0]),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const success = results.find((r) => r.status === 'fulfilled')!;
    if (success.status !== 'fulfilled') throw new Error('Missing session');
    const restartedRepo = new PgAuthRepository(connection);
    try {
      const restarted = new AuthService(
        restartedRepo,
        { kind: 'test', async send() {} },
        secret,
        () => now,
      );
      expect(await restarted.authenticate(success.value.token)).toEqual(success.value.account);
      await restartedRepo.updateProfile(success.value.account.id, {
        name: 'Анна',
        email: 'anna@example.test',
      });
      expect(await auth.authenticate(success.value.token)).toMatchObject({
        name: 'Анна',
        email: 'anna@example.test',
      });
      await restarted.logout(success.value.token);
      expect(await auth.authenticate(success.value.token)).toBeNull();
    } finally {
      await restartedRepo.close();
    }
  });
  it('повторные неверные коды учитываются атомарно', async () => {
    now = new Date(now.getTime() + 60_000);
    const c = await auth.requestCode('+79131234567', '127.0.0.1');
    const code = codes.at(-1)!;
    const wrong = code === '000000' ? '111111' : '000000';
    await Promise.allSettled(
      Array.from({ length: 5 }, () => auth.verifyCode(c.challengeId, wrong)),
    );
    await expect(auth.verifyCode(c.challengeId, code)).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
  });
  it('конкурирующие отправки соблюдают общий лимит телефона', async () => {
    now = new Date(now.getTime() + 3600_000);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => auth.requestCode('+79131234567', '127.0.0.1')),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('параллельные запросы разных телефонов соблюдают общий часовой лимит IP', async () => {
    now = new Date(now.getTime() + 3600_000);
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        auth.requestCode(`+7913000${String(i).padStart(4, '0')}`, '127.0.0.2'),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(20);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(5);
    for (const result of rejected)
      if (result.status === 'rejected') expect(result.reason.code).toBe('RATE_LIMITED');
  });

  it('часовой лимит телефона сохраняется между отправками и после ошибки провайдера', async () => {
    const failing = new AuthService(
      repo,
      {
        kind: 'test',
        async send() {
          throw new Error('provider failure');
        },
      },
      secret,
      () => now,
    );
    await expect(failing.requestCode('+79138888888', '127.0.0.3')).rejects.toMatchObject({
      code: 'SMS_UNAVAILABLE',
    });
    await expect(auth.requestCode('+79138888888', '127.0.0.3')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    for (let i = 0; i < 4; i++) {
      now = new Date(now.getTime() + 60_000);
      await auth.requestCode('+79138888888', '127.0.0.3');
    }
    now = new Date(now.getTime() + 60_000);
    await expect(auth.requestCode('+79138888888', '127.0.0.3')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});
