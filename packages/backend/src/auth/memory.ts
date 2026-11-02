import { timingSafeEqual } from 'node:crypto';
import type {
  Account,
  AuthRepository,
  Challenge,
  IssueChallenge,
  VerifyChallenge,
} from './types.js';

/** Test/dev storage. No raw codes or session tokens are stored. */
export class MemoryAuthRepository implements AuthRepository {
  readonly challenges = new Map<string, Challenge>();
  readonly sessions = new Map<string, { userId: string; expiresAt: Date }>();
  private accounts = new Map<string, Account>();
  private limits = new Map<string, { count: number; expiresAt: number }>();
  private seq = 0;
  async ready(): Promise<void> {}
  async close(): Promise<void> {}

  async issue({ challenge, phoneKey, ipKey, now }: IssueChallenge): Promise<boolean> {
    const time = now.getTime();
    for (const [key, row] of this.limits) if (row.expiresAt <= time) this.limits.delete(key);
    for (const [key, row] of this.challenges)
      if (row.expiresAt.getTime() <= time) this.challenges.delete(key);
    for (const [key, row] of this.sessions)
      if (row.expiresAt.getTime() <= time) this.sessions.delete(key);
    const rules = [
      { key: `cooldown:${phoneKey}`, max: 1, window: 60_000 },
      { key: `phone:${phoneKey}`, max: 5, window: 3600_000 },
      { key: `ip:${ipKey}`, max: 20, window: 3600_000 },
    ];
    if (rules.some((r) => (this.limits.get(r.key)?.count ?? 0) >= r.max)) return false;
    for (const r of rules) {
      const previous = this.limits.get(r.key);
      this.limits.set(r.key, {
        count: (previous?.count ?? 0) + 1,
        expiresAt: previous?.expiresAt ?? time + r.window,
      });
    }
    for (const row of this.challenges.values())
      if (row.phone === challenge.phone) row.state = 'used';
    this.challenges.set(challenge.id, structuredClone(challenge));
    return true;
  }

  async activate(id: string): Promise<void> {
    const row = this.challenges.get(id);
    if (row?.state === 'pending') row.state = 'active';
  }

  async discard(id: string): Promise<void> {
    const row = this.challenges.get(id);
    if (row) row.state = 'used';
  }

  async verify(input: VerifyChallenge): Promise<Account | null> {
    const row = this.challenges.get(input.id);
    if (!row || row.state !== 'active' || row.expiresAt <= input.now || row.attempts >= 5)
      return null;
    row.attempts++;
    if (!timingSafeEqual(Buffer.from(row.digest, 'hex'), Buffer.from(input.digest, 'hex')))
      return null;
    row.state = 'used';
    let account = [...this.accounts.values()].find((a) => a.phone === row.phone);
    if (!account) {
      account = {
        id: String(++this.seq),
        phone: row.phone,
        name: null,
        email: null,
        createdAt: input.now.toISOString(),
      };
      this.accounts.set(account.id, account);
    }
    this.sessions.set(input.sessionHash, { userId: account.id, expiresAt: input.sessionExpiresAt });
    return structuredClone(account);
  }

  async session(hash: string, now: Date): Promise<Account | null> {
    const session = this.sessions.get(hash);
    const account = session && session.expiresAt > now ? this.accounts.get(session.userId) : null;
    return account ? structuredClone(account) : null;
  }

  async revoke(hash: string): Promise<void> {
    this.sessions.delete(hash);
  }

  async updateProfile(
    id: string,
    patch: { name?: string | null; email?: string | null },
  ): Promise<Account> {
    const account = this.accounts.get(id);
    if (!account) throw new Error('Account missing');
    Object.assign(account, patch);
    return structuredClone(account);
  }
}
