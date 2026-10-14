import { describe, expect, it } from 'vitest';
import { candidateWords, matchBrand, normalizeText } from '../src/admin/matcher.js';
import { slugify } from '../src/admin/slug.js';

describe('normalizeText', () => {
  it('убирает регистр, диакритику и знаки', () => {
    expect(normalizeText('Annette Görtz')).toBe('annette gortz');
    expect(normalizeText('MAX&MOI')).toBe('max moi');
    expect(normalizeText('D.Exterior')).toBe('d exterior');
    expect(normalizeText('  Ёлка—Палка ')).toBe('елка палка');
  });
});

describe('matchBrand', () => {
  const brands = [
    { id: 1, keys: ['diesel'] },
    { id: 2, keys: ['marina rinaldi'] },
    { id: 3, keys: ['persona by marina rinaldi', 'persona'] },
    { id: 4, keys: ['seventy', 'sev'] },
  ];

  it('находит бренд как целое слово в любом месте названия', () => {
    expect(matchBrand('Джемпер DIESEL красный', brands)).toBe(1);
    expect(matchBrand('Diesel', brands)).toBe(1);
    expect(matchBrand('Джемпер Dieselov', brands)).toBeNull();
  });

  it('побеждает самое длинное совпадение', () => {
    expect(matchBrand('Платье Persona by Marina Rinaldi 48', brands)).toBe(3);
    expect(matchBrand('Платье Marina Rinaldi 48', brands)).toBe(2);
  });

  it('при равных совпадениях у разных брендов — без бренда', () => {
    const tie = [
      { id: 1, keys: ['alpha beta'] },
      { id: 2, keys: ['alpha beta'] },
    ];
    expect(matchBrand('Куртка Alpha Beta', tie)).toBeNull();
  });

  it('игнорирует слишком короткие ключи', () => {
    expect(matchBrand('Куртка A', [{ id: 1, keys: ['a'] }])).toBeNull();
  });
});

describe('candidateWords', () => {
  it('считает первые слова и пары, отбрасывает редкие и цифры', () => {
    const names = [
      'Diesel Джемпер красный',
      'Diesel Джемпер синий',
      'Diesel Брюки',
      'Редкий товар',
      '123 456',
    ];
    const res = candidateWords(names);
    expect(res[0]).toEqual({ word: 'diesel', count: 3 });
    expect(res).toContainEqual({ word: 'diesel джемпер', count: 2 });
    expect(res.some((c) => c.word === 'редкий')).toBe(false);
  });
});

describe('slugify', () => {
  it('делает адреса из названий', () => {
    expect(slugify('Annette Görtz')).toBe('annette-gortz');
    expect(slugify('MAX&MOI')).toBe('max-and-moi');
    expect(slugify("Doucal's")).toBe('doucal-s');
    expect(slugify('Смит')).toBe('smit');
  });
});
