import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'fa_cml_session';

/** Сессии обмена живут в памяти процесса: 1С ходит короткими сериями запросов. */
const sessions = new Map<string, number>();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Сравнение с самим собой — чтобы время не зависело от длины.
    timingSafeEqual(bb, bb);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function checkBasicAuth(req: FastifyRequest, login: string, password: string): boolean {
  if (!login || !password) return false; // пустые креды = обмен закрыт
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  const okLogin = safeEqual(decoded.slice(0, sep), login);
  const okPassword = safeEqual(decoded.slice(sep + 1), password);
  return okLogin && okPassword;
}

export function createSession(): string {
  const token = randomBytes(24).toString('hex');
  sessions.set(token, Date.now());
  return token;
}

function hasLiveSession(token: string | undefined): boolean {
  if (!token) return false;
  const created = sessions.get(token);
  if (created === undefined) return false;
  if (Date.now() - created > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function cookieToken(req: FastifyRequest): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return undefined;
}

/**
 * 1С после checkauth шлёт cookie, но некоторые версии дублируют Basic
 * в каждом запросе — принимаем любой из двух способов.
 */
export function isAuthorized(req: FastifyRequest, login: string, password: string): boolean {
  return hasLiveSession(cookieToken(req)) || checkBasicAuth(req, login, password);
}

/** Для тестов. */
export function resetSessions(): void {
  sessions.clear();
}
