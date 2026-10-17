import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { MAX_IMAGE_BYTES, parseId, removeOwnFile, saveImage } from './http.js';
import type { BannerService, SiteBanner } from './banners.js';
import { AdminError } from './types.js';
import { saveVideo, type VideoCompressor } from './video.js';

interface Deps {
  banners: BannerService;
  uploadsDir: string;
  uploadUrl: (file: string | null) => string | null;
  compress: VideoCompressor;
}

export const bannerDto = (b: SiteBanner, uploadUrl: Deps['uploadUrl']) => ({
  ...b,
  image: uploadUrl(b.image),
  imageMobile: uploadUrl(b.imageMobile),
  video: uploadUrl(b.video),
  videoMobile: uploadUrl(b.videoMobile),
});

/** Маршруты админки баннеров (внутри защищённой области /admin). */
export function registerBannerRoutes(adm: FastifyInstance, deps: Deps): void {
  const { banners, uploadsDir, uploadUrl, compress } = deps;
  const sizeOf = async (f: string | null) =>
    f ? ((await stat(path.join(uploadsDir, f)).catch(() => null))?.size ?? null) : null;
  /** Для админки к ссылкам добавляем вес роликов на диске. */
  const dto = async (b: SiteBanner) => ({
    ...bannerDto(b, uploadUrl),
    videoBytes: await sizeOf(b.video),
    videoMobileBytes: await sizeOf(b.videoMobile),
  });
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

  adm.get('/admin/api/banners', async () => Promise.all((await banners.list()).map(dto)));

  adm.post('/admin/api/banners', async (req, reply) =>
    reply
      .code(201)
      .send(await dto(await banners.create((req.body ?? {}) as Record<string, unknown>))),
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
    return Promise.all((await banners.list()).map(dto));
  });

  adm.post('/admin/api/banners/:id/image/:kind', async (req) => {
    const { id: rawId, kind: rawKind } = req.params as { id: string; kind: string };
    const id = parseId(rawId, 'баннера');
    const kind = kindOf(rawKind);
    const file = await saveImage(uploadsDir, req.body);
    let old: string | null;
    try {
      old = await banners.repo.setFile(id, kind, file);
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
    const old = await banners.repo.setFile(id, kindOf(rawKind), null);
    await removeOwnFile(uploadsDir, old);
    return one(id);
  });

  const videoKind = (v: string): 'desktop' | 'mobile' => {
    if (v === 'desktop' || v === 'mobile') return v;
    throw new AdminError('kind: desktop или mobile');
  };

  // Видео: сжимаем на сервере и сохраняем как лёгкий MP4; в ответе — сколько было и стало.
  adm.post('/admin/api/banners/:id/video/:kind', async (req) => {
    const { id: rawId, kind: rawKind } = req.params as { id: string; kind: string };
    const id = parseId(rawId, 'баннера');
    const kind = videoKind(rawKind);
    if (!(await banners.repo.get(id))) throw new AdminError('Баннер не найден', 404);
    const saved = await saveVideo(uploadsDir, req.body, kind, compress);
    let old: string | null;
    try {
      old = await banners.repo.setFile(
        id,
        kind === 'desktop' ? 'video' : 'videoMobile',
        saved.file,
      );
    } catch (err) {
      await removeOwnFile(uploadsDir, saved.file);
      throw err;
    }
    await removeOwnFile(uploadsDir, old);
    return { ...(await one(id)), compression: { before: saved.before, after: saved.after } };
  });

  adm.delete('/admin/api/banners/:id/video/:kind', async (req) => {
    const { id: rawId, kind: rawKind } = req.params as { id: string; kind: string };
    const id = parseId(rawId, 'баннера');
    const kind = videoKind(rawKind);
    const old = await banners.repo.setFile(id, kind === 'desktop' ? 'video' : 'videoMobile', null);
    await removeOwnFile(uploadsDir, old);
    return one(id);
  });
}

export { MAX_IMAGE_BYTES };
