#!/usr/bin/env bash
# Удаляет ТЕСТ-заказы (comment LIKE 'ТЕСТ%') из таблицы orders.
# order_items / order_status_history удаляются каскадом; marketing_consents этих
# заказов удаляем явно (их order_id иначе осталось бы висеть с NULL).
#
# Подключение к БД — через DATABASE_URL. На fa-dev запускать через контейнер:
#   docker compose -f docker-compose.prod.yml exec -T db \
#     psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f - < scripts/cleanup-test-orders.sh  # (не так)
# проще: DATABASE_URL=postgres://user:pass@host/db bash scripts/cleanup-test-orders.sh --yes
#
# Без --yes скрипт только ПОКАЗЫВАЕТ, что удалит, и ничего не трогает.
set -euo pipefail

: "${DATABASE_URL:?Задайте DATABASE_URL (строка подключения PostgreSQL)}"
PATTERN='ТЕСТ%'

count=$(psql "$DATABASE_URL" -tAc \
  "SELECT count(*) FROM orders WHERE comment LIKE '${PATTERN}'")
echo "ТЕСТ-заказов под удаление: ${count}"
psql "$DATABASE_URL" -c \
  "SELECT number, created_at, comment FROM orders WHERE comment LIKE '${PATTERN}' ORDER BY created_at"

if [ "${1:-}" != "--yes" ]; then
  echo
  echo "Это пробный показ. Для удаления: bash $0 --yes"
  exit 0
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
DELETE FROM marketing_consents
  WHERE order_id IN (SELECT id FROM orders WHERE comment LIKE '${PATTERN}');
DELETE FROM orders WHERE comment LIKE '${PATTERN}';
COMMIT;
SQL
echo "Удалено ТЕСТ-заказов: ${count}"
