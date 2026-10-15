import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';

/**
 * Медиа-хранилище фото из 1С (A2/M1).
 *
 * Зачем: spool/unpacked чистится при каждом `mode=init` (resetSpool), поэтому
 * картинки выгрузки живут ровно до следующего обмена. Витрине и админке
 * («фото из 1С») нужны постоянные файлы, поэтому после успешного разбора
 * import.xml дерево `import_files` переносится в отдельный том media, откуда
 * его отдаёт Caddy по /images/*.
 *
 * Правила: копируем новые и изменившиеся файлы (сравнение по размеру и
 * mtime), НИЧЕГО не удаляем — инкрементальная выгрузка не должна рвать уже
 * опубликованные URL. Повторный вызов без новых файлов не делает ничего.
 */

export interface MediaSyncResult {
  copied: number;
  skipped: number;
  bytes: number;
}

/** Подкаталог выгрузки 1С с файлами картинок. */
export const IMPORT_FILES_DIR = 'import_files';

/** Разрешает relative внутри base; null — попытка выйти наружу. */
function resolveInside(baseDir: string, relative: string): string | null {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relative);
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

/** Файл уже на месте и не менялся? Сравниваем размер и mtime (с точностью до секунды: */
/** у разных ФС разная гранулярность, а mtime мы переносим сами при копировании). */
function same(src: { size: number; mtimeMs: number }, dst: { size: number; mtimeMs: number }) {
  return src.size === dst.size && Math.abs(src.mtimeMs - dst.mtimeMs) < 1000;
}

/**
 * Копирует дерево srcDir → destDir (новые и изменившиеся файлы).
 * Отсутствие srcDir — не ошибка: выгрузка могла прийти без картинок.
 */
export async function syncMediaTree(srcDir: string, destDir: string): Promise<MediaSyncResult> {
  const result: MediaSyncResult = { copied: 0, skipped: 0, bytes: 0 };
  let entries;
  try {
    entries = await readdir(srcDir, { withFileTypes: true, recursive: true });
  } catch {
    return result; // каталога нет — копировать нечего
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const relative = path.relative(srcDir, path.join(entry.parentPath, entry.name));
    const source = resolveInside(srcDir, relative);
    const target = resolveInside(destDir, relative);
    // Имена пришли из zip 1С, они уже санитизированы распаковщиком; проверка
    // повторная и дешёвая — за пределы своих каталогов не выходим.
    if (!source || !target) continue;

    const src = await stat(source).catch(() => null);
    if (!src?.isFile()) continue;
    const dst = await stat(target).catch(() => null);
    if (dst?.isFile() && same(src, dst)) {
      result.skipped++;
      continue;
    }

    await mkdir(path.dirname(target), { recursive: true });
    // Копируем во временный файл рядом и переименовываем: Caddy может отдавать
    // этот каталог прямо сейчас, и половина файла наружу попасть не должна.
    // Имя временного файла случайное: 1С шлёт выгрузку несколькими файлами
    // (import.xml, import0_1.xml), их разбор идёт параллельно, и два переноса
    // одного и того же файла не должны писать в один и тот же .part.
    const tmp = `${target}.part-${randomBytes(6).toString('hex')}`;
    try {
      await copyFile(source, tmp);
      await utimes(tmp, src.atime, src.mtime); // mtime переносим — по нему сверяемся дальше
      await rename(tmp, target);
    } catch (err) {
      // Иначе оборванный перенос оставит .part-мусор в томе навсегда:
      // следующая синхронизация его не увидит (его нет в источнике).
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    result.copied++;
    result.bytes += src.size;
  }

  return result;
}

/**
 * Перенос картинок выгрузки в постоянное хранилище после успешного import.
 * mediaDir пустой — хранилище выключено (dev/тесты без тома).
 */
export async function syncImportMedia(
  unpackedDir: string,
  mediaDir: string,
): Promise<MediaSyncResult | null> {
  if (!mediaDir) return null;
  return syncMediaTree(
    path.join(unpackedDir, IMPORT_FILES_DIR),
    path.join(mediaDir, IMPORT_FILES_DIR),
  );
}
