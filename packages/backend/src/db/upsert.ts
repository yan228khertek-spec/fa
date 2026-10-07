/**
 * Общие помощники идемпотентной записи staging-таблиц (каталог — этап 2,
 * предложения — этап 3). Вынесены из catalog/pg.ts без изменения поведения.
 */
import type pg from 'pg';

export const SOURCE = '1c';

/**
 * Разделитель составного ключа при сверке дочерних строк. NUL в text
 * PostgreSQL недопустим, поэтому берём управляющий символ, которого не бывает
 * в Ид из 1С.
 */
export const KEY_SEP = '\u001f';
export const KEY_SEP_SQL = String.raw`E'\x1f'`;

export type Cell = string | number | boolean | null;

export interface Column {
  name: string;
  type: string;
  values: Cell[];
}

export function column(name: string, type: string, values: Cell[]): Column {
  return { name, type, values };
}

export function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(key(item), item);
  return [...byKey.values()];
}

/**
 * SET-часть upsert'а + WHERE «обновляй только если реально изменилось».
 * Колонки из preserveNull обновляются через coalesce: NULL в пришедшей строке
 * означает «тега в файле не было — оставить как есть», а не «очистить»
 * (инкрементальные выгрузки 1С «только остатки»/«только цены»; ревью этапа 3,
 * находка 1).
 */
export function updateOnlyIfChanged(
  table: string,
  cols: string[],
  touch: boolean,
  preserveNull: string[] = [],
): string {
  const value = (c: string): string =>
    preserveNull.includes(c) ? `coalesce(EXCLUDED.${c}, ${table}.${c})` : `EXCLUDED.${c}`;
  const set = cols.map((c) => `${c} = ${value(c)}`);
  if (touch) set.push('updated_at = now()');
  const left = cols.map((c) => `${table}.${c}`).join(', ');
  const right = cols.map((c) => value(c)).join(', ');
  return `DO UPDATE SET ${set.join(', ')} WHERE (${left}) IS DISTINCT FROM (${right})`;
}

/**
 * INSERT из массивов через unnest: на запрос уходит столько параметров,
 * сколько колонок, а не колонок × строк. Иначе батч из 500 товаров с десятками
 * значений свойств пробивает лимит протокола PostgreSQL (65535 параметров) и
 * вся выгрузка падает — ревью этапа 2, находка 1.
 */
export function insertFromArrays(
  table: string,
  cols: Column[],
  conflictCols: string[],
  updateCols: string[],
  touch: boolean,
  preserveNull: string[] = [],
): { text: string; params: unknown[] } {
  const names = cols.map((c) => c.name).join(', ');
  const arrays = cols.map((c, i) => `$${i + 1}::${c.type}[]`).join(', ');
  const conflict = updateCols.length
    ? updateOnlyIfChanged(table, updateCols, touch, preserveNull)
    : 'DO NOTHING';
  return {
    text: `INSERT INTO ${table} (${names})
             SELECT ${names} FROM unnest(${arrays}) AS s(${names})
           ON CONFLICT (${conflictCols.join(', ')}) ${conflict}`,
    params: cols.map((c) => c.values),
  };
}

export interface ChildSpec {
  table: string;
  /** Фиксированные колонки ключа, одинаковые для всего батча. */
  fixed?: Record<string, string>;
  ownerCol: string;
  keyCols: string[];
  valueCols?: string[];
  valueTypes?: Record<string, string>;
  touch?: boolean;
}

/**
 * Синхронизирует дочерние строки для набора владельцев: вставляет пришедшие,
 * обновляет изменившиеся, удаляет исчезнувшие. Все ключевые колонки входят в
 * первичный ключ и серийных id нет, поэтому повторная загрузка того же файла
 * не меняет ни одной строки — идемпотентность по счётчикам сохраняется.
 */
export async function syncChildren(
  client: pg.PoolClient,
  spec: ChildSpec,
  owners: string[],
  rows: Record<string, Cell>[],
): Promise<void> {
  if (owners.length === 0) return;
  const fixed = spec.fixed ?? {};
  const fixedCols = Object.keys(fixed);
  const keyCols = ['source', ...fixedCols, spec.ownerCol, ...spec.keyCols];
  const valueCols = spec.valueCols ?? [];

  if (rows.length > 0) {
    const cols: Column[] = [
      column(
        'source',
        'text',
        rows.map(() => SOURCE),
      ),
      ...fixedCols.map((c) =>
        column(
          c,
          'text',
          rows.map(() => fixed[c] ?? null),
        ),
      ),
      column(
        spec.ownerCol,
        'text',
        rows.map((r) => r[spec.ownerCol] ?? null),
      ),
      ...spec.keyCols.map((c) =>
        column(
          c,
          'text',
          rows.map((r) => r[c] ?? null),
        ),
      ),
      ...valueCols.map((c) =>
        column(
          c,
          spec.valueTypes?.[c] ?? 'text',
          rows.map((r) => r[c] ?? null),
        ),
      ),
    ];
    const q = insertFromArrays(spec.table, cols, keyCols, valueCols, spec.touch ?? false);
    await client.query(q.text, q.params);
  }

  // Удаляем исчезнувшее: набор «оставить» уходит одним text[]-параметром,
  // поэтому размер батча на число параметров запроса не влияет.
  const identity = [spec.ownerCol, ...spec.keyCols];
  const keep = rows.map((r) => identity.map((c) => String(r[c] ?? '')).join(KEY_SEP));
  const params: unknown[] = [SOURCE];
  const where = ['t.source = $1'];
  for (const col of fixedCols) {
    params.push(fixed[col]);
    where.push(`t.${col} = $${params.length}`);
  }
  params.push(owners);
  where.push(`t.${spec.ownerCol} = ANY($${params.length}::text[])`);
  params.push(keep);
  const expr = identity.map((c) => `t.${c}`).join(` || ${KEY_SEP_SQL} || `);
  where.push(`(${expr}) <> ALL($${params.length}::text[])`);
  await client.query(`DELETE FROM ${spec.table} t WHERE ${where.join(' AND ')}`, params);
}
