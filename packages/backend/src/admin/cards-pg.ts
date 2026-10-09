import pg from 'pg';
import { SITE_CARDS_DDL } from './cards-schema.js';
import {
  AdminError,
  type CardCharacteristic,
  type CardPatch,
  type CardPhoto,
  type CardRepository,
  type CardStatus,
  type NewCard,
  type SiteCard,
} from './types.js';

interface CardRow {
  id: string;
  model_source_id: string;
  title: string | null;
  description: string;
  characteristics: CardCharacteristic[];
  status: CardStatus;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLS = `id::text, model_source_id, title, description, characteristics, status,
  published_at, created_at, updated_at`;

export class PgCardRepository implements CardRepository {
  private readonly pool: pg.Pool;
  private prepared: Promise<unknown> | undefined;

  constructor(databaseUrl: string, poolSize = 3) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: poolSize });
  }

  ready(): Promise<void> {
    this.prepared ??= this.pool.query(SITE_CARDS_DDL).catch((err: unknown) => {
      this.prepared = undefined;
      throw err;
    });
    return this.prepared.then(() => undefined);
  }

  private async load(where: string, params: unknown[]): Promise<SiteCard[]> {
    await this.ready();
    const { rows } = await this.pool.query<CardRow>(
      `SELECT ${COLS} FROM site_cards ${where} ORDER BY updated_at DESC, id DESC`,
      params,
    );
    if (!rows.length) return [];
    const photos = await this.pool.query<{
      id: string;
      card_id: string;
      file: string;
      sort: number;
    }>(
      `SELECT id::text, card_id::text, file, sort FROM site_card_photos
        WHERE card_id = ANY($1) ORDER BY sort, id`,
      [rows.map((r) => Number(r.id))],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      modelId: r.model_source_id,
      title: r.title,
      description: r.description,
      characteristics: r.characteristics,
      status: r.status,
      publishedAt: r.published_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      photos: photos.rows
        .filter((p) => p.card_id === r.id)
        .map((p) => ({ id: Number(p.id), file: p.file, sort: p.sort })),
    }));
  }

  listCards(): Promise<SiteCard[]> {
    return this.load('', []);
  }

  async getCard(id: number): Promise<SiteCard | null> {
    return (await this.load('WHERE id = $1', [id]))[0] ?? null;
  }

  private async one(id: number): Promise<SiteCard> {
    const card = await this.getCard(id);
    if (!card) throw new AdminError('Карточка не найдена', 404);
    return card;
  }

  async createCard(input: NewCard): Promise<SiteCard> {
    await this.ready();
    try {
      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO site_cards (model_source_id, title, description, characteristics)
         VALUES ($1, $2, $3, $4::jsonb) RETURNING id::text`,
        [input.modelId, input.title, input.description, JSON.stringify(input.characteristics)],
      );
      return await this.one(Number(rows[0]!.id));
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AdminError('Для этой модели карточка уже есть', 409);
      }
      throw err;
    }
  }

  async updateCard(id: number, patch: CardPatch): Promise<SiteCard> {
    await this.ready();
    const { rowCount } = await this.pool.query(
      `UPDATE site_cards SET
         title = CASE WHEN $2::boolean THEN $3 ELSE title END,
         description = coalesce($4, description),
         characteristics = coalesce($5::jsonb, characteristics),
         published_at = CASE
           WHEN $6::text IS NULL OR $6 = status THEN published_at
           WHEN $6 = 'published' THEN now() ELSE NULL END,
         status = coalesce($6, status),
         updated_at = now()
       WHERE id = $1`,
      [
        id,
        patch.title !== undefined,
        patch.title ?? null,
        patch.description ?? null,
        patch.characteristics ? JSON.stringify(patch.characteristics) : null,
        patch.status ?? null,
      ],
    );
    if (!rowCount) throw new AdminError('Карточка не найдена', 404);
    return this.one(id);
  }

  async deleteCard(id: number): Promise<string[]> {
    await this.ready();
    const files = await this.pool.query<{ file: string }>(
      'SELECT file FROM site_card_photos WHERE card_id = $1',
      [id],
    );
    const { rowCount } = await this.pool.query('DELETE FROM site_cards WHERE id = $1', [id]);
    if (!rowCount) throw new AdminError('Карточка не найдена', 404);
    return files.rows.map((r) => r.file);
  }

  async addPhoto(cardId: number, file: string): Promise<CardPhoto> {
    await this.ready();
    try {
      const { rows } = await this.pool.query<{ id: string; sort: number }>(
        `INSERT INTO site_card_photos (card_id, file, sort)
         SELECT $1, $2, coalesce(max(sort) + 1, 0) FROM site_card_photos WHERE card_id = $1
         RETURNING id::text, sort`,
        [cardId, file],
      );
      await this.pool.query('UPDATE site_cards SET updated_at = now() WHERE id = $1', [cardId]);
      return { id: Number(rows[0]!.id), file, sort: rows[0]!.sort };
    } catch (err) {
      if ((err as { code?: string }).code === '23503')
        throw new AdminError('Карточка не найдена', 404);
      throw err;
    }
  }

  async removePhoto(cardId: number, photoId: number): Promise<string | null> {
    await this.ready();
    const { rows } = await this.pool.query<{ file: string }>(
      'DELETE FROM site_card_photos WHERE id = $1 AND card_id = $2 RETURNING file',
      [photoId, cardId],
    );
    if (rows[0])
      await this.pool.query('UPDATE site_cards SET updated_at = now() WHERE id = $1', [cardId]);
    return rows[0]?.file ?? null;
  }

  async reorderPhotos(cardId: number, ids: number[]): Promise<void> {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        'SELECT id::text FROM site_card_photos WHERE card_id = $1 FOR UPDATE',
        [cardId],
      );
      const have = new Set(rows.map((r) => Number(r.id)));
      if (
        ids.length !== have.size ||
        new Set(ids).size !== ids.length ||
        !ids.every((i) => have.has(i))
      ) {
        throw new AdminError('Порядок должен содержать все фото карточки ровно по одному разу');
      }
      for (const [i, id] of ids.entries()) {
        await client.query('UPDATE site_card_photos SET sort = $1 WHERE id = $2', [i, id]);
      }
      await client.query('UPDATE site_cards SET updated_at = now() WHERE id = $1', [cardId]);
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
