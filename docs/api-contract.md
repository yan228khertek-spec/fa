# API-контракт витрины Fashion Avenue

Версия 1.1 · 15.10.2026 · зафиксирован по факту кода. 1.0 — ветка `feat/site-brands-admin`, смержена в `main` коммитом 778994c; 1.1 — реализована ручка `/images/*` (A2/M1, ветка `feat/media-serving`), прочие ручки не менялись.

Это **граница ответственности** Ян ↔ Влад (раздел 7a мастер-плана). Публичные ручки ниже зовёт витрина (ветка `site`) вживую. **Контракт меняется только по согласованию Ян↔Влад** — через правку этого файла и явное «ок» второй стороны. Схема сайтовых таблиц (миграции 004–006) — тоже часть контракта: DDL меняет только Ян (см. раздел «Схема C1»).

Базовый адрес API (dev/staging): `https://1c-dev.avenuefashion.online`. Витрина берёт его из `API_BASE` в `assets/site.js`.

Общие правила:

- Все публичные ответы — JSON, `Access-Control-Allow-Origin: *` (витрина и API на разных поддоменах).
- Кэш: `Cache-Control: public, max-age=30…60` на публичных ручках.
- Фото в ответах — абсолютные URL (`PUBLIC_BASE_URL` + путь), либо `null`.
- Числовые/строковые query-параметры санируются сервером (обрезка длины, клампинг пагинации); неизвестные значения игнорируются.
- Раздел (`category`) и вид изделия (`kind`) **вычисляются из названия товара 1С** (в выгрузке нет связи товар→категория), а не хранятся.

---

## Публичные ручки (витрина)

### `GET /api/brands?gender=men|women`

Бренды раздела: «Топ бренды» (плитки) и полный список.

- Query: `gender` — `men` или `women` (по умолчанию `women`; иное → `400`).
- Ответ `200`:

```json
{
  "gender": "women",
  "top": [
    {
      "name": "Marina Rinaldi",
      "slug": "marina-rinaldi",
      "photo": "https://…/uploads/….jpg",
      "logo": "https://…/uploads/….png"
    }
  ],
  "all": [{ "name": "…", "slug": "…" }]
}
```

`photo`/`logo` могут быть `null`. `top` отсортирован по порядку плиток, `all` — по имени.

### `GET /api/brands/:slug/models`

Карточки бренда с фасетами (для страницы бренда).

- Path: `slug` — адрес бренда. Нет бренда → `404 {error}`.
- Query: `category` (≤40), `kind` (≤60), `limit` (1…100, деф. 24), `offset` (≥0).
- Ответ `200`:

```json
{
  "brand": { "name": "…", "slug": "…" },
  "total": 42,
  "facets": {
    "categories": [{ "name": "Одежда", "count": 30 }],
    "kinds": [{ "name": "Джемпер", "count": 8 }]
  },
  "items": [/* см. элемент листинга ниже */]
}
```

### `GET /api/home`

Блоки главной: бренды с флагом «Показывать на главной» и их последние опубликованные карточки.

- Ответ `200`:

```json
{ "brands": [{ "name": "…", "slug": "…", "total": 12, "items": [/* элемент листинга */] }] }
```

Бренд без видимых карточек в блок не попадает. До 3 брендов, до 4 карточек в каждом.

### `GET /api/cards?category=&kind=&limit=&offset=`

Листинг витрины (только видимые карточки).

- Query: `category` (≤40), `kind` (≤60), `limit` (1…100, деф. 24), `offset` (≥0).
- Ответ `200`:

```json
{
  "total": 120,
  "facets": {
    "categories": [{ "name": "Одежда", "count": 80 }],
    "kinds": [{ "name": "Платье", "count": 15 }]
  },
  "items": [/* элемент листинга */]
}
```

**Элемент листинга (`items[]`)** — единый для `/api/cards`, `/api/brands/:slug/models`, `/api/home`:

```json
{
  "id": 17,
  "modelId": "<GUID товара 1С>",
  "title": "Платье Pinko чёрное",
  "brand": { "name": "Pinko", "slug": "pinko" },
  "photo": "https://…/uploads/….jpg",
  "price": 18990,
  "inStock": true,
  "category": "Одежда",
  "kind": "Платье"
}
```

`brand`, `photo`, `price`, `inStock` могут быть `null` (нет бренда / фото / цены / данных об остатке).

### `GET /api/cards/:id`

Карточка целиком (страница товара).

- Path: `id` — целое > 0. Не найдено / не видима → `404 {error}`.
- Ответ `200` — элемент листинга **плюс**:

```json
{
  "article": "PK-1234",
  "description": "…",
  "characteristics": [{ "name": "Состав", "value": "Шерсть 80%" }],
  "photos": ["https://…/uploads/a.jpg", "https://…/uploads/b.jpg"],
  "sizes": [{ "size": "46", "color": "чёрный", "inStock": true }]
}
```

### `GET /uploads/:file`

Фото и логотипы (загруженные в админке). Имя строго `^[a-f0-9]{16}\.(jpg|png|webp|avif)$`, иначе `404`. Заголовки: `Content-Type` по расширению, `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=604800, immutable`.

### `GET /images/*`

Фото из выгрузки 1С (A2/M1). Отдаёт **Caddy** напрямую из тома `media`, минуя backend.

- Путь после `/images/` — значение `product_images_meta.path`, то есть относительный путь внутри выгрузки: `/images/import_files/ab/cd.jpg`.
- Только `GET` и `HEAD`; остальные методы — `405`.
- Отдаются **только картинки** (`jpg/jpeg/png/webp/avif/gif/bmp`); файл с любым другим расширением — `404`, даже если он лежит в томе: содержимое приходит из 1С, а `.html`/`.svg` исполнялся бы на origin API, где живут `/admin` и `/uploads`.
- Заголовки: `Cache-Control: public, max-age=86400`, `X-Content-Type-Options: nosniff`.
- Файл появляется после успешного `import.xml` (backend переносит `spool/unpacked/import_files` в хранилище) и **не удаляется** следующими выгрузками: старые URL не рвутся. `404` — фото в выгрузках не было.
- Базовый адрес для витрины — `IMAGES_BASE_URL`, по умолчанию `PUBLIC_BASE_URL + /images/`. Формула для карточки: URL фото = `https://1c-dev.avenuefashion.online/images/` + путь из колонки «Файлы фото».

Фото, загруженные в админке Ангелиной, живут отдельно — `/uploads/:file` (том `uploads`).

---

## Правило видимости карточки (A5)

Карточка попадает в публичную выдачу, только если: статус `published` **И** есть хотя бы одно фото **И** модель есть в staging 1С **И** (если остаток известен) остаток > 0. Иначе карточка скрыта (`draft` / `gone` / `no-photo` / `no-stock`), но **не удаляется**. Скрытие — правилом в API, не обменом.

---

## Админ-ручки (внутренний контур, не для витрины)

Под `/admin` (Basic-auth; изменяющие методы требуют заголовок `X-FA-Admin: 1`; CORS не открыт). Публичной частью контракта не являются — приведены для полноты.

- `GET /admin` — UI конструктора.
- Бренды: `GET/POST /admin/api/brands`, `PUT/DELETE /admin/api/brands/:id`, `PUT /admin/api/top/:gender`, `POST|DELETE /admin/api/brands/:id/image/:kind`.
- Привязки: `GET /admin/api/unmatched`, `PUT /admin/api/models/:modelId/brand`, `POST /admin/api/recompute`, `POST /admin/api/seed`.
- Карточки: `GET /admin/api/cards`, `GET /admin/api/cards/search`, `POST /admin/api/cards`, `GET/PUT/DELETE /admin/api/cards/:id`, фото: `POST …/photos`, `POST …/photos/from-1c`, `PUT …/photos/order`, `DELETE …/photos/:photoId`.
- Служебное: `GET /admin/api/stats`, `GET /admin/api/exchange`.

---

## Схема C1 (сайтовые таблицы)

Миграции **004–006** фиксируются как согласованная схема сайтового слоя (C1): `site_brands`, `site_brand_aliases`, `site_brand_placements`, `site_model_brand` (004); `site_cards`, `site_card_photos` (005); `site_brands.show_on_home` (006). DDL идемпотентен, продублирован в `src/admin/{schema,cards-schema,home-schema}.ts` и сверяется тестом `admin-schema.test.ts`.

**Дальше DDL сайтовых таблиц меняет только Ян** (новая миграция). Админ-UI (Влад) строится поверх этой схемы и публичного API; staging (001–003) для сайтового слоя — read-only.

---

## Открытые вопросы к контракту (не ломают текущие ответы)

- ~~**Тип цены** и **остаток**~~ — закрыты 14.10 (PR #12, main 88a404b): `price` берётся по типу `SITE_PRICE_TYPE` («Розничные»), `inStock` — по складу `SITE_STOCK_WAREHOUSE` («Касса ТЗ 2 Fashion Avenue»), двоение остатков отсечено. Форма ответа не менялась.
- **Покрытие данными**: `price`/`inStock` остаются `null` у моделей, которых нет в выгрузке offers (15.10: пересечение каталог↔offers — 375 SKU из 1 490). Это вопрос отбора в 1С (⁇3 мастер-плана), а не контракта.
