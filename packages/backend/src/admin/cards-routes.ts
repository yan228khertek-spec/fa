import type { FastifyInstance } from 'fastify';
import { MAX_CARD_PHOTOS, type CardService } from './cards.js';
import { page, parseId, removeOwnFile, saveImage } from './http.js';
import { AdminError, type CardPhoto } from './types.js';

interface Deps {
  cards: CardService;
  uploadsDir: string;
  uploadUrl: (file: string | null) => string | null;
  modelPhoto: (path: string | null) => string | null;
}

/** Маршруты админки карточек (регистрируются внутри защищённой области /admin). */
export function registerCardRoutes(adm: FastifyInstance, deps: Deps): void {
  const { cards, uploadsDir, uploadUrl } = deps;

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
