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

## Правила работы

Код — только через ветку и PR, `main` защищён. Ревью делает второй участник. Одна сессия Клода = один шаг мастердока; каждая сессия заканчивается записью в dev-log.

Секреты (Basic auth для 1С, доступы) не попадают ни в репозиторий, ни в чаты — только менеджер секретов.
