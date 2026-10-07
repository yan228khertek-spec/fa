import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import AdmZip from 'adm-zip';

/**
 * Санитизация имени файла из query (?filename=...).
 * 1С может прислать подкаталоги (import_files/aa/bb.jpg) — это легально,
 * а вот выход за пределы spool (..\..\, абсолютные пути) — нет.
 * Возвращает безопасный относительный путь или null.
 */
export function safeRelativeName(filename: string): string | null {
  if (!filename) return null;
  const normalized = filename.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  if (parts.some((p) => p === '..' || p === '.')) return null;
  return parts.join('/');
}

function resolveInside(baseDir: string, relative: string): string | null {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relative);
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

/**
 * Дозапись куска файла (1С шлёт большие файлы несколькими POST).
 * Тело пишется на диск потоком; byteLimit страхует от сверхлимитных тел.
 */
export async function appendChunk(
  inboxDir: string,
  relative: string,
  body: Readable,
  byteLimit: number,
): Promise<{ bytes: number }> {
  const target = resolveInside(inboxDir, relative);
  if (!target) throw new Error('path traversal rejected');
  await mkdir(path.dirname(target), { recursive: true });

  let bytes = 0;
  body.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > byteLimit) body.destroy(new Error('chunk exceeds file_limit'));
  });
  await pipeline(body, createWriteStream(target, { flags: 'a' }));
  return { bytes };
}

/**
 * Распаковка принятого zip в unpackedDir с защитой каждого имени записи.
 * TODO(этапы 2–3): adm-zip держит записи в памяти — для архивов в сотни МБ
 * заменить на потоковый распаковщик (yauzl) до полной выгрузки каталога.
 */
export async function unzipSafely(
  inboxDir: string,
  relative: string,
  unpackedDir: string,
): Promise<string[]> {
  const source = resolveInside(inboxDir, relative);
  if (!source) throw new Error('path traversal rejected');
  await stat(source); // бросит, если файла нет

  const zip = new AdmZip(source);
  const extracted: string[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const safe = safeRelativeName(entry.entryName);
    if (!safe) continue; // молча пропускаем вредоносные имена, факт — в журнал выше
    const target = resolveInside(unpackedDir, safe);
    if (!target) continue;
    await mkdir(path.dirname(target), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(target, entry.getData());
    extracted.push(safe);
  }
  return extracted;
}

export function isZip(relative: string): boolean {
  return relative.toLowerCase().endsWith('.zip');
}
