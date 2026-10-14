/**
 * Нормализация для сопоставления: нижний регистр, ё→е, без диакритики,
 * всё кроме букв и цифр — пробел. «Annette Görtz» → «annette gortz»,
 * «MAX&MOI» → «max moi», «D.Exterior» → «d exterior».
 */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface BrandKeys {
  id: number;
  /** Нормализованные название и алиасы. */
  keys: string[];
}

/**
 * Бренд модели по её названию: ищем написания бренда как целые слова.
 * Побеждает самое длинное совпадение («persona by marina rinaldi» против «marina rinaldi»);
 * если одинаково длинные совпадения у разных брендов — модель остаётся без бренда
 * (пусть решит оператор).
 */
export function matchBrand(modelName: string, brands: BrandKeys[]): number | null {
  const text = ` ${normalizeText(modelName)} `;
  let bestLen = 0;
  let bestId: number | null = null;
  let tie = false;
  for (const brand of brands) {
    for (const key of brand.keys) {
      if (key.length < 2 || !text.includes(` ${key} `)) continue;
      if (key.length > bestLen) {
        bestLen = key.length;
        bestId = brand.id;
        tie = false;
      } else if (key.length === bestLen && brand.id !== bestId) {
        tie = true;
      }
    }
  }
  return tie ? null : bestId;
}

export interface Candidate {
  word: string;
  count: number;
}

/**
 * Подсказки для «Без бренда»: самые частые первые слова и пары слов в названиях.
 * Бренд в 1С обычно стоит в начале названия, так оператор видит, что заводить.
 */
export function candidateWords(names: string[], limit = 30): Candidate[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    const tokens = normalizeText(name)
      .split(' ')
      .filter((t) => t.length >= 2 && !/^\d+$/.test(t));
    const first = tokens[0];
    if (!first) continue;
    counts.set(first, (counts.get(first) ?? 0) + 1);
    const second = tokens[1];
    if (second) {
      const pair = `${first} ${second}`;
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}
