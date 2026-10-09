import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AdminConfig } from '../config.js';
import { FailureLimiter, checkAdminAuth } from './auth.js';
import { sniffImage } from './media.js';
import { seedBrands } from './seed.js';
import type { BrandService } from './service.js';
import { AdminError, type Gender } from './types.js';

export interface AdminPluginOptions {
  admin: AdminConfig;
  service: BrandService;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Имена файлов, которые создаём сами; только такие отдаём и удаляем. */
const OWN_FILE_RE = /^[a-f0-9]{16}\.(?:jpg|png|webp|avif)$/;
const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};
/** Без этого заголовка запросы на изменение отклоняются (CSRF при Basic-авторизации). */
const CSRF_HEADER = 'x-fa-admin';
const UI_DIR = fileURLToPath(new URL('../../public/admin', import.meta.url));

function gender(v: unknown): Gender {
  if (v === 'men' || v === 'women') return v;
  throw new AdminError('gender: men или women');
}

function id(raw: string, what = 'бренда'): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new AdminError(`Некорректный id ${what}`);
  return n;
}

function page(q: { limit?: string; offset?: string }, max: number, dflt: number) {
  return {
    limit: Math.min(Math.max(Math.trunc(Number(q.limit ?? dflt)) || dflt, 1), max),
    offset: Math.max(Math.trunc(Number(q.offset ?? 0)) || 0, 0),
  };
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
  const { admin, service } = opts;
  const uploadsDir = path.resolve(admin.uploadsDir);
  await mkdir(uploadsDir, { recursive: true });

  const base = admin.publicBaseUrl.replace(/\/+$/, '');
  const imagesBase = admin.imagesBaseUrl || `${base}/images/`;
  const uploadUrl = (f: string | null): string | null => (f ? `${base}/uploads/${f}` : null);
  const modelPhoto = (p: string | null): string | null =>
    p ? `${imagesBase.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}` : null;

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
      const res = await service.brandModels(slug, limit, offset);
      if (!res) return reply.code(404).send({ error: 'Бренд не найден' });
      reply.header('cache-control', 'public, max-age=60');
      return {
        brand: res.brand,
        total: res.total,
        items: res.items.map((m) => ({
          id: m.id,
          name: m.name,
          skus: m.skus,
          photo: modelPhoto(m.photo),
        })),
      };
    });

    pub.get('/uploads/:file', async (req, reply) => {
      const { file } = req.params as { file: string };
      if (!OWN_FILE_RE.test(file)) return reply.code(404).send({ error: 'Не найдено' });
      const full = path.join(uploadsDir, file);
      try {
        await stat(full);
      } catch {
        return reply.code(404).send({ error: 'Не найдено' });
      }
      return reply
        .header('content-type', MIME[file.split('.')[1]!])
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'public, max-age=604800, immutable')
        .send(createReadStream(full));
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
          id((req.params as { id: string }).id),
          (req.body ?? {}) as Record<string, unknown>,
        ),
      ),
    );

    const removeOwnFile = async (name: string | null): Promise<void> => {
      if (name && OWN_FILE_RE.test(name))
        await unlink(path.join(uploadsDir, name)).catch(() => undefined);
    };

    adm.delete('/admin/api/brands/:id', async (req) => {
      const brandId = id((req.params as { id: string }).id);
      const brand = (await service.repo.listBrands()).find((b) => b.id === brandId);
      await service.repo.deleteBrand(brandId);
      await removeOwnFile(brand?.photo ?? null);
      await removeOwnFile(brand?.logo ?? null);
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
      const brandId = id(rawId);
      if (kind !== 'photo' && kind !== 'logo') throw new AdminError('kind: photo или logo');
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) throw new AdminError('Файл не передан');
      // Тип — по сигнатуре, а не по заявленному Content-Type.
      const ext = sniffImage(buf);
      if (!ext) throw new AdminError('Нужна картинка JPEG, PNG, WebP или AVIF');

      const filename = `${randomBytes(8).toString('hex')}.${ext}`;
      await writeFile(path.join(uploadsDir, filename), buf, { flag: 'wx' });
      let old: string | null;
      try {
        old = await service.repo.setImage(brandId, kind, filename);
      } catch (err) {
        await removeOwnFile(filename); // бренда нет — не оставляем сироту
        throw err;
      }
      await removeOwnFile(old);
      return dto(await viewOf(brandId));
    });

    adm.delete('/admin/api/brands/:id/image/:kind', async (req) => {
      const { id: rawId, kind } = req.params as { id: string; kind: string };
      const brandId = id(rawId);
      if (kind !== 'photo' && kind !== 'logo') throw new AdminError('kind: photo или logo');
      await removeOwnFile(await service.repo.setImage(brandId, kind, null));
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

    adm.post('/admin/api/recompute', async () => service.recompute());
    adm.post('/admin/api/seed', async () => {
      const res = await seedBrands(service);
      return { ...res, recompute: await service.recompute() };
    });
    adm.get('/admin/api/stats', async () => service.stats());
    adm.get('/admin/api/exchange', async () => service.catalog.exchangeStatus());
  });
}
