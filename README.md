# Fashion Avenue (fa)

Интернет-магазин Fashion Avenue: приёмник каталога из 1С:Розница 2.3 («Обмен с сайтом», CommerceML) и витрина.

## Структура

- `packages/backend` — приёмник CommerceML и API витрины (Node.js, TypeScript, Fastify, PostgreSQL).
- `packages/frontend` — витрина (React/TS), пока заглушка.
- `docs/adr` — архитектурные решения.
- Мастердок разработки приёмника и dev-log — в проекте Fashion Avenue (Claude).

## Быстрый старт

```bash
cp .env.example .env   # заполнить значения
npm ci
docker compose up -d   # PostgreSQL 16
npm test
npm run dev            # backend на :3000
```

Миграции применяются автоматически при старте приёмника; вручную — по порядку:

```bash
psql "$DATABASE_URL" -f packages/backend/migrations/001_exchange_log.sql
psql "$DATABASE_URL" -f packages/backend/migrations/002_catalog_staging.sql
```

## Проверка обмена без 1С

Реальной выгрузки из 1С пока нет, поэтому фикстуры генерируются по структуре CommerceML 2 (windows-1251):

```bash
npm run fixture:import -w @fa/backend -- --models 300 --variants 4 --out /tmp/import.xml
BASE=http://localhost:3000 LOGIN=site PASSWORD=... bash packages/backend/scripts/exchange-curl.sh
```

Скрипт проходит полный цикл checkauth → init → file (чанками) → import → sale:query и, если задан `DATABASE_URL` и доступен `psql`, печатает счётчики staging. Интеграционные тесты против живой БД включаются переменной `TEST_DATABASE_URL`:

```bash
TEST_DATABASE_URL="$DATABASE_URL" npm test -w @fa/backend
```

## Правила работы

Код — только через ветку и PR, `main` защищён. Ревью делает второй участник. Одна сессия Клода = один шаг мастердока; каждая сессия заканчивается записью в dev-log.

Секреты (Basic auth для 1С, доступы) не попадают ни в репозиторий, ни в чаты — только менеджер секретов.
