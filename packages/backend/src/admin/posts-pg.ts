import pg from 'pg';
import type { NewPost, PostPatch, PostRepository, SitePost } from './posts.js';
import { SITE_POSTS_DDL } from './posts-schema.js';
import { AdminError, type Audience } from './types.js';

interface Row {
  id: string;
  gender: Audience;
  title: string;
  badge: string;
  description: string;
  button_text: string;
  link: string;
  image: string | null;
  active: boolean;
  sort: number;
  created_at: Date;
  updated_at: Date;
}

const COLS = `id::text, gender, title, badge, description, button_text, link, image, active, sort, created_at, updated_at`;

const COLUMN: Record<keyof PostPatch, string> = {
  gender: 'gender',
  title: 'title',
  badge: 'badge',
  description: 'description',
  buttonText: 'button_text',
  link: 'link',
  active: 'active',
};

const view = (r: Row): SitePost => ({
  id: Number(r.id),
  gender: r.gender,
  title: r.title,
  badge: r.badge,
  description: r.description,
  buttonText: r.button_text,
  link: r.link,
  image: r.image,
  active: r.active,
  sort: r.sort,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export class PgPostRepository implements PostRepository {
  private readonly pool: pg.Pool;
  private prepared: Promise<unknown> | undefined;

  constructor(databaseUrl: string, poolSize = 3) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: poolSize });
  }

  ready(): Promise<void> {
    this.prepared ??= this.pool.query(SITE_POSTS_DDL).catch((err: unknown) => {
      this.prepared = undefined;
      throw err;
    });
    return this.prepared.then(() => undefined);
  }

  async list(): Promise<SitePost[]> {
    await this.ready();
    const { rows } = await this.pool.query<Row>(`SELECT ${COLS} FROM site_posts ORDER BY sort, id`);
    return rows.map(view);
  }

  async get(id: number): Promise<SitePost | null> {
    await this.ready();
    const { rows } = await this.pool.query<Row>(`SELECT ${COLS} FROM site_posts WHERE id = $1`, [
      id,
    ]);
    return rows[0] ? view(rows[0]) : null;
  }

  async create(input: NewPost): Promise<SitePost> {
    await this.ready();
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO site_posts (gender, title, badge, description, button_text, link, active, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7, (SELECT LEAST(COALESCE(MIN(sort), 1), 1) - 1 FROM site_posts))
       RETURNING ${COLS}`,
      [
        input.gender,
        input.title,
        input.badge,
        input.description,
        input.buttonText,
        input.link,
        input.active,
      ],
    );
    return view(rows[0]!);
  }

  async update(id: number, patch: PostPatch): Promise<SitePost> {
    await this.ready();
    const keys = Object.keys(patch) as (keyof PostPatch)[];
    const sets = keys.map((k, i) => `${COLUMN[k]} = $${i + 2}`);
    const { rows } = await this.pool.query<Row>(
      `UPDATE site_posts SET ${[...sets, 'updated_at = now()'].join(', ')}
       WHERE id = $1 RETURNING ${COLS}`,
      [id, ...keys.map((k) => patch[k])],
    );
    if (!rows[0]) throw new AdminError('Пост не найден', 404);
    return view(rows[0]);
  }

  async delete(id: number): Promise<string[]> {
    await this.ready();
    const { rows } = await this.pool.query<Pick<Row, 'image'>>(
      'DELETE FROM site_posts WHERE id = $1 RETURNING image',
      [id],
    );
    if (!rows[0]) throw new AdminError('Пост не найден', 404);
    return rows[0].image ? [rows[0].image] : [];
  }

  async setImage(id: number, file: string | null) {
    await this.ready();
    const { rows } = await this.pool.query<{ old: string | null }>(
      `UPDATE site_posts p SET image = $2, updated_at = now()
       FROM (SELECT id, image AS old FROM site_posts WHERE id = $1 FOR UPDATE) o
       WHERE p.id = o.id RETURNING o.old`,
      [id, file],
    );
    if (!rows[0]) throw new AdminError('Пост не найден', 404);
    return rows[0].old;
  }

  async reorder(ids: number[]): Promise<void> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        'SELECT id::text FROM site_posts FOR UPDATE',
      );
      const all = rows.map((r) => Number(r.id)).sort((a, b) => a - b);
      if (
        ids.length !== all.length ||
        [...ids].sort((a, b) => a - b).some((v, i) => v !== all[i])
      ) {
        throw new AdminError('ids: нужны все посты ровно по одному разу');
      }
      for (let i = 0; i < ids.length; i++) {
        await client.query('UPDATE site_posts SET sort = $2 WHERE id = $1', [ids[i], i + 1]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
