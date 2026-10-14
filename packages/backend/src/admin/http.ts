import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sniffImage } from './media.js';
import { AdminError } from './types.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Имена файлов, которые создаём сами; только такие отдаём и удаляем. */
export const OWN_FILE_RE = /^[a-f0-9]{16}\.(?:jpg|png|webp|avif)$/;

export function parseId(raw: string, what = 'бренда'): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new AdminError(`Некорректный id ${what}`);
  return n;
}

export function page(q: { limit?: string; offset?: string }, max: number, dflt: number) {
  return {
    limit: Math.min(Math.max(Math.trunc(Number(q.limit ?? dflt)) || dflt, 1), max),
    offset: Math.max(Math.trunc(Number(q.offset ?? 0)) || 0, 0),
  };
}

/** Проверяет тело как картинку (по сигнатуре) и пишет под случайным именем. */
export async function saveImage(uploadsDir: string, body: unknown): Promise<string> {
  if (!Buffer.isBuffer(body) || body.length === 0) throw new AdminError('Файл не передан');
  const ext = sniffImage(body);
  if (!ext) throw new AdminError('Нужна картинка JPEG, PNG, WebP или AVIF');
  const filename = `${randomBytes(8).toString('hex')}.${ext}`;
  await writeFile(path.join(uploadsDir, filename), body, { flag: 'wx' });
  return filename;
}

/** Удаляет только файл, созданный нами (имя проверяется по маске). */
export async function removeOwnFile(uploadsDir: string, name: string | null): Promise<void> {
  if (name && OWN_FILE_RE.test(name))
    await unlink(path.join(uploadsDir, name)).catch(() => undefined);
}
