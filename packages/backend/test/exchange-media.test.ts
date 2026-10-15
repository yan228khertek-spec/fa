import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncImportMedia, syncMediaTree } from '../src/exchange/media.js';

/**
 * Медиа-хранилище фото из 1С (A2/M1): перенос spool/unpacked/import_files
 * в постоянный том. Главное свойство — ничего не удалять: спул чистится
 * каждым обменом, а URL /images/* должны переживать выгрузки.
 */
describe('медиа-хранилище', () => {
  let dir: string;
  let src: string;
  let dest: string;

  const write = async (rel: string, data: string): Promise<string> => {
    const full = path.join(src, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
    return full;
  };

  const exists = async (rel: string): Promise<boolean> =>
    !!(await stat(path.join(dest, rel)).catch(() => null));

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fa-media-'));
    src = path.join(dir, 'unpacked');
    dest = path.join(dir, 'media');
    await mkdir(src, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('копирует дерево с подкаталогами', async () => {
    await write('a.jpg', 'A');
    await write('ab/cd/b.jpg', 'B');

    const res = await syncMediaTree(src, dest);

    expect(res).toMatchObject({ copied: 2, skipped: 0 });
    expect(await readFile(path.join(dest, 'a.jpg'), 'utf8')).toBe('A');
    expect(await readFile(path.join(dest, 'ab/cd/b.jpg'), 'utf8')).toBe('B');
    // временных .part-файлов после переноса не остаётся
    expect(await exists('a.jpg.part')).toBe(false);
  });

  it('повторный вызов ничего не копирует (идемпотентность)', async () => {
    await write('a.jpg', 'A');
    await syncMediaTree(src, dest);

    const again = await syncMediaTree(src, dest);

    expect(again).toMatchObject({ copied: 0, skipped: 1 });
  });

  it('изменившийся файл перезаписывается', async () => {
    await write('a.jpg', 'A');
    await syncMediaTree(src, dest);
    const full = await write('a.jpg', 'AAA-другое-содержимое');
    const later = new Date(Date.now() + 10_000);
    await utimes(full, later, later);

    const res = await syncMediaTree(src, dest);

    expect(res).toMatchObject({ copied: 1 });
    expect(await readFile(path.join(dest, 'a.jpg'), 'utf8')).toBe('AAA-другое-содержимое');
  });

  it('исчезнувшие из выгрузки файлы остаются в хранилище', async () => {
    await write('old.jpg', 'OLD');
    await syncMediaTree(src, dest);
    // следующая выгрузка пришла без старого файла и с новым
    await rm(path.join(src, 'old.jpg'));
    await write('new.jpg', 'NEW');

    await syncMediaTree(src, dest);

    expect(await exists('old.jpg')).toBe(true);
    expect(await exists('new.jpg')).toBe(true);
  });

  it('нет каталога с картинками — не ошибка', async () => {
    const res = await syncMediaTree(path.join(dir, 'нет-такого'), dest);
    expect(res).toMatchObject({ copied: 0, skipped: 0 });
    expect(await stat(dest).catch(() => null)).toBeNull();
  });

  it('syncImportMedia переносит только import_files и уважает пустой mediaDir', async () => {
    await mkdir(path.join(src, 'import_files/aa'), { recursive: true });
    await writeFile(path.join(src, 'import_files/aa/p.jpg'), 'P');
    await writeFile(path.join(src, 'import.xml'), '<xml/>');

    expect(await syncImportMedia(src, '')).toBeNull();
    const res = await syncImportMedia(src, dest);

    expect(res).toMatchObject({ copied: 1 });
    expect(await exists('import_files/aa/p.jpg')).toBe(true);
    // xml — не медиа, в хранилище не попадает
    expect(await exists('import.xml')).toBe(false);
  });
});
