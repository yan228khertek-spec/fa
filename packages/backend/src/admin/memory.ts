import {
  AdminError,
  GENDERS,
  type Assignment,
  type BrandPatch,
  type CatalogModel,
  type CatalogReader,
  type ExchangeStatus,
  type Gender,
  type ImageKind,
  type NewBrand,
  type Placements,
  type SiteBrand,
  type SiteBrandRepository,
} from './types.js';

const clone = (b: SiteBrand): SiteBrand => structuredClone(b);

/** Хранилище в памяти: dev без БД и тесты (тот же контракт, что у PgSiteBrandRepository). */
export class MemorySiteBrandRepository implements SiteBrandRepository {
  private brands = new Map<number, SiteBrand>();
  private assignments = new Map<string, Assignment>();
  private seq = 0;

  async ready(): Promise<void> {}

  async listBrands(): Promise<SiteBrand[]> {
    return [...this.brands.values()].map(clone);
  }

  private get(id: number): SiteBrand {
    const b = this.brands.get(id);
    if (!b) throw new AdminError('Бренд не найден', 404);
    return b;
  }

  private checkUnique(slug: string, aliases: string[], selfId?: number): void {
    for (const b of this.brands.values()) {
      if (b.id === selfId) continue;
      if (b.slug === slug) throw new AdminError(`Адрес «${slug}» уже занят`, 409);
      const dup = aliases.find((a) => b.aliases.includes(a));
      if (dup) throw new AdminError(`Написание «${dup}» уже у бренда «${b.name}»`, 409);
    }
  }

  async createBrand(input: NewBrand): Promise<SiteBrand> {
    this.checkUnique(input.slug, input.aliases);
    const brand: SiteBrand = {
      id: ++this.seq,
      slug: input.slug,
      name: input.name,
      aliases: [...input.aliases],
      photo: null,
      logo: null,
      placements: structuredClone(input.placements),
    };
    this.brands.set(brand.id, brand);
    return clone(brand);
  }

  async updateBrand(id: number, patch: BrandPatch): Promise<SiteBrand> {
    const b = this.get(id);
    this.checkUnique(patch.slug ?? b.slug, patch.aliases ?? [], id);
    if (patch.name !== undefined) b.name = patch.name;
    if (patch.slug !== undefined) b.slug = patch.slug;
    if (patch.aliases !== undefined) b.aliases = [...patch.aliases];
    if (patch.placements !== undefined) b.placements = structuredClone(patch.placements);
    return clone(b);
  }

  async deleteBrand(id: number): Promise<void> {
    this.get(id);
    this.brands.delete(id);
    for (const [model, a] of this.assignments) if (a.brandId === id) this.assignments.delete(model);
  }

  async setImage(id: number, kind: ImageKind, filename: string | null): Promise<string | null> {
    const b = this.get(id);
    const prev = b[kind];
    b[kind] = filename;
    return prev;
  }

  async setTop(gender: Gender, brandIds: number[]): Promise<void> {
    for (const id of brandIds) this.get(id);
    for (const b of this.brands.values()) {
      b.placements[gender].top = false;
      b.placements[gender].sort = 0;
    }
    brandIds.forEach((id, i) => {
      this.get(id).placements[gender] = { in: true, top: true, sort: i };
    });
  }

  async listAssignments(): Promise<Assignment[]> {
    return [...this.assignments.values()].map((a) => ({ ...a }));
  }

  async replaceAuto(items: { modelId: string; brandId: number }[]): Promise<void> {
    for (const [model, a] of this.assignments)
      if (a.origin === 'auto') this.assignments.delete(model);
    for (const it of items) {
      if (!this.brands.has(it.brandId) || this.assignments.has(it.modelId)) continue;
      this.assignments.set(it.modelId, { ...it, origin: 'auto' });
    }
  }

  async setManual(modelId: string, brandId: number | null): Promise<void> {
    if (brandId === null) {
      if (this.assignments.get(modelId)?.origin === 'manual') this.assignments.delete(modelId);
      return;
    }
    this.get(brandId);
    this.assignments.set(modelId, { modelId, brandId, origin: 'manual' });
  }

  async close(): Promise<void> {}
}

/** Каталог из массива — для тестов и dev без БД. */
export class MemoryCatalogReader implements CatalogReader {
  constructor(public models: CatalogModel[] = []) {}

  async listModels(): Promise<CatalogModel[]> {
    return this.models.map((m) => ({ ...m }));
  }

  async exchangeStatus(): Promise<ExchangeStatus> {
    return { log: [], catalogRuns: [], offersRuns: [] };
  }

  async close(): Promise<void> {}
}

export const emptyPlacements = (): Placements =>
  Object.fromEntries(GENDERS.map((g) => [g, { in: false, top: false, sort: 0 }])) as Placements;
