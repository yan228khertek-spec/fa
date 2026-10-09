import { candidateWords, matchBrand, normalizeText, type Candidate } from './matcher.js';
import { SLUG_RE, slugify } from './slug.js';
import {
  AdminError,
  GENDERS,
  type BrandPatch,
  type CatalogModel,
  type CatalogReader,
  type Gender,
  type Placement,
  type Placements,
  type SiteBrand,
  type SiteBrandRepository,
} from './types.js';

export interface BrandInput {
  name?: unknown;
  slug?: unknown;
  aliases?: unknown;
  placements?: unknown;
}

export interface RecomputeResult {
  models: number;
  auto: number;
  manual: number;
  unmatched: number;
}

export interface AdminBrandView extends SiteBrand {
  models: number;
}

export interface Page<T> {
  total: number;
  items: T[];
}

export interface PublicBrandList {
  gender: Gender;
  top: { name: string; slug: string; photo: string | null; logo: string | null }[];
  all: { name: string; slug: string }[];
}

export interface Stats {
  models: number;
  withoutPhoto: number;
  brands: number;
  assigned: number;
  unmatched: number;
}

const emptyPlacement = (): Placement => ({ in: false, top: false, sort: 0 });

function str(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string') throw new AdminError(`${field}: ожидается строка`);
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) throw new AdminError(`${field}: не может быть пустым`);
  if (s.length > max) throw new AdminError(`${field}: слишком длинное значение`);
  return s;
}

function parseAliases(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 50) throw new AdminError('aliases: ожидается массив (до 50)');
  const out = new Set<string>();
  for (const a of v) {
    if (typeof a !== 'string') throw new AdminError('aliases: ожидаются строки');
    const n = normalizeText(a);
    if (n.length >= 2) out.add(n);
  }
  return [...out];
}

/** Применяет частичные правки размещений к текущим и возвращает итог. */
function mergePlacements(current: Placements, raw: unknown): Placements {
  if (typeof raw !== 'object' || raw === null) throw new AdminError('placements: ожидается объект');
  const src = raw as Record<string, unknown>;
  const out = structuredClone(current);
  for (const g of GENDERS) {
    const p = src[g];
    if (p === undefined) continue;
    if (typeof p !== 'object' || p === null)
      throw new AdminError(`placements.${g}: ожидается объект`);
    const o = p as Record<string, unknown>;
    const next = out[g];
    if ('in' in o) {
      if (typeof o.in !== 'boolean') throw new AdminError(`placements.${g}.in: true/false`);
      next.in = o.in;
    }
    if ('top' in o) {
      if (typeof o.top !== 'boolean') throw new AdminError(`placements.${g}.top: true/false`);
      next.top = o.top;
      if (o.top) next.in = true;
    }
    if ('sort' in o) {
      if (typeof o.sort !== 'number' || !Number.isFinite(o.sort)) {
        throw new AdminError(`placements.${g}.sort: ожидается число`);
      }
      next.sort = Math.trunc(o.sort);
    }
    if (!next.in) out[g] = emptyPlacement();
  }
  return out;
}

/** Бизнес-логика брендов: валидация, привязка моделей к брендам, выборки для API. */
export class BrandService {
  constructor(
    readonly repo: SiteBrandRepository,
    readonly catalog: CatalogReader,
  ) {}

  private keys(brands: SiteBrand[]) {
    return brands.map((b) => ({ id: b.id, keys: [normalizeText(b.name), ...b.aliases] }));
  }

  /** Находит бренды для моделей без ручной привязки и сохраняет результат. */
  async recompute(): Promise<RecomputeResult> {
    const [brands, models, assigned] = await Promise.all([
      this.repo.listBrands(),
      this.catalog.listModels(),
      this.repo.listAssignments(),
    ]);
    const manual = new Set(assigned.filter((a) => a.origin === 'manual').map((a) => a.modelId));
    const keys = this.keys(brands);
    const auto: { modelId: string; brandId: number }[] = [];
    for (const m of models) {
      if (manual.has(m.id)) continue;
      const brandId = matchBrand(m.name, keys);
      if (brandId !== null) auto.push({ modelId: m.id, brandId });
    }
    await this.repo.replaceAuto(auto);
    const manualAlive = models.filter((m) => manual.has(m.id)).length;
    return {
      models: models.length,
      auto: auto.length,
      manual: manualAlive,
      unmatched: models.length - auto.length - manualAlive,
    };
  }

  async listBrands(): Promise<AdminBrandView[]> {
    const [brands, assigned] = await Promise.all([
      this.repo.listBrands(),
      this.repo.listAssignments(),
    ]);
    const counts = new Map<number, number>();
    for (const a of assigned) counts.set(a.brandId, (counts.get(a.brandId) ?? 0) + 1);
    return brands.map((b) => ({ ...b, models: counts.get(b.id) ?? 0 }));
  }

  private async view(id: number): Promise<AdminBrandView> {
    const found = (await this.listBrands()).find((b) => b.id === id);
    if (!found) throw new AdminError('Бренд не найден', 404);
    return found;
  }

  async createBrand(input: BrandInput): Promise<AdminBrandView> {
    const name = str(input.name, 'name', 120);
    const slug = input.slug === undefined ? slugify(name) : str(input.slug, 'slug', 80);
    if (!SLUG_RE.test(slug)) {
      throw new AdminError(
        'Адрес бренда: латиница, цифры и дефис (задайте вручную для такого названия)',
      );
    }
    const aliases = input.aliases === undefined ? [] : parseAliases(input.aliases);
    const blank: Placements = { men: emptyPlacement(), women: emptyPlacement() };
    const placements =
      input.placements === undefined ? blank : mergePlacements(blank, input.placements);
    const brand = await this.repo.createBrand({ name, slug, aliases, placements });
    await this.recompute();
    return this.view(brand.id);
  }

  async updateBrand(id: number, input: BrandInput): Promise<AdminBrandView> {
    const current = (await this.repo.listBrands()).find((b) => b.id === id);
    if (!current) throw new AdminError('Бренд не найден', 404);
    const patch: BrandPatch = {};
    if (input.name !== undefined) patch.name = str(input.name, 'name', 120);
    if (input.slug !== undefined) {
      patch.slug = str(input.slug, 'slug', 80);
      if (!SLUG_RE.test(patch.slug)) throw new AdminError('Адрес бренда: латиница, цифры и дефис');
    }
    if (input.aliases !== undefined) patch.aliases = parseAliases(input.aliases);
    if (input.placements !== undefined) {
      patch.placements = mergePlacements(current.placements, input.placements);
    }
    await this.repo.updateBrand(id, patch);
    if (patch.name !== undefined || patch.aliases !== undefined) await this.recompute();
    return this.view(id);
  }

  async publicBrands(gender: Gender): Promise<PublicBrandList> {
    const brands = (await this.repo.listBrands()).filter((b) => b.placements[gender].in);
    const top = brands
      .filter((b) => b.placements[gender].top)
      .sort(
        (a, b) =>
          a.placements[gender].sort - b.placements[gender].sort || a.name.localeCompare(b.name),
      )
      .map((b) => ({ name: b.name, slug: b.slug, photo: b.photo, logo: b.logo }));
    const all = brands
      .map((b) => ({ name: b.name, slug: b.slug }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    return { gender, top, all };
  }

  /** Модели, у которых нет бренда: список для вкладки «Без бренда». */
  async unmatched(
    query: string,
    limit: number,
    offset: number,
  ): Promise<Page<CatalogModel> & { candidates: Candidate[] }> {
    const [models, assigned] = await Promise.all([
      this.catalog.listModels(),
      this.repo.listAssignments(),
    ]);
    const taken = new Set(assigned.map((a) => a.modelId));
    const free = models.filter((m) => !taken.has(m.id));
    const q = normalizeText(query);
    const filtered = q ? free.filter((m) => normalizeText(m.name).includes(q)) : free;
    return {
      total: filtered.length,
      items: filtered.slice(offset, offset + limit),
      candidates: candidateWords(free.map((m) => m.name)),
    };
  }

  async assignModel(modelId: string, brandId: number | null): Promise<void> {
    if (!modelId || modelId.length > 200) throw new AdminError('Некорректная модель');
    await this.repo.setManual(modelId, brandId);
    // После снятия ручной привязки модель может найтись по алиасам.
    if (brandId === null) await this.recompute();
  }

  /** Бренд по адресу для публичного API; null — такого нет. */
  async brandBySlug(slug: string): Promise<{ name: string; slug: string } | null> {
    const brand = (await this.repo.listBrands()).find((b) => b.slug === slug);
    return brand ? { name: brand.name, slug: brand.slug } : null;
  }

  async stats(): Promise<Stats> {
    const [models, brands, assigned] = await Promise.all([
      this.catalog.listModels(),
      this.repo.listBrands(),
      this.repo.listAssignments(),
    ]);
    const taken = new Set(assigned.map((a) => a.modelId));
    const assignedModels = models.filter((m) => taken.has(m.id)).length;
    return {
      models: models.length,
      withoutPhoto: models.filter((m) => !m.photo).length,
      brands: brands.length,
      assigned: assignedModels,
      unmatched: models.length - assignedModels,
    };
  }
}
