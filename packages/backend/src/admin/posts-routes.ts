import type { FastifyInstance } from 'fastify';
import { parseId, removeOwnFile, saveImage } from './http.js';
import type { PostService, SitePost } from './posts.js';
import { AdminError } from './types.js';

interface Deps {
  posts: PostService;
  uploadsDir: string;
  uploadUrl: (file: string | null) => string | null;
}

export const postDto = (p: SitePost, uploadUrl: Deps['uploadUrl']) => ({
  ...p,
  image: uploadUrl(p.image),
});

/** Маршруты админки блога (внутри защищённой области /admin). */
export function registerPostRoutes(adm: FastifyInstance, deps: Deps): void {
  const { posts, uploadsDir, uploadUrl } = deps;
  const dto = (p: SitePost) => postDto(p, uploadUrl);
  const one = async (id: number) => {
    const p = await posts.repo.get(id);
    if (!p) throw new AdminError('Пост не найден', 404);
    return dto(p);
  };
  const idOf = (req: { params: unknown }) => parseId((req.params as { id: string }).id, 'поста');

  adm.get('/admin/api/posts', async () => (await posts.list()).map(dto));

  adm.post('/admin/api/posts', async (req, reply) =>
    reply.code(201).send(dto(await posts.create((req.body ?? {}) as Record<string, unknown>))),
  );

  adm.put('/admin/api/posts/:id', async (req) =>
    dto(await posts.update(idOf(req), (req.body ?? {}) as Record<string, unknown>)),
  );

  adm.delete('/admin/api/posts/:id', async (req) => {
    const files = await posts.repo.delete(idOf(req));
    for (const f of files) await removeOwnFile(uploadsDir, f);
    return { ok: true };
  });

  adm.put('/admin/api/posts-order', async (req) => {
    const ids = (req.body as { ids?: unknown } | null)?.ids;
    if (!Array.isArray(ids) || !ids.every((i) => Number.isInteger(i) && i > 0)) {
      throw new AdminError('ids: ожидается массив id постов');
    }
    await posts.repo.reorder(ids as number[]);
    return (await posts.list()).map(dto);
  });

  adm.post('/admin/api/posts/:id/image', async (req) => {
    const id = idOf(req);
    const file = await saveImage(uploadsDir, req.body);
    let old: string | null;
    try {
      old = await posts.repo.setImage(id, file);
    } catch (err) {
      await removeOwnFile(uploadsDir, file); // пост удалили между проверкой и записью
      throw err;
    }
    await removeOwnFile(uploadsDir, old);
    return one(id);
  });

  adm.delete('/admin/api/posts/:id/image', async (req) => {
    const id = idOf(req);
    await removeOwnFile(uploadsDir, await posts.repo.setImage(id, null));
    return one(id);
  });
}
