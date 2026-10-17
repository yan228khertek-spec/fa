import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AdminConfig } from '../config.js';
import { FailureLimiter, checkAdminAuth } from './auth.js';
import { bannerDto, registerBannerRoutes } from './banners-routes.js';
import { BANNER_PLACEMENTS, type BannerPlacement, type BannerService } from './banners.js';
import { registerTickerRoutes } from './ticker-routes.js';
import type { TickerService } from './ticker.js';
import { registerCardRoutes } from './cards-routes.js';
import type { CardService, CardSort } from './cards.js';
import { MAX_VIDEO_UPLOAD_BYTES, type PosterMaker, type VideoCompressor } from './video.js';
import { MAX_IMAGE_BYTES, OWN_FILE_RE, page, parseId, removeOwnFile, saveImage } from './http.js';
import { seedBrands } from './seed.js';
import type { BrandService } from './service.js';
import { AdminError, type Gender } from './types.js';

export interface AdminPluginOptions {
  admin: AdminConfig;
  service: BrandService;
  cards: CardService;
  banners: BannerService;
  ticker: TickerService;
  /**
   * Где лежат картинки выгрузки 1С, в порядке поиска. Первый каталог —
   * постоянное медиа-хранилище (A2/M1), второй — spool/unpacked, который
   * чистится следующим обменом (запасной путь, пока media не наполнено).
   */
  imageDirs: string[];
  /** Сжатие видео баннеров (ffmpeg); в тестах подменяется. */
  videoCompressor: VideoCompressor;
  /** Кадр из видео для постера баннера (ffmpeg); в тестах подменяется. */
  posterMaker: PosterMaker;
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
};
/** Без этого заголовка запросы на изменение отклоняются (CSRF при Basic-авторизации). */
const CSRF_HEADER = 'x-fa-admin';
const UI_DIR = fileURLToPath(new URL('../../public/admin', import.meta.url));

function gender(v: unknown): Gender {
  if (v === 'men' || v === 'women') return v;
  throw new AdminError('gender: men или women');
}

/**
 * Витринный слой брендов: публичное API для сайта + админка (HTML и JSON API).
 *
 * Публично (без авторизации, CORS *):
 *   GET /api/brands?gender=men|women   — «Топ бренды» и список «Все бренды»
 *   GET /api/brands/:slug/models       — модели бренда
 *   GET /uploads/:file                 — фото и логотипы брендов
 * Админка (Basic + заголовок X-FA-Admin на изменения): /admin и /admin/api/*.
 * Пустые ADMIN_LOGIN/ADMIN_PASSWORD выключают админку, публичное API остаётся.
 */
export async function adminPlugin(app: FastifyInstance, opts: AdminPluginOptions): Promise<void> {
  const { admin, service, cards, banners, ticker, imageDirs, videoCompressor, posterMaker } = opts;
  const uploadsDir = path.resolve(admin.uploadsDir);
  await mkdir(uploadsDir, { recursive: true });

  const base = admin.publicBaseUrl.replace(/\/+$/, '');
  const imagesBase = admin.imagesBaseUrl || `${base}/images/`;
  const uploadUrl = (f: string | null): string | null => (f ? `${base}/uploads/${f}` : null);
  const modelPhoto = (p: string | null): string | null =>
    p ? `${imagesBase.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}` : null;

  /** Фильтры списка из query: brand/size/color — через запятую, pmin/pmax — рубли, sort — new|priceAsc|priceDesc. */
  const listFilters = (q: Record<string, string | undefined>) => {
    const list = (v?: string) =>
      (v ?? '')
        .split(',')
        .map((x) => x.trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 30);
    const num = (v?: string) => {
      if (v === undefined || v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    return {
      brands: list(q.brand),
      sizes: list(q.size),
      colors: list(q.color),
      priceMin: num(q.pmin),
      priceMax: num(q.pmax),
      sort: (q.sort === 'priceAsc' || q.sort === 'priceDesc' ? q.sort : 'new') as CardSort,
    };
  };

  const publicItem = <T extends { photo: string | null }>(c: T) => ({
    ...c,
    photo: uploadUrl(c.photo),
  });

  // ---------- публичная часть ----------
  await app.register(async (pub) => {
    pub.addHook('onSend', async (_req, reply) => {
      reply.header('access-control-allow-origin', '*');
    });

    pub.get('/api/brands', async (req, reply) => {
      const g = (req.query as { gender?: string }).gender ?? 'women';
      if (g !== 'men' && g !== 'women')
        return reply.code(400).send({ error: 'gender: men или women' });
      const list = await service.publicBrands(g);
      reply.header('cache-control', 'public, max-age=60');
      return {
        gender: list.gender,
        top: list.top.map((t) => ({ ...t, photo: uploadUrl(t.photo), logo: uploadUrl(t.logo) })),
        all: list.all,
      };
    });

    pub.get('/api/brands/:slug/models', async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const { limit, offset } = page(req.query as { limit?: string; offset?: string }, 100, 24);
      const brand = await service.brandBySlug(slug);
      if (!brand) return reply.code(404).send({ error: 'Бренд не найден' });
      const { category, kind } = req.query as { category?: string; kind?: string };
      const res = await cards.publicList({
        brandSlug: slug,
        category: category?.slice(0, 40),
        kind: kind?.slice(0, 60),
        ...listFilters(req.query as Record<string, string | undefined>),
        limit,
        offset,
      });
      reply.header('cache-control', 'public, max-age=60');
      return { brand, total: res.total, facets: res.facets, items: res.items.map(publicItem) };
    });

    // Главная страница: бренды с флагом «Показывать на главной» и их последние карточки
    pub.get('/api/home', async (_req, reply) => {
      const sections = await cards.homeSections();
      reply.header('cache-control', 'public, max-age=30');
      return {
        brands: sections.map((s) => ({
          ...s.brand,
          total: s.total,
          items: s.items.map(publicItem),
        })),
      };
    });

    // Баннеры главной: включённые, с картинкой, по порядку. Точки фокуса — для обрезки под экран
    pub.get('/api/banners', async (req, reply) => {
      const place = (req.query as { placement?: string }).placement ?? 'hero';
      if (!(BANNER_PLACEMENTS as readonly string[]).includes(place)) {
        return reply.code(400).send({ error: 'placement: hero, perfume или promo' });
      }
      const list = await banners.publicList(place as BannerPlacement);
      reply.header('cache-control', 'public, max-age=30');
      return {
        items: list.map((b) => {
          const d = bannerDto(b, uploadUrl);
          return {
            id: d.id,
            title: d.title,
            subtitle: d.subtitle,
            buttonText: d.buttonText,
            link: d.link,
            theme: d.theme,
            image: d.image,
            imageMobile: d.imageMobile,
            video: d.video,
            videoMobile: d.videoMobile,
            focus: { x: d.focusX, y: d.focusY },
            mobileFocus: { x: d.mobileFocusX, y: d.mobileFocusY },
          };
        }),
      };
    });

    // Бегущая строка главной: стандартная или текущая акция из графика (по омскому календарю)
    pub.get('/api/ticker', async (_req, reply) => {
      const t = await ticker.current();
      reply.header('cache-control', 'public, max-age=60');
      return {
        items: t.items,
        bgColor: t.bgColor,
        textColor: t.textColor,
        source: t.source,
        until: t.until,
      };
    });

    pub.get('/api/cards', async (req, reply) => {
      const { limit, offset } = page(req.query as { limit?: string; offset?: string }, 100, 24);
      const { category, kind } = req.query as { category?: string; kind?: string };
      const res = await cards.publicList({
        category: category?.slice(0, 40),
        kind: kind?.slice(0, 60),
        ...listFilters(req.query as Record<string, string | undefined>),
        limit,
        offset,
      });
      reply.header('cache-control', 'public, max-age=30');
      return { total: res.total, facets: res.facets, items: res.items.map(publicItem) };
    });

    pub.get('/api/cards/:id', async (req, reply) => {
      const raw = Number((req.params as { id: string }).id);
      const card = Number.isInteger(raw) && raw > 0 ? await cards.publicCard(raw) : null;
      if (!card) return reply.code(404).send({ error: 'Не найдено' });
      reply.header('cache-control', 'public, max-age=30');
      return {
        ...publicItem(card),
        article: card.article,
        description: card.description,
        characteristics: card.characteristics,
        photos: card.photos.map((f) => uploadUrl(f)),
        sizes: card.sizes,
      };
    });

    pub.get('/uploads/:file', async (req, reply) => {
      const { file } = req.params as { file: string };
      if (!OWN_FILE_RE.test(file)) return reply.code(404).send({ error: 'Не найдено' });
      const full = path.join(uploadsDir, file);
      let size: number;
      try {
        size = (await stat(full)).size;
      } catch {
        return reply.code(404).send({ error: 'Не найдено' });
      }
      reply
        .header('content-type', MIME[file.split('.')[1]!])
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'public, max-age=604800, immutable');
      if (!file.endsWith('.mp4')) return reply.send(createReadStream(full));
      // Видео: Safari и iOS не играют ролик без частичных ответов (Range).
      reply.header('accept-ranges', 'bytes');
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (!m || (m[1] === '' && m[2] === ''))
        return reply.header('content-length', size).send(createReadStream(full));
      let start = m[1] === '' ? Math.max(size - Number(m[2]), 0) : Number(m[1]);
      let end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      if (start > end || start >= size) {
        return reply.code(416).header('content-range', `bytes */${size}`).send();
      }
      start = Math.max(start, 0);
      end = Math.max(end, start);
      return reply
        .code(206)
        .header('content-range', `bytes ${start}-${end}/${size}`)
        .header('content-length', end - start + 1)
        .send(createReadStream(full, { start, end }));
    });
  });

  // ---------- админка ----------
  if (!admin.login || !admin.password) {
    app.log.warn(
      'ADMIN_LOGIN/ADMIN_PASSWORD не заданы — админка выключена, публичное API работает',
    );
    return;
  }

  // Каталог ответственен за первый пересчёт: после старта/обмена привязки моделей актуальны.
  service
    .recompute()
    .catch((err: unknown) => app.log.error({ err }, 'пересчёт брендов при старте'));

  await app.register(async (adm) => {
    const limiter = new FailureLimiter();
    // Картинки приходят «сырым» телом (без multipart — не тянем зависимости).
    for (const type of [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/avif',
      'application/octet-stream',
    ]) {
      adm.addContentTypeParser(
        type,
        { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES },
        (_req, body, done) => done(null, body),
      );
    }
    // Видео — тот же «сырой» приём, но с большим лимитом (потом сжимается).
    for (const type of ['video/mp4', 'video/webm', 'video/quicktime']) {
      adm.addContentTypeParser(
        type,
        { parseAs: 'buffer', bodyLimit: MAX_VIDEO_UPLOAD_BYTES },
        (_req, body, done) => done(null, body),
      );
    }

    adm.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      if (limiter.blocked(req.ip)) {
        return reply.code(429).header('retry-after', '600').send('Слишком много попыток входа');
      }
      if (!checkAdminAuth(req.headers.authorization, admin.login, admin.password)) {
        limiter.fail(req.ip);
        return reply
          .code(401)
          .header('www-authenticate', 'Basic realm="Fashion Avenue admin", charset="UTF-8"')
          .send('Нужна авторизация');
      }
      limiter.reset(req.ip);
      reply.header('cache-control', 'no-store');
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers[CSRF_HEADER] !== '1') {
        return reply.code(403).send({ error: 'Нет заголовка X-FA-Admin' });
      }
      return undefined;
    });

    adm.setErrorHandler((err: Error & { code?: string; statusCode?: number }, req, reply) => {
      if (err instanceof AdminError) return reply.code(err.status).send({ error: err.message });
      if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        return reply.code(413).send({ error: 'Файл больше 8 МБ' });
      }
      if (err.statusCode && err.statusCode < 500) {
        return reply.code(err.statusCode).send({ error: 'Некорректный запрос' });
      }
      req.log.error({ err }, 'admin request failed');
      return reply.code(500).send({ error: 'Внутренняя ошибка, см. журнал сервера' });
    });

    const sendUi = async (_req: FastifyRequest, reply: FastifyReply) =>
      reply
        .type('text/html; charset=utf-8')
        .header(
          'content-security-policy',
          "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
        )
        .send(await readFile(path.join(UI_DIR, 'index.html')));
    adm.get('/admin', sendUi);
    adm.get('/admin/', sendUi);

    const dto = <T extends { photo: string | null; logo: string | null }>(b: T) => ({
      ...b,
      photo: uploadUrl(b.photo),
      logo: uploadUrl(b.logo),
    });
    const modelDto = (m: { id: string; name: string; skus: number; photo: string | null }) => ({
      ...m,
      photo: modelPhoto(m.photo),
    });

    adm.get('/admin/api/brands', async () => (await service.listBrands()).map(dto));

    adm.post('/admin/api/brands', async (req, reply) => {
      const brand = await service.createBrand((req.body ?? {}) as Record<string, unknown>);
      return reply.code(201).send(dto(brand));
    });

    adm.put('/admin/api/brands/:id', async (req) =>
      dto(
        await service.updateBrand(
          parseId((req.params as { id: string }).id),
          (req.body ?? {}) as Record<string, unknown>,
        ),
      ),
    );

    adm.delete('/admin/api/brands/:id', async (req) => {
      const brandId = parseId((req.params as { id: string }).id);
      const brand = (await service.repo.listBrands()).find((b) => b.id === brandId);
      await service.repo.deleteBrand(brandId);
      await removeOwnFile(uploadsDir, brand?.photo ?? null);
      await removeOwnFile(uploadsDir, brand?.logo ?? null);
      return { ok: true };
    });

    adm.put('/admin/api/top/:gender', async (req) => {
      const g = gender((req.params as { gender: string }).gender);
      const ids = (req.body as { ids?: unknown } | null)?.ids;
      if (
        !Array.isArray(ids) ||
        ids.length > 50 ||
        !ids.every((i) => Number.isInteger(i) && i > 0)
      ) {
        throw new AdminError('ids: ожидается массив id брендов (до 50)');
      }
      await service.repo.setTop(g, ids as number[]);
      return { ok: true };
    });

    adm.post('/admin/api/brands/:id/image/:kind', async (req) => {
      const { id: rawId, kind } = req.params as { id: string; kind: string };
      const brandId = parseId(rawId);
      if (kind !== 'photo' && kind !== 'logo') throw new AdminError('kind: photo или logo');
      const filename = await saveImage(uploadsDir, req.body);
      let old: string | null;
      try {
        old = await service.repo.setImage(brandId, kind, filename);
      } catch (err) {
        await removeOwnFile(uploadsDir, filename); // бренда нет — не оставляем сироту
        throw err;
      }
      await removeOwnFile(uploadsDir, old);
      return dto(await viewOf(brandId));
    });

    adm.delete('/admin/api/brands/:id/image/:kind', async (req) => {
      const { id: rawId, kind } = req.params as { id: string; kind: string };
      const brandId = parseId(rawId);
      if (kind !== 'photo' && kind !== 'logo') throw new AdminError('kind: photo или logo');
      await removeOwnFile(uploadsDir, await service.repo.setImage(brandId, kind, null));
      return dto(await viewOf(brandId));
    });

    const viewOf = async (brandId: number) => {
      const found = (await service.listBrands()).find((b) => b.id === brandId);
      if (!found) throw new AdminError('Бренд не найден', 404);
      return found;
    };

    adm.get('/admin/api/unmatched', async (req) => {
      const q = req.query as { q?: string; limit?: string; offset?: string };
      const { limit, offset } = page(q, 200, 50);
      const res = await service.unmatched((q.q ?? '').slice(0, 100), limit, offset);
      return { ...res, items: res.items.map(modelDto) };
    });

    adm.put('/admin/api/models/:modelId/brand', async (req) => {
      const { modelId } = req.params as { modelId: string };
      const brandId = (req.body as { brandId?: unknown } | null)?.brandId;
      if (brandId !== null && !(Number.isInteger(brandId) && (brandId as number) > 0)) {
        throw new AdminError('brandId: число или null');
      }
      await service.assignModel(modelId, brandId as number | null);
      return { ok: true };
    });

    registerBannerRoutes(adm, {
      banners,
      uploadsDir,
      uploadUrl,
      compress: videoCompressor,
      poster: posterMaker,
    });
    registerTickerRoutes(adm, ticker);
    registerCardRoutes(adm, { cards, uploadsDir, imageDirs, uploadUrl, modelPhoto });

    adm.post('/admin/api/recompute', async () => service.recompute());
    adm.post('/admin/api/seed', async () => {
      const res = await seedBrands(service);
      return { ...res, recompute: await service.recompute() };
    });
    adm.get('/admin/api/stats', async () => service.stats());
    adm.get('/admin/api/exchange', async () => service.catalog.exchangeStatus());
  });
}
