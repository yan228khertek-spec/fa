import { timingSafeEqual } from 'node:crypto';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(bb, bb); // время не должно зависеть от длины
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Basic-авторизация админки. Пустые логин/пароль = админка закрыта. */
export function checkAdminAuth(
  header: string | undefined,
  login: string,
  password: string,
): boolean {
  if (!login || !password) return false;
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  const okLogin = safeEqual(decoded.slice(0, sep), login);
  const okPassword = safeEqual(decoded.slice(sep + 1), password);
  return okLogin && okPassword;
}

/** Ограничитель подбора пароля: не больше `max` неудач с одного адреса за `windowMs`. */
export class FailureLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max = 10,
    private windowMs = 10 * 60 * 1000,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  fail(key: string, now = Date.now()): void {
    const list = this.recent(key, now);
    list.push(now);
    this.hits.set(key, list);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
