#!/usr/bin/env bash
# Прогон цикла «Обмена с сайтом» против живого сервера, как это делает 1С:
#   BASE=http://localhost:3000 LOGIN=... PASSWORD=... bash scripts/exchange-curl.sh
# Выгрузка берётся из фикстуры (windows-1251), по умолчанию 300 моделей × 4
# характеристики = 1500 позиций. Переопределяется: MODELS=1000 VARIANTS=6.
# Если задан DATABASE_URL и доступен psql — в конце печатаются счётчики staging.
set -euo pipefail

# Скрипт зовёт npm-скрипт пакета, поэтому работает из каталога пакета
# независимо от того, откуда его запустили.
cd "$(dirname "$0")/.."

BASE="${BASE:-http://localhost:3000}"
LOGIN="${LOGIN:?set LOGIN}"
PASSWORD="${PASSWORD:?set PASSWORD}"
MODELS="${MODELS:-300}"
VARIANTS="${VARIANTS:-4}"
EP="$BASE/api/1c-exchange"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say() { printf '\n== %s ==\n' "$*"; }

say "фикстура import.xml"
npm run --silent fixture:import -- --models "$MODELS" --variants "$VARIANTS" --out "$WORK/import.xml"

say "checkauth"
RESP="$(curl -fsS -u "$LOGIN:$PASSWORD" "$EP?type=catalog&mode=checkauth")"
echo "$RESP"
NAME="$(echo "$RESP" | sed -n 2p)"
VALUE="$(echo "$RESP" | sed -n 3p)"
COOKIE="$NAME=$VALUE"
[ "$(echo "$RESP" | sed -n 1p)" = "success" ] || { echo "checkauth failed"; exit 1; }

say "init"
curl -fsS -b "$COOKIE" "$EP?type=catalog&mode=init"; echo

say "file (2 куска, как чанки 1С)"
split -n 2 -d "$WORK/import.xml" "$WORK/part"
for part in "$WORK"/part*; do
  curl -fsS -b "$COOKIE" --data-binary "@$part" \
    -H 'Content-Type: application/octet-stream' \
    "$EP?type=catalog&mode=file&filename=import.xml"
  echo " <- $(basename "$part") ($(wc -c < "$part") байт)"
done

say "import (пока progress — повторяем, как 1С)"
for _ in $(seq 1 60); do
  OUT="$(curl -fsS -b "$COOKIE" "$EP?type=catalog&mode=import&filename=import.xml")"
  FIRST="$(echo "$OUT" | sed -n 1p)"
  echo "$FIRST"
  [ "$FIRST" = "progress" ] || break
  sleep 2
done
[ "$FIRST" = "success" ] || { echo "import failed: $OUT"; exit 1; }

say "offers.xml (этап 3 — должен быть пропущен)"
curl -fsS -b "$COOKIE" --data-binary '<x/>' \
  -H 'Content-Type: application/octet-stream' \
  "$EP?type=catalog&mode=file&filename=offers.xml" >/dev/null
curl -fsS -b "$COOKIE" "$EP?type=catalog&mode=import&filename=offers.xml"; echo

say "sale query"
curl -fsS -b "$COOKIE" "$EP?type=sale&mode=query" | head -c 200; echo

if [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null; then
  say "счётчики staging"
  psql "$DATABASE_URL" -A -F' ' -t -c "
    SELECT 'categories', count(*) FROM categories
    UNION ALL SELECT 'brands', count(*) FROM brands
    UNION ALL SELECT 'properties', count(*) FROM properties
    UNION ALL SELECT 'products', count(*) FROM products
    UNION ALL SELECT 'product_variants', count(*) FROM product_variants
    UNION ALL SELECT 'product_images_meta', count(*) FROM product_images_meta"
  psql "$DATABASE_URL" -x -t -c "
    SELECT filename, status, products, variants, categories,
           round(extract(epoch FROM finished_at - started_at)::numeric, 2) AS seconds
      FROM catalog_import_runs ORDER BY id DESC LIMIT 1"
fi

say "OK: полный цикл пройден"
