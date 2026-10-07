import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import iconv from 'iconv-lite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectXmlEncoding } from '../src/catalog/encoding.js';
import { buildImportXml, generateLargeCatalog, writeImportXml } from '../src/catalog/fixtures.js';
import { ImportParseError, parseImportXmlStream } from '../src/catalog/import-parser.js';
import { findImportFile, importCatalogFile } from '../src/catalog/import-runner.js';
import { MemoryCatalogRepository } from '../src/catalog/memory.js';
import type { ImportSpec } from '../src/catalog/fixtures.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'fa-catalog-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Пишет фикстуру на диск и грузит её в каталог в памяти. */
async function load(
  spec: ImportSpec,
  repo = new MemoryCatalogRepository(),
  opts: { name?: string; encoding?: string; batchSize?: number } = {},
) {
  const file = path.join(dir, opts.name ?? 'import.xml');
  await writeImportXml(file, buildImportXml(spec), opts.encoding ?? 'win1251');
  const summary = await importCatalogFile(repo, file, path.basename(file), {
    batchSize: opts.batchSize ?? 500,
  });
  return { repo, summary, file };
}

const SIZE_COLOR: ImportSpec['properties'] = [
  { id: 'prop-size', name: 'Размер', options: [{ id: 's-44', value: '44' }] },
  { id: 'prop-color', name: 'Цвет', options: [{ id: 'c-red', value: 'Красный' }] },
];

describe('detectXmlEncoding', () => {
  it('объявление windows-1251 → win1251', () => {
    const head = Buffer.from('<?xml version="1.0" encoding="windows-1251"?><a/>', 'latin1');
    expect(detectXmlEncoding(head)).toBe('win1251');
  });

  it('объявление UTF-8 и BOM → utf8', () => {
    expect(detectXmlEncoding(Buffer.from('<?xml version="1.0" encoding="UTF-8"?>'))).toBe('utf8');
    expect(
      detectXmlEncoding(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<a/>')])),
    ).toBe('utf8');
  });

  it('без объявления → utf8 (по спецификации XML)', () => {
    expect(detectXmlEncoding(Buffer.from('<КоммерческаяИнформация/>'))).toBe('utf8');
  });

  it('неизвестное имя кодировки не ломает разбор', () => {
    expect(detectXmlEncoding(Buffer.from('<?xml version="1.0" encoding="zzz-9"?>'))).toBe('utf8');
  });
});

describe('классификатор', () => {
  it('группы с вложенностью: родитель, уровень, порядок', async () => {
    const { repo } = await load({
      groups: [
        {
          id: 'g1',
          name: 'Женская одежда',
          children: [
            { id: 'g1-1', name: 'Платья' },
            { id: 'g1-2', name: 'Трикотаж', children: [{ id: 'g1-2-1', name: 'Джемперы' }] },
          ],
        },
        { id: 'g2', name: 'Мужская одежда' },
      ],
    });

    expect(repo.categories.size).toBe(5);
    expect(repo.categories.get('g1')).toMatchObject({
      parentSourceId: null,
      level: 0,
      sortOrder: 0,
    });
    expect(repo.categories.get('g2')).toMatchObject({
      parentSourceId: null,
      level: 0,
      sortOrder: 1,
    });
    expect(repo.categories.get('g1-1')).toMatchObject({
      parentSourceId: 'g1',
      level: 1,
      sortOrder: 0,
      name: 'Платья',
    });
    expect(repo.categories.get('g1-2')).toMatchObject({
      parentSourceId: 'g1',
      level: 1,
      sortOrder: 1,
    });
    expect(repo.categories.get('g1-2-1')).toMatchObject({ parentSourceId: 'g1-2', level: 2 });
  });

  it('свойства с вариантами значений', async () => {
    const { repo } = await load({ properties: SIZE_COLOR });
    expect(repo.properties.size).toBe(2);
    expect(repo.properties.get('prop-size')).toMatchObject({
      name: 'Размер',
      valueType: 'Справочник',
      options: [{ sourceId: 's-44', value: '44' }],
    });
  });
});

describe('товары', () => {
  it('товар без характеристик: реквизиты, группы, бренд, картинки, свойства', async () => {
    const { repo, summary } = await load({
      groups: [{ id: 'g1', name: 'Платья' }],
      properties: SIZE_COLOR,
      products: [
        {
          id: 'p1',
          article: 'ART-1',
          name: 'Платье',
          fullName: 'Платье длинное',
          description: 'Хлопок',
          groups: ['g1'],
          brand: { id: 'b1', name: 'Gerry Weber' },
          images: ['import_files/p1.jpg', 'import_files/p1-2.jpg'],
          props: [{ id: 'prop-color', values: ['c-red'] }],
        },
      ],
    });

    expect(summary.products).toBe(1);
    expect(summary.variants).toBe(0);
    expect(summary.images).toBe(2);
    expect(repo.products.get('p1')).toMatchObject({
      article: 'ART-1',
      name: 'Платье',
      fullName: 'Платье длинное',
      description: 'Хлопок',
      brandSourceId: 'b1',
      categorySourceIds: ['g1'],
      baseUnit: 'Штука',
      isDeleted: false,
      properties: [{ propertySourceId: 'prop-color', value: 'c-red' }],
    });
    expect(repo.products.get('p1')?.images).toEqual([
      { path: 'import_files/p1.jpg', sortOrder: 0 },
      { path: 'import_files/p1-2.jpg', sortOrder: 1 },
    ]);
    expect(repo.brands.get('b1')).toMatchObject({ name: 'Gerry Weber' });
    expect(repo.variants.size).toBe(0);
  });

  it('товар с характеристиками: SKU по Ид#ИдХарактеристики, размер и цвет', async () => {
    const { repo } = await load({
      products: [
        { id: 'p1', name: 'Платье' },
        {
          id: 'p1#ch1',
          name: 'Платье (44, Красный)',
          article: 'ART-1-44',
          chars: [
            { name: 'Размер', value: '44' },
            { name: 'Цвет', value: 'Красный' },
          ],
        },
      ],
    });

    expect(repo.products.size).toBe(1);
    expect(repo.variants.size).toBe(1);
    expect(repo.variants.get('p1#ch1')).toMatchObject({
      productSourceId: 'p1',
      charSourceId: 'ch1',
      article: 'ART-1-44',
      size: '44',
      color: 'Красный',
      characteristics: { Размер: '44', Цвет: 'Красный' },
    });
  });

  it('размер/цвет у характеристики, пришедшие как ЗначенияСвойств, разворачиваются по справочнику', async () => {
    const { repo } = await load({
      properties: SIZE_COLOR,
      products: [
        { id: 'p1', name: 'Платье' },
        {
          id: 'p1#ch1',
          name: 'Платье 44',
          props: [
            { id: 'prop-size', values: ['s-44'] },
            { id: 'prop-color', values: ['c-red'] },
          ],
        },
      ],
    });

    expect(repo.variants.get('p1#ch1')).toMatchObject({ size: '44', color: 'Красный' });
  });

  it('ПометкаУдаления переносится в is_deleted, а не удаляет строку', async () => {
    const { repo } = await load({
      products: [{ id: 'p1', name: 'Платье', deleted: true }],
    });
    expect(repo.products.get('p1')?.isDeleted).toBe(true);
  });
});

describe('идемпотентность', () => {
  const spec: ImportSpec = {
    groups: [{ id: 'g1', name: 'Платья', children: [{ id: 'g1-1', name: 'Миди' }] }],
    properties: SIZE_COLOR,
    products: [
      {
        id: 'p1',
        name: 'Платье',
        groups: ['g1-1'],
        brand: { id: 'b1', name: 'Gerry Weber' },
        images: ['import_files/p1.jpg'],
        props: [{ id: 'prop-color', values: ['c-red'] }],
      },
      { id: 'p1#ch1', name: 'Платье 44', chars: [{ name: 'Размер', value: '44' }] },
    ],
  };

  it('повторная загрузка того же файла не меняет счётчики строк', async () => {
    const repo = new MemoryCatalogRepository();
    await load(spec, repo);
    const first = repo.rowCounts();
    await load(spec, repo);
    expect(repo.rowCounts()).toEqual(first);
    expect(repo.runs).toHaveLength(2);
    expect(repo.runs.every((r) => r.status === 'success')).toBe(true);
  });

  it('изменённый товар обновляется, дубль не появляется', async () => {
    const repo = new MemoryCatalogRepository();
    await load(spec, repo);
    const updated: ImportSpec = {
      ...spec,
      onlyChanges: true,
      products: [
        {
          id: 'p1',
          name: 'Платье миди',
          groups: ['g1-1'],
          brand: { id: 'b1', name: 'Gerry Weber' },
        },
      ],
    };
    const { summary } = await load(updated, repo);

    expect(summary.meta.onlyChanges).toBe(true);
    expect(repo.products.size).toBe(1);
    expect(repo.products.get('p1')?.name).toBe('Платье миди');
    // инкремент не трогает не пришедшие записи
    expect(repo.variants.size).toBe(1);
    expect(repo.categories.size).toBe(2);
  });
});

describe('ошибки и кодировки', () => {
  it('битый XML → ImportParseError, прогон помечен failure', async () => {
    const repo = new MemoryCatalogRepository();
    const file = path.join(dir, 'broken.xml');
    const xml = buildImportXml({ products: [{ id: 'p1', name: 'Платье' }] });
    await writeFile(file, iconv.encode(xml.slice(0, xml.length - 120), 'win1251'));

    await expect(importCatalogFile(repo, file, 'import.xml')).rejects.toThrow(ImportParseError);
    expect(repo.runs.at(-1)).toMatchObject({ status: 'failure' });
  });

  it('совсем не XML → ImportParseError', async () => {
    const repo = new MemoryCatalogRepository();
    const file = path.join(dir, 'junk.xml');
    await writeFile(file, Buffer.from('<<< не xml >>>'));
    await expect(importCatalogFile(repo, file, 'import.xml')).rejects.toThrow(ImportParseError);
  });

  it('тот же каталог в UTF-8 даёт тот же результат, что в windows-1251', async () => {
    const spec: ImportSpec = {
      groups: [{ id: 'g1', name: 'Платья' }],
      products: [{ id: 'p1', name: 'Платье «Весна»', groups: ['g1'] }],
    };
    const win = await load(spec, new MemoryCatalogRepository(), { name: 'w.xml' });
    const utf = await load(spec, new MemoryCatalogRepository(), {
      name: 'u.xml',
      encoding: 'utf8',
    });

    expect(win.summary.encoding).toBe('win1251');
    expect(utf.repo.products.get('p1')?.name).toBe('Платье «Весна»');
    expect(utf.repo.rowCounts()).toEqual(win.repo.rowCounts());
  });

  it('поток читается чанками: мелкий batchSize не теряет сущности', async () => {
    const spec = generateLargeCatalog(20, 2);
    const repo = new MemoryCatalogRepository();
    await load(spec, repo, { batchSize: 1 });
    expect(repo.products.size).toBe(20);
    expect(repo.variants.size).toBe(40);
  });

  it('разбор произвольного текстового потока (без файла)', async () => {
    const xml = buildImportXml({ products: [{ id: 'p1', name: 'Платье' }] });
    const seen: string[] = [];
    const res = await parseImportXmlStream(Readable.from([xml]), {
      onProducts: async (items) => {
        seen.push(...items.map((i) => i.sourceId));
      },
    });
    expect(seen).toEqual(['p1']);
    expect(res.counters.products).toBe(1);
  });
});

describe('DoD этапа 2', () => {
  it('1500 позиций грузятся менее 60 секунд, повторная загрузка не плодит строк', async () => {
    const spec = generateLargeCatalog(300, 4);
    expect(spec.products).toHaveLength(1500);

    const repo = new MemoryCatalogRepository();
    const first = await load(spec, repo, { name: 'big.xml' });
    expect(first.summary.durationMs).toBeLessThan(60_000);
    expect(first.summary.products).toBe(300);
    expect(first.summary.variants).toBe(1200);
    expect(first.summary.categories).toBe(6);
    expect(first.summary.brands).toBe(3);

    const counts = repo.rowCounts();
    await load(spec, repo, { name: 'big.xml' });
    expect(repo.rowCounts()).toEqual(counts);
  }, 90_000);
});

describe('findImportFile', () => {
  it('unpacked приоритетнее inbox, выход за пределы spool отсекается', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'inbox'), { recursive: true });
    await mkdir(path.join(dir, 'unpacked'), { recursive: true });
    await writeFile(path.join(dir, 'inbox', 'import.xml'), 'inbox');
    expect(await findImportFile(dir, 'import.xml')).toBe(path.join(dir, 'inbox', 'import.xml'));

    await writeFile(path.join(dir, 'unpacked', 'import.xml'), 'unpacked');
    expect(await findImportFile(dir, 'import.xml')).toBe(path.join(dir, 'unpacked', 'import.xml'));

    expect(await findImportFile(dir, '../../etc/passwd')).toBeNull();
    expect(await findImportFile(dir, 'nope.xml')).toBeNull();
  });
});

describe('исправления по ревью этапа 2', () => {
  it('выгрузка в windows-1251 без encoding в объявлении — громкий отказ, не «успех нуля»', async () => {
    const repo = new MemoryCatalogRepository();
    const file = path.join(dir, 'no-decl.xml');
    const xml = buildImportXml({
      groups: [{ id: 'g1', name: 'Платья' }],
      products: [{ id: 'p1', name: 'Платье' }],
    }).replace(/<\?xml[^>]*\?>/, '<?xml version="1.0"?>');
    await writeFile(file, iconv.encode(xml, 'win1251'));

    await expect(importCatalogFile(repo, file, 'import.xml')).rejects.toThrow(/кодировк/i);
    expect(repo.products.size).toBe(0);
    expect(repo.runs.at(-1)?.status).toBe('failure');
  });

  it('обрыв на середине: прогон failure, но счётчики показывают, сколько записано', async () => {
    const repo = new MemoryCatalogRepository();
    const file = path.join(dir, 'cut.xml');
    const xml = buildImportXml(generateLargeCatalog(200, 2));
    await writeFile(file, iconv.encode(xml.slice(0, Math.floor(xml.length * 0.6)), 'win1251'));

    await expect(importCatalogFile(repo, file, 'import.xml', { batchSize: 50 })).rejects.toThrow(
      ImportParseError,
    );
    const run = repo.runs.at(-1);
    expect(run?.status).toBe('failure');
    expect(run?.counters?.products).toBeGreaterThan(0);
    expect(run?.counters?.products).toBeLessThan(200);
    expect(repo.products.size).toBe(run?.counters?.products);
  });

  it('СодержитТолькоИзменения доезжает в журнал, даже если классификатор дал батч раньше', async () => {
    const repo = new MemoryCatalogRepository();
    const groups = Array.from({ length: 400 }, (_, i) => ({ id: `g${i}`, name: `Группа ${i}` }));
    await load({ onlyChanges: true, groups, products: [{ id: 'p1', name: 'Платье' }] }, repo, {
      batchSize: 50,
    });

    expect(repo.runs.at(-1)?.meta.onlyChanges).toBe(true);
  });

  it('вторая часть выгрузки без классификатора берёт справочник из хранилища', async () => {
    const repo = new MemoryCatalogRepository();
    await load({ properties: SIZE_COLOR, products: [{ id: 'p1', name: 'Платье' }] }, repo);

    // import0_1.xml: только характеристика, Классификатора в файле нет
    await load(
      {
        products: [
          {
            id: 'p1#ch1',
            name: 'Платье 44',
            props: [
              { id: 'prop-size', values: ['s-44'] },
              { id: 'prop-color', values: ['c-red'] },
            ],
          },
        ],
      },
      repo,
      { name: 'import0_1.xml' },
    );

    expect(repo.variants.get('p1#ch1')).toMatchObject({ size: '44', color: 'Красный' });
  });

  it('ошибка хранилища не маскируется под ошибку разбора', async () => {
    const repo = new MemoryCatalogRepository();
    const boom = new Error('БД недоступна');
    repo.upsertProducts = async () => {
      throw boom;
    };
    const file = path.join(dir, 'ok.xml');
    await writeImportXml(file, buildImportXml({ products: [{ id: 'p1', name: 'Платье' }] }));

    await expect(importCatalogFile(repo, file, 'import.xml')).rejects.toBe(boom);
    expect(repo.runs.at(-1)?.status).toBe('failure');
  });

  it('findImportFile не выпускает за пределы своего подкаталога', async () => {
    const { mkdir, writeFile: write } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'unpacked'), { recursive: true });
    await mkdir(path.join(dir, 'inbox'), { recursive: true });
    await write(path.join(dir, 'secret.xml'), 'нельзя');

    expect(await findImportFile(dir, '../secret.xml')).toBeNull();
    expect(await findImportFile(dir, '..')).toBeNull();
  });
});
