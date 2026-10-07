import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import yauzl from 'yauzl';

/**
 * Санитизация имени файла из query (?filename=...).
 * 1С может прислать подкаталоги (import_files/aa/bb.jpg) — это легально,
 * а вот выход за пределы spool (..\..\, абсолютные пути) — нет.
 * Возвращает безопасный относительный путь или null.
 */
export function safeRelativeName(filename: string): string | null {
  if (!filename) return null;
  // Управляющие символы (в т.ч. NUL) в именах файлов не бывают легальны,
  // зато ими обрезают расширение при обходе проверок.
  for (let i = 0; i < filename.length; i++) {
    if (filename.charCodeAt(i) < 0x20) return null;
  }
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

/** По умолчанию: сколько распакованных байт на один архив считаем нормой. */
export const DEFAULT_UNPACK_LIMIT = 2 * 1024 * 1024 * 1024;

/** Поток, падающий при превышении лимита байт (страховка от zip-бомбы). */
function limitBytes(limit: number, onBytes: (n: number) => void): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      onBytes(chunk.length);
      if (seen > limit) {
        done(new Error('распакованный размер превышает лимит'));
        return;
      }
      done(null, chunk);
    },
  });
}

/**
 * Потоковая распаковка принятого zip в unpackedDir.
 *
 * Каждая запись переливается на диск потоком (yauzl, lazyEntries) — архив в
 * сотни МБ не попадает в память, и суммарный распакованный размер ограничен
 * byteLimit: в mode=file лимит есть только у одного POST, поэтому без этой
 * проверки архив в 400 КБ со степенью сжатия 1000:1 укладывал процесс
 * (ревью этапа 2, находка 2). Имя каждой записи санитизируется.
 */
export async function unzipSafely(
  inboxDir: string,
  relative: string,
  unpackedDir: string,
  byteLimit: number = DEFAULT_UNPACK_LIMIT,
): Promise<string[]> {
  const source = resolveInside(inboxDir, relative);
  if (!source) throw new Error('path traversal rejected');
  await stat(source); // бросит, если файла нет

  const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(source, { lazyEntries: true, autoClose: true }, (err, file) => {
      if (err || !file) reject(err ?? new Error('не удалось открыть архив'));
      else resolve(file);
    });
  });

  const extracted: string[] = [];
  let total = 0;

  await new Promise<void>((resolve, reject) => {
    const fail = (err: Error): void => {
      zipfile.close();
      reject(err);
    };

    zipfile.on('error', fail);
    zipfile.on('end', resolve);
    zipfile.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        try {
          const safe = entry.fileName.endsWith('/') ? null : safeRelativeName(entry.fileName);
          const target = safe ? resolveInside(unpackedDir, safe) : null;
          // Вредоносные имена записей пропускаем молча, факт — в журнал выше.
          if (!safe || !target) {
            zipfile.readEntry();
            return;
          }
          // Заголовок позволяет отбить бомбу до чтения данных; фактические
          // байты всё равно считаем — заголовок может врать.
          if (total + entry.uncompressedSize > byteLimit) {
            throw new Error('распакованный размер превышает лимит');
          }
          const readStream = await new Promise<Readable>((ok, no) => {
            zipfile.openReadStream(entry, (err, stream) => {
              if (err || !stream) no(err ?? new Error('не удалось прочитать запись архива'));
              else ok(stream);
            });
          });
          await mkdir(path.dirname(target), { recursive: true });
          await pipeline(
            readStream,
            limitBytes(byteLimit - total, (n) => {
              total += n;
            }),
            createWriteStream(target),
          );
          extracted.push(safe);
          zipfile.readEntry();
        } catch (err) {
          fail(err as Error);
        }
      })();
    });

    zipfile.readEntry();
  });

  return extracted;
}

/**
 * Очистка spool перед новой сессией обмена (mode=init).
 * Куски файлов дозаписываются в конец, поэтому без очистки вторая выгрузка
 * склеилась бы с первой: import.xml удвоился бы и стал невалидным.
 * 1С вызывает init ровно один раз в начале выгрузки каталога.
 */
export async function resetSpool(...dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  }
}

export function isZip(relative: string): boolean {
  return relative.toLowerCase().endsWith('.zip');
}

/**
 * Распаковывает все zip, лежащие в inbox. 1С не сообщает, какой кусок был
 * последним: она присылает архив через mode=file, а потом вызывает
 * mode=import&filename=import.xml — именем файла ВНУТРИ архива. Поэтому, если
 * запрошенного xml ещё нет, распаковываем накопившиеся архивы и ищем снова.
 * Повторный вызов безопасен: записи перезаписываются одинаковым содержимым.
 */
export async function unzipPendingArchives(
  inboxDir: string,
  unpackedDir: string,
  byteLimit: number = DEFAULT_UNPACK_LIMIT,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(inboxDir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  const extracted: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const relative = safeRelativeName(
      path.relative(inboxDir, path.join(entry.parentPath, entry.name)),
    );
    if (!relative || !isZip(relative)) continue;
    extracted.push(...(await unzipSafely(inboxDir, relative, unpackedDir, byteLimit)));
  }
  return extracted;
}
