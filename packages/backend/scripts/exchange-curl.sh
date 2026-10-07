#!/usr/bin/env bash
# Прогон цикла «Обмена с сайтом» против живого сервера, как это делает 1С:
#   BASE=http://localhost:3000 LOGIN=... PASSWORD=... bash scripts/exchange-curl.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
LOGIN="${LOGIN:?set LOGIN}"
PASSWORD="${PASSWORD:?set PASSWORD}"
EP="$BASE/api/1c-exchange"

say() { printf '\n== %s ==\n' "$*"; }

say "checkauth"
RESP="$(curl -fsS -u "$LOGIN:$PASSWORD" "$EP?type=catalog&mode=checkauth")"
echo "$RESP"
NAME="$(echo "$RESP" | sed -n 2p)"
VALUE="$(echo "$RESP" | sed -n 3p)"
COOKIE="$NAME=$VALUE"
[ "$(echo "$RESP" | sed -n 1p)" = "success" ] || { echo "checkauth failed"; exit 1; }

say "init"
curl -fsS -b "$COOKIE" "$EP?type=catalog&mode=init"; echo

say "file (2 куска)"
printf '<?xml version="1.0" encoding="windows-1251"?>' > /tmp/fa-part1
printf '<КоммерческаяИнформация/>' > /tmp/fa-part2
curl -fsS -b "$COOKIE" --data-binary @/tmp/fa-part1 "$EP?type=catalog&mode=file&filename=import.xml"; echo
curl -fsS -b "$COOKIE" --data-binary @/tmp/fa-part2 "$EP?type=catalog&mode=file&filename=import.xml"; echo

say "import"
curl -fsS -b "$COOKIE" "$EP?type=catalog&mode=import&filename=import.xml"; echo

say "sale query"
curl -fsS -b "$COOKIE" "$EP?type=sale&mode=query"; echo

say "OK: полный цикл пройден"
