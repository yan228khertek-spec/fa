import type { FastifyInstance } from 'fastify';
import { MAX_IMAGE_BYTES, parseId, removeOwnFile, saveImage } from './http.js';
import type { BannerService, SiteBanner } from './banners.js';
import { AdminError } from './types.js';

interface Deps {
  banners: BannerService;
  uploadsDir: string;
  uploadUrl: (file: string | null) => string | null;
}

export const bannerDto = (b: SiteBanner, uploadUrl: Deps['uploadUrl']) => ({
  ...b,
  image: uploadUrl(b.image),
  imageMobile: uploadUrl(b.imageMobile),
});

/** Маршруты админки баннеров (внутри защищённой области /admin). */
export function registerBannerRoutes(adm: FastifyInstance, deps: Deps): void {
  const { banners, uploadsDir, uploadUrl } = deps;
  const dto = (b: SiteBanner) => bannerDto(b, uploadUrl);
  const kindOf = (v: string): 'image' | 'imageMobile' => {
    if (v === 'desktop') return 'image';
    if (v === 'mobile') return 'imageMobile';
    throw new AdminError('kind: desktop или mobile');
  };
  const one = async (id: number) => {
    const b = await banners.repo.get(id);
    if (!b) throw new AdminError('Баннер не найден', 404);
    return dto(b);
  };

  adm.get('/admin/api/banners', async () => (await banners.list()).map(dto));

  adm.post('/admin/api/banners', async (req, reply) =>
    reply.code(201).send(dto(await banners.create((req.body ?? {}) as Record<string, unknown>))),
  );

  adm.put('/admin/api/banners/:id', async (req) =>
    dto(
      await banners.update(
        parseId((req.params as { id: string }).id, 'баннера'),
        (req.body ?? {}) as Record<string, unknown>,
      ),
    ),
  );

  adm.delete('/admin/api/banners/:id', async (req) => {
    const files = await banners.repo.delete(parseId((req.params as { id: string }).id, 'баннера'));
    for (const f of files) await removeOwnFile(uploadsDir, f);
    return { ok: true };
  });

  adm.put('/admin/api/banners-order', async (req) => {
    const ids = (req.body as { ids?: unknown } | null)?.ids;
    if (!Array.isArray(ids) || !ids.every((i) => Number.isInteger(i) && i > 0)) {
      throw new AdminError('ids: ожидается массив id баннеров');
    }
    await banners.repo.reorder(ids as number[]);
    return (await banners.list()).map(dto);
  });

  adm.post('/admin/api/banners/:id/image/:kind', async (req) => {
    const { id: rawId, kind: rawKind } = req.params as { id: string; kind: string };
    const id = parseId(rawId, 'баннера');
    const kind = kindOf(rawKind);
    const file = await saveImage(uploadsDir, req.body);
    let old: string | null;
    try {
      old = await banners.repo.setImage(id, kind, file);
    } catch (err) {
      await removeOwnFile(uploadsDir, file); // баннер удалили между проверкой и записью
      throw err;
    }
    await removeOwnFile(uploadsDir, old);
    return one(id);
  });

  adm.delete('/admin/api/banners/:id/image/:kind', async (req) => {
    const { id: rawId, kind: rawKind } = req.params as { id: string; kind: string };
    const id = parseId(rawId, 'баннера');
    const old = await banners.repo.setImage(id, kindOf(rawKind), null);
    await removeOwnFile(uploadsDir, old);
    return one(id);
  });
}

export { MAX_IMAGE_BYTES };
