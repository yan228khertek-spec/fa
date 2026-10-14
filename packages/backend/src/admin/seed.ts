import { normalizeText } from './matcher.js';
import { slugify } from './slug.js';
import { GENDERS, type Gender, type Placements } from './types.js';
import type { BrandService } from './service.js';

/** Бренды по разделам сайта — как согласовано для страницы «Бренды». */
export const SEED_BRANDS: Record<Gender, string[]> = {
  men: [
    'Aeronautica Militare',
    'BLCV',
    'Bogner',
    'Bosideng',
    'Daniele Fiesoli',
    'Diesel',
    'Digel',
    "Doucal's",
    'Emporio Armani',
    'ICE Play',
    'JNBY',
    'Karl Lagerfeld',
    'Limitato',
    'Odri',
    'Seventy',
    'TRANSIT',
    'Hannes Roether',
  ],
  women: [
    'Aeronautica Militare',
    'Alma en Pena',
    'Alysi',
    'Annette Görtz',
    'Beatrice.b',
    'Biancalancia',
    'BLCV',
    'Bogner',
    'By Malene Birger',
    'Canadian',
    'Charmline',
    'D.Exterior',
    'Diego M',
    'Diesel',
    'Dorothee Schumacher',
    "Doucal's",
    'Elena Iachi',
    'Eleventy',
    'Emporio Armani',
    'ICE Play',
    'JNBY',
    'Karl Lagerfeld',
    'Le Coeur TWINSET',
    'Lidea',
    'Limitato',
    'Liu Jo',
    'Luisa Cerano',
    'Marina Rinaldi',
    'Maryan Mehlhorn',
    'Max Mara Leisure',
    'MAX&MOI',
    'Miss Sixty',
    'MSGM',
    'Nissa',
    'One Teaspoon',
    'OSKA',
    'Persona by Marina Rinaldi',
    'Pinko',
    'Plinio Visona',
    'Secrets',
    'Seventy',
    'Sfizio',
    'Stefanel',
    'TRANSIT',
    'Uvelina',
    'Watercult',
  ],
};

/** «Топ бренды»: порядок = порядок плиток. */
export const SEED_TOP: Record<Gender, string[]> = {
  men: ['Aeronautica Militare', 'Hannes Roether', 'Diesel', 'TRANSIT', 'Bogner'],
  women: ['Dorothee Schumacher', 'Miss Sixty', 'Annette Görtz', 'D.Exterior', 'Seventy'],
};

/**
 * Другие написания, которые вероятны в названиях товаров 1С. Это догадки до первой
 * реальной выгрузки — оператор правит их в админке.
 */
export const SEED_ALIASES: Record<string, string[]> = {
  'Dorothee Schumacher': ['Schumacher', 'Shumacher'],
  'Annette Görtz': ['Goertz'],
  "Doucal's": ['Doucals'],
  'ICE Play': ['Iceplay'],
  'Liu Jo': ['Liujo'],
  'Le Coeur TWINSET': ['Twinset'],
  'Aeronautica Militare': ['Aeronutica Militare'],
};

export interface SeedResult {
  created: string[];
  skipped: string[];
}

/**
 * Первичное заполнение словаря брендов. Идемпотентно: бренд, адрес которого уже
 * занят, пропускается и не меняется — ручные правки оператора не затираются.
 */
export async function seedBrands(service: BrandService): Promise<SeedResult> {
  const existing = new Set((await service.listBrands()).map((b) => b.slug));
  const names = new Map<string, string>();
  for (const g of GENDERS) for (const n of SEED_BRANDS[g]) names.set(normalizeText(n), n);

  const result: SeedResult = { created: [], skipped: [] };
  for (const name of names.values()) {
    const slug = slugify(name);
    if (existing.has(slug)) {
      result.skipped.push(name);
      continue;
    }
    const placements = Object.fromEntries(
      GENDERS.map((g) => {
        const inGender = SEED_BRANDS[g].includes(name);
        const topIndex = SEED_TOP[g].indexOf(name);
        return [g, { in: inGender, top: topIndex >= 0, sort: Math.max(topIndex, 0) }];
      }),
    ) as Placements;
    await service.createBrand({ name, slug, aliases: SEED_ALIASES[name] ?? [], placements });
    result.created.push(name);
  }
  return result;
}
