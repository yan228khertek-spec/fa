import { AccountError } from '../auth/types.js';

export function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AccountError(422, 'VALIDATION_ERROR');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new AccountError(422, 'VALIDATION_ERROR');
  return body;
}

export function string(value: unknown): string {
  if (typeof value !== 'string') throw new AccountError(422, 'VALIDATION_ERROR');
  return value;
}

export function profilePatch(value: unknown): { name?: string | null; email?: string | null } {
  const body = object(value, ['name', 'email']);
  if (Object.keys(body).length === 0) throw new AccountError(422, 'VALIDATION_ERROR');
  const patch: { name?: string | null; email?: string | null } = {};
  for (const key of ['name', 'email'] as const) {
    if (!(key in body)) continue;
    if (body[key] === null) {
      patch[key] = null;
      continue;
    }
    const raw = string(body[key]);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(raw))
      throw new AccountError(422, 'VALIDATION_ERROR');
    const text = raw.trim();
    if (key === 'name') {
      if (text.length < 2 || text.length > 100) throw new AccountError(422, 'VALIDATION_ERROR');
      patch.name = text;
    } else {
      if (text.length > 254 || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(text))
        throw new AccountError(422, 'VALIDATION_ERROR');
      patch.email = text.toLowerCase();
    }
  }
  return patch;
}

export function pagination(query: unknown): { limit: number; offset: number } {
  const body = object(query, ['limit', 'offset']);
  const integer = (value: unknown, fallback: number, min: number, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d{1,7}$/.test(value))
      throw new AccountError(422, 'VALIDATION_ERROR');
    const n = Number(value);
    if (n < min || n > max) throw new AccountError(422, 'VALIDATION_ERROR');
    return n;
  };
  return { limit: integer(body.limit, 20, 1, 100), offset: integer(body.offset, 0, 0, 1_000_000) };
}
