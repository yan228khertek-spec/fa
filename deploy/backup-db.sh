#!/usr/bin/env bash
# Бэкап staging-БД приёмника (pg_dump из контейнера db) в ./backups,
# хранится 14 последних дампов. Запуск вручную или из cron, из корня репо:
#   bash deploy/backup-db.sh
# Cron (ежедневно в 03:17):
#   17 3 * * * cd /home/user1/fa && bash deploy/backup-db.sh >> backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
. ./.env
set +a

mkdir -p backups
STAMP="$(date +%Y%m%d-%H%M%S)"
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U "${POSTGRES_USER:-fa}" "${POSTGRES_DB:-fa}" \
  | gzip > "backups/fa-${STAMP}.sql.gz"
ls -t backups/fa-*.sql.gz | tail -n +15 | xargs -r rm --
echo "OK: backups/fa-${STAMP}.sql.gz ($(du -h "backups/fa-${STAMP}.sql.gz" | cut -f1))"
