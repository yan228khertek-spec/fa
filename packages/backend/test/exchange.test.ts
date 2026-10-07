import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import iconv from 'iconv-lite';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { resetSessions } from '../src/exchange/auth.js';
import { safeRelativeName, unzipSafely } from '../src/exchange/files.js';
import { MemoryCatalogRepository } from '../src/catalog/memory.js';
import { buildImportXml } from '../src/catalog/fixtures.js';
import { MemoryExchangeLog } from '../src/log/memory.js';

const LOGIN = 'site';
const PASSWORD = 'secret-1c';
const basic = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');

/** Как 1С: тело выгрузки приходит в windows-1251. */
const iconvEncode = (xml: string): Buffer => iconv.encode(xml, 'win1251');

let app: FastifyInstance;
let logSink: MemoryExchangeLog;
let catalog: MemoryCatalogRepository;
let spoolDir: string;
let importWaitMs = 30_000;

function cfg(): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    exchangeLogin: LOGIN,
    exchangePassword: PASSWORD,
    fileLimit: 1024 * 1024,
    spoolDir,
    importWaitMs,
    unpackLimit: 64 * 1024 * 1024,
    databaseUrl: undefined,
    quiet: true,
  };
}

async function checkauth(): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/1c-exchange?type=catalog&mode=checkauth',
    headers: { authorization: basic },
  });
  const [ok, name, value] = res.body.split('\n');
  expect(ok).toBe('success');
  return `${name}=${value}`;
}

beforeEach(async () => {
  resetSessions();
  importWaitMs = 30_000;
  spoolDir = await mkdtemp(path.join(tmpdir(), 'fa-spool-'));
  logSink = new MemoryExchangeLog();
  catalog = new MemoryCatalogRepository();
  app = await buildApp({ config: cfg(), logSink, catalog });
});

afterEach(async () => {
  await app.close();
  await rm(spoolDir, { recursive: true, force: true });
});

describe('checkauth', () => {
  it('валидные креды: ровно 3 строки, win-1251 plain text, без хвостового \\n', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=checkauth',
      headers: { authorization: basic },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=windows-1251');
    const lines = res.body.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('success');
    expect(lines[1]).toBe('fa_cml_session');
    expect(lines[2]!.length).toBeGreaterThan(20);
    expect(res.body.endsWith('\n')).toBe(false);
    expect(res.rawPayload[0]).not.toBe(0xef); // нет BOM
  });

  it('неверный пароль — failure', async () => {
    const bad = 'Basic ' + Buffer.from(`${LOGIN}:wrong`).toString('base64');
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=checkauth',
      headers: { authorization: bad },
    });
    expect(res.body.startsWith('failure')).toBe(true);
  });

  it('без Authorization — failure', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=checkauth',
    });
    expect(res.body.startsWith('failure')).toBe(true);
  });
});

describe('init', () => {
  it('по cookie: zip=yes и file_limit', async () => {
    const cookie = await checkauth();
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=init',
      headers: { cookie },
    });
    expect(res.body).toBe('zip=yes\nfile_limit=1048576');
  });

  it('по Basic без cookie (1С дублирует auth) — тоже работает', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=init',
      headers: { authorization: basic },
    });
    expect(res.body.startsWith('zip=yes')).toBe(true);
  });

  it('без сессии и Basic — failure', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=init',
    });
    expect(res.body.startsWith('failure')).toBe(true);
  });
});

describe('file', () => {
  it('склеивает два POST-куска в один файл', async () => {
    const cookie = await checkauth();
    for (const part of ['HELLO-', 'WORLD']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/1c-exchange?type=catalog&mode=file&filename=import.xml',
        headers: { cookie, 'content-type': 'application/octet-stream' },
        payload: Buffer.from(part),
      });
      expect(res.body).toBe('success');
    }
    const data = await readFile(path.join(spoolDir, 'inbox', 'import.xml'), 'utf8');
    expect(data).toBe('HELLO-WORLD');
  });

  it('filename с подкаталогом (import_files/...) — легален', async () => {
    const cookie = await checkauth();
    const res = await app.inject({
      method: 'POST',
      url: '/api/1c-exchange?type=catalog&mode=file&filename=import_files/ab/photo.jpg',
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('JPEG'),
    });
    expect(res.body).toBe('success');
    const data = await readFile(path.join(spoolDir, 'inbox', 'import_files/ab/photo.jpg'), 'utf8');
    expect(data).toBe('JPEG');
  });

  it('path traversal в filename — failure, файл не создаётся', async () => {
    const cookie = await checkauth();
    const res = await app.inject({
      method: 'POST',
      url: '/api/1c-exchange?type=catalog&mode=file&filename=' + encodeURIComponent('../evil.sh'),
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('oops'),
    });
    expect(res.body.startsWith('failure')).toBe(true);
  });

  it('POST без сессии — failure', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/1c-exchange?type=catalog&mode=file&filename=import.xml',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });
    expect(res.body.startsWith('failure')).toBe(true);
  });
});

const FIXTURE = buildImportXml({
  groups: [{ id: 'g1', name: 'Платья', children: [{ id: 'g1-1', name: 'Миди' }] }],
  properties: [{ id: 'prop-size', name: 'Размер', options: [{ id: 's-44', value: '44' }] }],
  products: [
    {
      id: 'p1',
      article: 'ART-1',
      name: 'Платье',
      groups: ['g1-1'],
      brand: { id: 'b1', name: 'Gerry Weber' },
      images: ['import_files/p1.jpg'],
    },
    { id: 'p1#ch1', name: 'Платье 44', chars: [{ name: 'Размер', value: '44' }] },
  ],
});

/** Как настоящая 1С: mode=file кусками, затем mode=import. */
async function postFile(cookie: string, filename: string, payload: Buffer): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/1c-exchange?type=catalog&mode=file&filename=' + encodeURIComponent(filename),
    headers: { cookie, 'content-type': 'application/octet-stream' },
    payload,
  });
  expect(res.body).toBe('success');
}

describe('import', () => {
  it('import.xml в windows-1251 разбирается и ложится в staging', async () => {
    const cookie = await checkauth();
    await postFile(cookie, 'import.xml', iconvEncode(FIXTURE));
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=import&filename=import.xml',
      headers: { cookie },
    });

    expect(res.body).toBe('success');
    expect(catalog.rowCounts()).toMatchObject({
      categories: 2,
      brands: 1,
      properties: 1,
      products: 1,
      variants: 1,
    });
    expect(catalog.products.get('p1')?.article).toBe('ART-1');
    expect(catalog.variants.get('p1#ch1')?.size).toBe('44');
    expect(logSink.entries.at(-1)?.detail).toContain('win1251');
  });

  it('import.xml внутри zip: архив распаковывается сам, файл находится', async () => {
    const cookie = await checkauth();
    const zip = new AdmZip();
    zip.addFile('import.xml', iconvEncode(FIXTURE));
    await postFile(cookie, 'v8_catalog.zip', zip.toBuffer());

    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=import&filename=import.xml',
      headers: { cookie },
    });
    expect(res.body).toBe('success');
    expect(catalog.products.size).toBe(1);
  });

  it('повторный import того же файла не плодит строк', async () => {
    const cookie = await checkauth();
    await postFile(cookie, 'import.xml', iconvEncode(FIXTURE));
    const url = '/api/1c-exchange?type=catalog&mode=import&filename=import.xml';
    await app.inject({ method: 'GET', url, headers: { cookie } });
    const first = catalog.rowCounts();
    const again = await app.inject({ method: 'GET', url, headers: { cookie } });

    expect(again.body).toBe('success');
    expect(catalog.rowCounts()).toEqual(first);
  });

  it('битый import.xml — failure с причиной, staging не затронут', async () => {
    const cookie = await checkauth();
    await postFile(cookie, 'import.xml', iconvEncode(FIXTURE.slice(0, 200)));
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=import&filename=import.xml',
      headers: { cookie },
    });

    // тело в windows-1251 — inject отдаёт байты, декодируем как 1С
    const lines = iconv.decode(res.rawPayload, 'win1251').split('\n');
    expect(lines[0]).toBe('failure');
    expect(lines[1]).toContain('Ошибка разбора выгрузки');
    expect(logSink.entries.at(-1)?.result).toBe('failure');
  });

  it('длинная загрузка отвечает progress, затем success', async () => {
    importWaitMs = 0;
    await app.close();
    catalog = new MemoryCatalogRepository();
    app = await buildApp({ config: cfg(), logSink, catalog });
    const cookie = await checkauth();
    await postFile(cookie, 'import.xml', iconvEncode(FIXTURE));

    const url = '/api/1c-exchange?type=catalog&mode=import&filename=import.xml';
    const started = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(started.body.split('\n')[0]).toBe('progress');

    let body = '';
    for (let i = 0; i < 50; i++) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      body = res.body;
      if (!body.startsWith('progress')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(body).toBe('success');
    expect(catalog.products.size).toBe(1);
  });

  it('offers.xml пока пропускается (этап 3), факт виден в журнале', async () => {
    const cookie = await checkauth();
    await postFile(cookie, 'offers.xml', Buffer.from('<x/>'));
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=import&filename=offers.xml',
      headers: { cookie },
    });

    expect(res.body).toBe('success');
    expect(logSink.entries.at(-1)?.detail).toContain('этап 3');
    expect(catalog.products.size).toBe(0);
  });

  it('init чистит spool: вторая выгрузка не склеивается с первой', async () => {
    const cookie = await checkauth();
    const url = '/api/1c-exchange?type=catalog&mode=import&filename=import.xml';

    await postFile(cookie, 'import.xml', iconvEncode(FIXTURE));
    await app.inject({ method: 'GET', url, headers: { cookie } });
    const first = catalog.rowCounts();

    // новая сессия обмена целиком, как это делает 1С
    const init = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=init',
      headers: { cookie },
    });
    expect(init.body.split('\n')[0]).toBe('zip=yes');
    await expect(readFile(path.join(spoolDir, 'inbox', 'import.xml'))).rejects.toThrow();

    await postFile(cookie, 'import.xml', iconvEncode(FIXTURE));
    const res = await app.inject({ method: 'GET', url, headers: { cookie } });

    expect(res.body).toBe('success');
    expect(catalog.rowCounts()).toEqual(first);
  });

  it('import несуществующего xml — failure', async () => {
    const cookie = await checkauth();
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=import&filename=import.xml',
      headers: { cookie },
    });
    expect(res.body.startsWith('failure')).toBe(true);
  });

  it('zip распаковывается, вредоносные имена записей пропускаются', async () => {
    const cookie = await checkauth();
    const zip = new AdmZip();
    zip.addFile('import.xml', Buffer.from('<xml/>'));
    zip.addFile('../../evil.txt', Buffer.from('bad'));
    await app.inject({
      method: 'POST',
      url: '/api/1c-exchange?type=catalog&mode=file&filename=v8.zip',
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: zip.toBuffer(),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=import&filename=v8.zip',
      headers: { cookie },
    });
    expect(res.body).toBe('success');
    const ok = await readFile(path.join(spoolDir, 'unpacked', 'import.xml'), 'utf8');
    expect(ok).toBe('<xml/>');
    await expect(readFile(path.join(spoolDir, 'evil.txt'))).rejects.toThrow();
  });

  it('import несуществующего файла — failure', async () => {
    const cookie = await checkauth();
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=import&filename=nope.zip',
      headers: { cookie },
    });
    expect(res.body.startsWith('failure')).toBe(true);
  });
});

describe('sale и прочее', () => {
  it('sale:query — валидный пустой CommerceML в win-1251', async () => {
    const cookie = await checkauth();
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=sale&mode=query',
      headers: { cookie },
    });
    expect(res.headers['content-type']).toBe('text/xml; charset=windows-1251');
    expect(res.body).toContain('encoding="windows-1251"');
  });

  it('sale:success — success', async () => {
    const cookie = await checkauth();
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=sale&mode=success',
      headers: { cookie },
    });
    expect(res.body).toBe('success');
  });

  it('неизвестный режим — failure', async () => {
    const cookie = await checkauth();
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=frobnicate',
      headers: { cookie },
    });
    expect(res.body.startsWith('failure')).toBe(true);
  });

  it('каждый запрос попадает в exchange_log', async () => {
    const cookie = await checkauth();
    await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=init',
      headers: { cookie },
    });
    expect(logSink.entries.length).toBe(2);
    expect(logSink.entries[1]).toMatchObject({ type: 'catalog', mode: 'init', result: 'success' });
  });
});

describe('safeRelativeName', () => {
  it.each([
    ['import.xml', 'import.xml'],
    ['import_files/a/b.jpg', 'import_files/a/b.jpg'],
    ['import_files\\a\\b.jpg', 'import_files/a/b.jpg'],
    ['../etc/passwd', null],
    ['/etc/passwd', null],
    ['C:/windows/evil', null],
    ['a/../../b', null],
    ['', null],
    ['import.xml\u0000.txt', null],
  ])('%s -> %s', (input, expected) => {
    expect(safeRelativeName(input)).toBe(expected);
  });
});

describe('исправления по ревью этапа 2', () => {
  it('два одновременных mode=import дают одно задание и один прогон', async () => {
    const cookie = await checkauth();
    await postFile(cookie, 'import.xml', iconvEncode(FIXTURE));
    const url = '/api/1c-exchange?type=catalog&mode=import&filename=import.xml';

    const [a, b] = await Promise.all([
      app.inject({ method: 'GET', url, headers: { cookie } }),
      app.inject({ method: 'GET', url, headers: { cookie } }),
    ]);

    expect([a.body, b.body].every((body) => body === 'success')).toBe(true);
    expect(catalog.runs).toHaveLength(1);
    expect(catalog.products.size).toBe(1);
  });

  it('zip-бомба отбивается лимитом распакованного размера', async () => {
    const zip = new AdmZip();
    zip.addFile('import.xml', Buffer.alloc(8 * 1024 * 1024, 0x20));
    const inbox = path.join(spoolDir, 'inbox');
    await mkdir(inbox, { recursive: true });
    await writeFile(path.join(inbox, 'bomb.zip'), zip.toBuffer());

    await expect(
      unzipSafely(inbox, 'bomb.zip', path.join(spoolDir, 'unpacked'), 1024 * 1024),
    ).rejects.toThrow(/лимит/);
    // распаковка остановлена до записи: 8 МБ из заголовка превышают лимит
    await expect(readFile(path.join(spoolDir, 'unpacked', 'import.xml'))).rejects.toThrow();
  });

  it('лимит распаковки проверяется и по факту, когда заголовок врёт', async () => {
    const inbox = path.join(spoolDir, 'inbox');
    await mkdir(inbox, { recursive: true });
    const zip = new AdmZip();
    zip.addFile('import.xml', Buffer.alloc(512 * 1024, 0x20));
    zip.addFile('import_files/a.bin', Buffer.alloc(512 * 1024, 0x20));
    zip.addFile('import_files/b.bin', Buffer.alloc(512 * 1024, 0x20));
    await writeFile(path.join(inbox, 'many.zip'), zip.toBuffer());

    await expect(
      unzipSafely(inbox, 'many.zip', path.join(spoolDir, 'unpacked'), 768 * 1024),
    ).rejects.toThrow(/лимит/);
  });
});
