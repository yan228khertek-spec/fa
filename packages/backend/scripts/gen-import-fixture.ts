#!/usr/bin/env tsx
/**
 * Генератор фикстурной выгрузки import.xml (windows-1251).
 *
 *   npm run fixture:import -w @fa/backend -- --models 300 --variants 4 --out spool/unpacked/import.xml
 *
 * 300 моделей × 4 характеристики = 1500 позиций: ровно та фикстура, на которой
 * проверяется DoD этапа 2 (загрузка <60 с, идемпотентность по счётчикам).
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildImportXml, generateLargeCatalog, writeImportXml } from '../src/catalog/fixtures.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const models = Number(arg('models', '300'));
const variants = Number(arg('variants', '4'));
const out = path.resolve(arg('out', 'spool/unpacked/import.xml'));
const encoding = arg('encoding', 'win1251');

const spec = generateLargeCatalog(models, variants);
const xml = buildImportXml(spec);
await mkdir(path.dirname(out), { recursive: true });
await writeImportXml(out, xml, encoding);

process.stdout.write(
  `${out}: ${spec.products?.length ?? 0} позиций (${models} моделей × ${variants} характеристик), ${encoding}\n`,
);
