import { describe, expect, it } from 'vitest';
import { categoryOf, kindOf } from '../src/admin/category.js';

describe('раздел и вид изделия по названию', () => {
  it('вид — первое слово названия', () => {
    expect(kindOf('Джемпер Diesel красный, 46')).toBe('Джемпер');
    expect(kindOf('  ТУФЛИ Balmain')).toBe('Туфли');
    expect(kindOf('Джинсы-бойфренды Diesel')).toBe('Джинсы-бойфренды');
    expect(kindOf('')).toBe('');
    expect(kindOf('«» 42')).toBe('');
  });

  it('разделы', () => {
    const cases: [string, string][] = [
      ['Джемпер Diesel красный, 46', 'Одежда'],
      ['Платье Dorothee Schumacher, 42', 'Одежда'],
      ['Куртка без бренда, 50', 'Одежда'],
      ['Туфли Balmain', 'Обувь'],
      ['Ботинки Chelsea Diesel', 'Обувь'],
      ['Кроссовки S-Serendipity', 'Обувь'],
      ['Сумка Bogner', 'Сумки'],
      ['Рюкзак Diesel', 'Сумки'],
      ['Ремень Diesel', 'Аксессуары'],
      ['Шарф Seventy', 'Аксессуары'],
      ['Кошелёк Bogner', 'Аксессуары'],
      ['Нечто странное', 'Одежда'],
      ['', 'Одежда'],
    ];
    for (const [name, cat] of cases) expect(categoryOf(name), name).toBe(cat);
  });

  it('основа слова сверяется с началом слова, а не с серединой', () => {
    expect(categoryOf('Сумасшедшее платье')).toBe('Одежда'); // «сум…» ≠ «сумк»
    expect(categoryOf('Кедровый свитер')).toBe('Одежда');
    expect(categoryOf('Кеды Diesel')).toBe('Обувь');
  });
});
