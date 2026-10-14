import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { MAX_CARD_PHOTOS, type CardService } from './cards.js';
import { MAX_IMAGE_BYTES, page, parseId, removeOwnFile, saveImage } from './http.js';
import { AdminError, type CardPhoto } from './types.js';

interface Deps {
  cards: CardService;
  uploadsDir: string;
  /** Каталог распакованной выгрузки 1С (spool/unpacked); пути фото из staging лежат в нём. */
  unpackedDir: string;
  uploadUrl: (file: string | null) => string | null;
  modelPhoto: (path: string | null) => string | null;
}

/** Маршруты админки карточек (регистрируются внутри защищённой области /admin). */
export function registerCardRoutes(adm: FastifyInstance, deps: Deps): void {
  const { cards, uploadsDir, unpackedDir, uploadUrl } = deps;
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  const dto = <T extends { photos: CardPhoto[] }>(card: T) => ({
    ...card,
    photos: card.photos.map((p) => ({ id: p.id, sort: p.sort, url: uploadUrl(p.file) })),
  });

  adm.get('/admin/api/cards', async (req) => {
    const q = req.query as { status?: string; q?: string; limit?: string; offset?: string };
    const { limit, offset } = page(q, 200, 50);
    const res = await cards.list({
      status: q.status,
      query: (q.q ?? '').slice(0, 100),
      limit,
      offset,
    });
    return { total: res.total, items: res.items.map(dto) };
  });

  adm.get('/admin/api/cards/search', async (req) => {
    const q = (req.query as { q?: string }).q ?? '';
    return cards.search(q.slice(0, 100));
  });

  adm.post('/admin/api/cards', async (req, reply) => {
    const card = await cards.create((req.body ?? {}) as Record<string, unknown>);
    return reply.code(201).send(dto(card));
  });

  adm.get('/admin/api/cards/:id', async (req) =>
    dto(await cards.get(parseId((req.params as { id: string }).id, 'карточки'))),
  );

  adm.put('/admin/api/cards/:id', async (req) =>
    dto(
      await cards.update(
        parseId((req.params as { id: string }).id, 'карточки'),
        (req.body ?? {}) as Record<string, unknown>,
      ),
    ),
  );

  adm.delete('/admin/api/cards/:id', async (req) => {
    const files = await cards.repo.deleteCard(
      parseId((req.params as { id: string }).id, 'карточки'),
    );
    for (const f of files) await removeOwnFile(uploadsDir, f);
    return { ok: true };
  });

  adm.post('/admin/api/cards/:id/photos', async (req) => {
    const cardId = parseId((req.params as { id: string }).id, 'карточки');
    if ((await cards.photoCount(cardId)) >= MAX_CARD_PHOTOS) {
      throw new AdminError(`Не больше ${MAX_CARD_PHOTOS} фото на карточку`, 409);
    }
    const file = await saveImage(uploadsDir, req.body);
    try {
      await cards.repo.addPhoto(cardId, file);
    } catch (err) {
      await removeOwnFile(uploadsDir, file); // карточку удалили между проверкой и записью
      throw err;
    }
    return dto(await cards.get(cardId));
  });

  // Копирует фото модели из выгрузки 1С в наши загрузки: дальше они ведутся как обычные.
  adm.post('/admin/api/cards/:id/photos/from-1c', async (req) => {
    const cardId = parseId((req.params as { id: string }).id, 'карточки');
    const sources = await cards.sourceImages(cardId);
    const current = await cards.get(cardId);
    const have = new Set<string>();
    for (const p of current.photos) {
      const buf = await readFile(path.join(uploadsDir, p.file)).catch(() => null);
      if (buf) have.add(sha(buf));
    }
    const root = path.resolve(unpackedDir);
    let added = 0;
    let skipped = 0;
    let left = MAX_CARD_PHOTOS - current.photos.length;
    for (const rel of sources) {
      const full = path.resolve(root, rel);
      // Путь пришёл из XML 1С — наружу из каталога выгрузки не выходим.
      if (!full.startsWith(root + path.sep)) continue;
      const info = await stat(full).catch(() => null);
      if (!info?.isFile() || info.size > MAX_IMAGE_BYTES) {
        skipped++;
        continue;
      }
      const buf = await readFile(full);
      const digest = sha(buf);
      if (have.has(digest)) {
        skipped++;
        continue;
      }
      if (left <= 0) {
        skipped++;
        continue;
      }
      let file: string;
      try {
        file = await saveImage(uploadsDir, buf);
      } catch {
        skipped++; // не картинка
        continue;
      }
      try {
        await cards.repo.addPhoto(cardId, file);
      } catch (err) {
        await removeOwnFile(uploadsDir, file);
        throw err;
      }
      have.add(digest);
      added++;
      left--;
    }
    return { ...dto(await cards.get(cardId)), import: { found: sources.length, added, skipped } };
  });

  adm.put('/admin/api/cards/:id/photos/order', async (req) => {
    const cardId = parseId((req.params as { id: string }).id, 'карточки');
    const ids = (req.body as { ids?: unknown } | null)?.ids;
    if (!Array.isArray(ids) || !ids.every((i) => Number.isInteger(i) && i > 0)) {
      throw new AdminError('ids: ожидается массив id фото');
    }
    await cards.repo.reorderPhotos(cardId, ids as number[]);
    return dto(await cards.get(cardId));
  });

  adm.delete('/admin/api/cards/:id/photos/:photoId', async (req) => {
    const params = req.params as { id: string; photoId: string };
    const cardId = parseId(params.id, 'карточки');
    const file = await cards.repo.removePhoto(cardId, parseId(params.photoId, 'фото'));
    await removeOwnFile(uploadsDir, file);
    return dto(await cards.get(cardId));
  });
}
