#!/usr/bin/env tsx
/**
 * Генератор фикстурной выгрузки offers.xml (windows-1251), согласованной
 * с фикстурой import.xml этапа 2 (те же Ид моделей и характеристик):
 *
 *   npm run fixture:offers -w @fa/backend -- --models 300 --variants 4 --out spool/unpacked/offers.xml
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildOffersXml, generateLargeOffers, writeOffersXml } from '../src/offers/fixtures.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const models = Number(arg('models', '300'));
const variants = Number(arg('variants', '4'));
const out = path.resolve(arg('out', 'spool/unpacked/offers.xml'));
const encoding = arg('encoding', 'win1251');

const spec = generateLargeOffers(models, variants);
const xml = buildOffersXml(spec);
await mkdir(path.dirname(out), { recursive: true });
await writeOffersXml(out, xml, encoding);

process.stdout.write(
  `${out}: ${spec.offers?.length ?? 0} предложений (${models} моделей × ${variants} характеристик), ${encoding}\n`,
);
