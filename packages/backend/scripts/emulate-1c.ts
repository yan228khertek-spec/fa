#!/usr/bin/env tsx
/**
 * Эмулятор 1С:Розницы (этап 4 мастердока): проходит полный цикл «Обмена
 * с сайтом» против живого приёмника, как это делает настоящая 1С —
 * checkauth → init → file (zip, чанками по file_limit) → import (import.xml,
 * затем offers.xml, с повторами на progress) → sale:query → sale:success.
 * Им же проверяем деплой (этап 5): достаточно сменить BASE на публичный URL.
 *
 *   LOGIN=... PASSWORD=... npm run emulate:1c -w @fa/backend
 *   BASE=https://1c-dev.avenuefashion.online LOGIN=... PASSWORD=... npm run emulate:1c -w @fa/backend
 *
 * Параметры (env): BASE (http://localhost:3000), MODELS=300, VARIANTS=4,
 * ZIP=yes|no (yes), CHUNK=262144, IMPORT_TIMEOUT_MS=180000.
 * Выход 0 — весь цикл пройден; иначе 1 и понятная причина.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import iconv from 'iconv-lite';
import { buildImportXml, generateLargeCatalog, writeImportXml } from '../src/catalog/fixtures.js';
import { buildOffersXml, generateLargeOffers, writeOffersXml } from '../src/offers/fixtures.js';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const LOGIN = process.env.LOGIN ?? '';
const PASSWORD = process.env.PASSWORD ?? '';
/** Числовой параметр: кривое значение — честный отказ, а не NaN и пустая фикстура. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    process.stderr.write(`${name}=${raw}: ожидалось положительное число\n`);
    process.exit(2);
  }
  return value;
}

const MODELS = intEnv('MODELS', 300);
const VARIANTS = intEnv('VARIANTS', 4);
const USE_ZIP = (process.env.ZIP ?? 'yes') !== 'no';
const CHUNK = intEnv('CHUNK', 256 * 1024);
const IMPORT_TIMEOUT_MS = intEnv('IMPORT_TIMEOUT_MS', 180_000);
/** Таймаут одного HTTP-запроса — молчащий сервер не держит шаг до таймаутов undici. */
const REQUEST_TIMEOUT_MS = intEnv('REQUEST_TIMEOUT_MS', 60_000);

if (!LOGIN || !PASSWORD) {
  process.stderr.write('Задайте LOGIN и PASSWORD (креды «Обмена с сайтом»)\n');
  process.exit(2);
}

const EP = `${BASE}/api/1c-exchange`;
const basic = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
let cookie = '';

class StepError extends Error {}

const steps: { name: string; ms: number }[] = [];

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - started;
    steps.push({ name, ms });
    process.stdout.write(`  ✓ ${name} (${ms} мс)\n`);
    return result;
  } catch (err) {
    process.stdout.write(`  ✗ ${name}\n`);
    throw err;
  }
}

/** GET к обмену; тело ответа декодируется из windows-1251, как это делает 1С. */
async function get(params: string): Promise<{ lines: string[]; raw: Buffer; contentType: string }> {
  const res = await fetch(`${EP}?${params}`, {
    headers: { authorization: basic, ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = Buffer.from(await res.arrayBuffer());
  const body = iconv.decode(raw, 'win1251');
  if (!res.ok) throw new StepError(`HTTP ${res.status} на ?${params}: ${body.slice(0, 200)}`);
  return { lines: body.split('\n'), raw, contentType: res.headers.get('content-type') ?? '' };
}

async function postChunk(filename: string, chunk: Buffer): Promise<void> {
  const res = await fetch(`${EP}?type=catalog&mode=file&filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: {
      authorization: basic,
      ...(cookie ? { cookie } : {}),
      'content-type': 'application/octet-stream',
    },
    body: new Uint8Array(chunk),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = iconv.decode(Buffer.from(await res.arrayBuffer()), 'win1251');
  if (!res.ok || body.split('\n')[0] !== 'success') {
    throw new StepError(`mode=file ${filename}: ${body.slice(0, 200)}`);
  }
}

/** mode=import с повторами на progress — ровно так ведёт себя 1С. */
async function runImport(filename: string): Promise<string> {
  const deadline = Date.now() + IMPORT_TIMEOUT_MS;
  for (;;) {
    const { lines } = await get(
      `type=catalog&mode=import&filename=${encodeURIComponent(filename)}`,
    );
    const first = lines[0];
    if (first === 'success') return lines[1] ?? '';
    if (first === 'progress') {
      if (Date.now() > deadline) {
        throw new StepError(`mode=import ${filename}: progress дольше ${IMPORT_TIMEOUT_MS} мс`);
      }
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    throw new StepError(`mode=import ${filename}: ${lines.join(' | ').slice(0, 300)}`);
  }
}

const work = await mkdtemp(path.join(tmpdir(), 'fa-emulate-'));

try {
  process.stdout.write(`Эмулятор 1С → ${EP}\n`);
  process.stdout.write(
    `Фикстуры: ${MODELS} моделей × ${VARIANTS} характеристик, zip=${USE_ZIP ? 'yes' : 'no'}\n`,
  );

  await step(`фикстуры import.xml + offers.xml (windows-1251)`, async () => {
    await writeImportXml(
      path.join(work, 'import.xml'),
      buildImportXml(generateLargeCatalog(MODELS, VARIANTS)),
    );
    await writeOffersXml(
      path.join(work, 'offers.xml'),
      buildOffersXml(generateLargeOffers(MODELS, VARIANTS)),
    );
  });

  await step('checkauth: ровно 3 строки, без BOM и хвостового \\n', async () => {
    const { lines, raw } = await get('type=catalog&mode=checkauth');
    if (raw[0] === 0xef) throw new StepError('ответ начинается с BOM');
    if (lines.length !== 3 || lines[0] !== 'success') {
      throw new StepError(`ожидались 3 строки success/имя/значение, пришло: ${lines.join(' | ')}`);
    }
    if (raw[raw.length - 1] === 0x0a) throw new StepError('хвостовой \\n в ответе checkauth');
    cookie = `${lines[1]}=${lines[2]}`;
  });

  const fileLimit = await step('init: zip=yes и file_limit', async () => {
    const { lines } = await get('type=catalog&mode=init');
    if (lines[0] !== 'zip=yes') throw new StepError(`ожидался zip=yes, пришло: ${lines[0]}`);
    const limit = Number(lines[1]?.split('=')[1]);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new StepError(`не разобрали file_limit: ${lines[1]}`);
    }
    return limit;
  });

  const chunkSize = Math.min(CHUNK, fileLimit);
  const files: { name: string; data: Buffer }[] = [];
  if (USE_ZIP) {
    const zip = new AdmZip();
    zip.addFile('import.xml', await readFile(path.join(work, 'import.xml')));
    zip.addFile('offers.xml', await readFile(path.join(work, 'offers.xml')));
    files.push({ name: 'v8_fa.zip', data: zip.toBuffer() });
  } else {
    files.push({ name: 'import.xml', data: await readFile(path.join(work, 'import.xml')) });
    files.push({ name: 'offers.xml', data: await readFile(path.join(work, 'offers.xml')) });
  }

  for (const file of files) {
    const chunks = Math.max(1, Math.ceil(file.data.length / chunkSize));
    await step(`file: ${file.name}, ${file.data.length} байт, чанков: ${chunks}`, async () => {
      for (let i = 0; i < file.data.length; i += chunkSize) {
        await postChunk(file.name, file.data.subarray(i, i + chunkSize));
      }
    });
  }

  const catalogDetail = await step('import: import.xml (progress → success)', () =>
    runImport('import.xml'),
  );
  if (catalogDetail) process.stdout.write(`      ${catalogDetail}\n`);

  const offersDetail = await step('import: offers.xml (progress → success)', () =>
    runImport('offers.xml'),
  );
  if (offersDetail) process.stdout.write(`      ${offersDetail}\n`);

  await step('sale:query — валидный CommerceML в win-1251', async () => {
    const { lines, contentType } = await get('type=sale&mode=query');
    if (!contentType.includes('text/xml')) throw new StepError(`content-type: ${contentType}`);
    if (!lines.join('\n').includes('КоммерческаяИнформация')) {
      throw new StepError('в ответе нет корня КоммерческаяИнформация');
    }
  });

  await step('sale:success — подтверждение приёма заказов', async () => {
    const { lines } = await get('type=sale&mode=success');
    if (lines[0] !== 'success') throw new StepError(`ожидался success, пришло: ${lines[0]}`);
  });

  const total = steps.reduce((n, s) => n + s.ms, 0);
  process.stdout.write(`\nOK: полный цикл 1С пройден против ${BASE} за ${total} мс\n`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\nFAIL: ${message}\n`);
  process.exitCode = 1;
} finally {
  await rm(work, { recursive: true, force: true });
}
