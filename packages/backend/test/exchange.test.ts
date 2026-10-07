import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { resetSessions } from '../src/exchange/auth.js';
import { safeRelativeName } from '../src/exchange/files.js';
import { MemoryExchangeLog } from '../src/log/memory.js';

const LOGIN = 'site';
const PASSWORD = 'secret-1c';
const basic = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');

let app: FastifyInstance;
let logSink: MemoryExchangeLog;
let spoolDir: string;

function cfg(): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    exchangeLogin: LOGIN,
    exchangePassword: PASSWORD,
    fileLimit: 1024 * 1024,
    spoolDir,
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
  spoolDir = await mkdtemp(path.join(tmpdir(), 'fa-spool-'));
  logSink = new MemoryExchangeLog();
  app = await buildApp({ config: cfg(), logSink });
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

describe('import', () => {
  it('обычный xml — success', async () => {
    const cookie = await checkauth();
    await app.inject({
      method: 'POST',
      url: '/api/1c-exchange?type=catalog&mode=file&filename=import.xml',
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('<?xml version="1.0"?>'),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/1c-exchange?type=catalog&mode=import&filename=import.xml',
      headers: { cookie },
    });
    expect(res.body).toBe('success');
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
  ])('%s -> %s', (input, expected) => {
    expect(safeRelativeName(input)).toBe(expected);
  });
});
