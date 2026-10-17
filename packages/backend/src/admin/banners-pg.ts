import pg from 'pg';
import { SITE_BANNER_PLACEMENT_DDL } from './banner-placement-schema.js';
import { SITE_BANNER_PROMO_DDL } from './banner-promo-schema.js';
import { SITE_BANNER_VIDEO_DDL } from './banner-video-schema.js';
import { SITE_BANNERS_DDL } from './banners-schema.js';
import type {
  BannerFileKind,
  BannerPatch,
  BannerPlacement,
  BannerRepository,
  NewBanner,
  SiteBanner,
} from './banners.js';
import { AdminError } from './types.js';

interface Row {
  id: string;
  placement: BannerPlacement;
  title: string;
  subtitle: string;
  button_text: string;
  link: string;
  theme: 'light' | 'dark';
  image: string | null;
  image_mobile: string | null;
  video: string | null;
  video_mobile: string | null;
  focus_x: number;
  focus_y: number;
  mobile_focus_x: number;
  mobile_focus_y: number;
  active: boolean;
  sort: number;
  created_at: Date;
  updated_at: Date;
}

const COLS = `id::text, placement, title, subtitle, button_text, link, theme, image, image_mobile,
  video, video_mobile, focus_x, focus_y, mobile_focus_x, mobile_focus_y, active, sort, created_at, updated_at`;

const COLUMN: Record<keyof BannerPatch, string> = {
  title: 'title',
  subtitle: 'subtitle',
  buttonText: 'button_text',
  link: 'link',
  theme: 'theme',
  focusX: 'focus_x',
  focusY: 'focus_y',
  mobileFocusX: 'mobile_focus_x',
  mobileFocusY: 'mobile_focus_y',
  active: 'active',
};

const FILE_COLUMN: Record<BannerFileKind, string> = {
  image: 'image',
  imageMobile: 'image_mobile',
  video: 'video',
  videoMobile: 'video_mobile',
};

const view = (r: Row): SiteBanner => ({
  id: Number(r.id),
  placement: r.placement,
  title: r.title,
  subtitle: r.subtitle,
  buttonText: r.button_text,
  link: r.link,
  theme: r.theme,
  image: r.image,
  imageMobile: r.image_mobile,
  video: r.video,
  videoMobile: r.video_mobile,
  focusX: r.focus_x,
  focusY: r.focus_y,
  mobileFocusX: r.mobile_focus_x,
  mobileFocusY: r.mobile_focus_y,
  active: r.active,
  sort: r.sort,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export class PgBannerRepository implements BannerRepository {
  private readonly pool: pg.Pool;
  private prepared: Promise<unknown> | undefined;

  constructor(databaseUrl: string, poolSize = 3) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: poolSize });
  }

  ready(): Promise<void> {
    this.prepared ??= this.pool
      .query(
        `${SITE_BANNERS_DDL}\n${SITE_BANNER_VIDEO_DDL}\n${SITE_BANNER_PLACEMENT_DDL}\n${SITE_BANNER_PROMO_DDL}`,
      )
      .catch((err: unknown) => {
        this.prepared = undefined;
        throw err;
      });
    return this.prepared.then(() => undefined);
  }

  async list(): Promise<SiteBanner[]> {
    await this.ready();
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLS} FROM site_banners ORDER BY sort, id`,
    );
    return rows.map(view);
  }

  async get(id: number): Promise<SiteBanner | null> {
    await this.ready();
    const { rows } = await this.pool.query<Row>(`SELECT ${COLS} FROM site_banners WHERE id = $1`, [
      id,
    ]);
    return rows[0] ? view(rows[0]) : null;
  }

  async create(input: NewBanner): Promise<SiteBanner> {
    await this.ready();
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO site_banners (title, subtitle, button_text, link, theme, focus_x, focus_y,
         mobile_focus_x, mobile_focus_y, active, placement, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
         (SELECT COALESCE(MAX(sort), 0) + 1 FROM site_banners))
       RETURNING ${COLS}`,
      [
        input.title,
        input.subtitle,
        input.buttonText,
        input.link,
        input.theme,
        input.focusX,
        input.focusY,
        input.mobileFocusX,
        input.mobileFocusY,
        input.active,
        input.placement,
      ],
    );
    return view(rows[0]!);
  }

  async update(id: number, patch: BannerPatch): Promise<SiteBanner> {
    await this.ready();
    const keys = Object.keys(patch) as (keyof BannerPatch)[];
    const sets = keys.map((k, i) => `${COLUMN[k]} = $${i + 2}`);
    const { rows } = await this.pool.query<Row>(
      `UPDATE site_banners SET ${[...sets, 'updated_at = now()'].join(', ')}
       WHERE id = $1 RETURNING ${COLS}`,
      [id, ...keys.map((k) => patch[k])],
    );
    if (!rows[0]) throw new AdminError('Баннер не найден', 404);
    return view(rows[0]);
  }

  async delete(id: number): Promise<string[]> {
    await this.ready();
    const { rows } = await this.pool.query<
      Pick<Row, 'image' | 'image_mobile' | 'video' | 'video_mobile'>
    >('DELETE FROM site_banners WHERE id = $1 RETURNING image, image_mobile, video, video_mobile', [
      id,
    ]);
    if (!rows[0]) throw new AdminError('Баннер не найден', 404);
    return [rows[0].image, rows[0].image_mobile, rows[0].video, rows[0].video_mobile].filter(
      (f): f is string => !!f,
    );
  }

  async setFile(id: number, kind: BannerFileKind, file: string | null) {
    await this.ready();
    const col = FILE_COLUMN[kind];
    const { rows } = await this.pool.query<{ old: string | null }>(
      `UPDATE site_banners b SET ${col} = $2, updated_at = now()
       FROM (SELECT id, ${col} AS old FROM site_banners WHERE id = $1 FOR UPDATE) o
       WHERE b.id = o.id RETURNING o.old`,
      [id, file],
    );
    if (!rows[0]) throw new AdminError('Баннер не найден', 404);
    return rows[0].old;
  }

  async reorder(ids: number[]): Promise<void> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        'SELECT id::text FROM site_banners FOR UPDATE',
      );
      const all = rows.map((r) => Number(r.id)).sort((a, b) => a - b);
      if (
        ids.length !== all.length ||
        [...ids].sort((a, b) => a - b).some((v, i) => v !== all[i])
      ) {
        throw new AdminError('ids: нужны все баннеры ровно по одному разу');
      }
      for (let i = 0; i < ids.length; i++) {
        await client.query('UPDATE site_banners SET sort = $2 WHERE id = $1', [ids[i], i + 1]);
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
