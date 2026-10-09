import {
  AdminError,
  type CardPatch,
  type CardPhoto,
  type CardRepository,
  type NewCard,
  type SiteCard,
} from './types.js';

const clone = (c: SiteCard): SiteCard => structuredClone(c);

/** Хранилище карточек в памяти: dev без БД и тесты (контракт как у PgCardRepository). */
export class MemoryCardRepository implements CardRepository {
  private cards = new Map<number, SiteCard>();
  private seq = 0;
  private photoSeq = 0;

  async ready(): Promise<void> {}

  private get(id: number): SiteCard {
    const c = this.cards.get(id);
    if (!c) throw new AdminError('Карточка не найдена', 404);
    return c;
  }

  async listCards(): Promise<SiteCard[]> {
    return [...this.cards.values()].map(clone);
  }

  async getCard(id: number): Promise<SiteCard | null> {
    const c = this.cards.get(id);
    return c ? clone(c) : null;
  }

  async createCard(input: NewCard): Promise<SiteCard> {
    for (const c of this.cards.values()) {
      if (c.modelId === input.modelId) {
        throw new AdminError('Для этой модели карточка уже есть', 409);
      }
    }
    const now = new Date().toISOString();
    const card: SiteCard = {
      id: ++this.seq,
      modelId: input.modelId,
      title: input.title,
      description: input.description,
      characteristics: structuredClone(input.characteristics),
      status: 'draft',
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
      photos: [],
    };
    this.cards.set(card.id, card);
    return clone(card);
  }

  async updateCard(id: number, patch: CardPatch): Promise<SiteCard> {
    const c = this.get(id);
    if (patch.title !== undefined) c.title = patch.title;
    if (patch.description !== undefined) c.description = patch.description;
    if (patch.characteristics !== undefined)
      c.characteristics = structuredClone(patch.characteristics);
    if (patch.status !== undefined && patch.status !== c.status) {
      c.status = patch.status;
      c.publishedAt = patch.status === 'published' ? new Date().toISOString() : null;
    }
    c.updatedAt = new Date().toISOString();
    return clone(c);
  }

  async deleteCard(id: number): Promise<string[]> {
    const c = this.get(id);
    this.cards.delete(id);
    return c.photos.map((p) => p.file);
  }

  async addPhoto(cardId: number, file: string): Promise<CardPhoto> {
    const c = this.get(cardId);
    const photo: CardPhoto = {
      id: ++this.photoSeq,
      file,
      sort: c.photos.reduce((m, p) => Math.max(m, p.sort + 1), 0),
    };
    c.photos.push(photo);
    return { ...photo };
  }

  async removePhoto(cardId: number, photoId: number): Promise<string | null> {
    const c = this.get(cardId);
    const photo = c.photos.find((p) => p.id === photoId);
    if (!photo) return null;
    c.photos = c.photos.filter((p) => p.id !== photoId);
    return photo.file;
  }

  async reorderPhotos(cardId: number, ids: number[]): Promise<void> {
    const c = this.get(cardId);
    const have = new Set(c.photos.map((p) => p.id));
    if (
      ids.length !== have.size ||
      !ids.every((i) => have.has(i)) ||
      new Set(ids).size !== ids.length
    ) {
      throw new AdminError('Порядок должен содержать все фото карточки ровно по одному разу');
    }
    c.photos = ids.map((id, i) => ({ ...c.photos.find((p) => p.id === id)!, sort: i }));
  }

  async close(): Promise<void> {}
}
