# Деплой приёмника на fa-dev (этап 5-мини)

Сервер: **fa-dev**, Cloud.ru Evolution (проект FA_test) · Ubuntu 22.04 · 1 vCPU / 2 ГБ · публичный IP **45.132.178.101** · вход по SSH-ключу, логин `user1`.
Домен приёмника: **1c-dev.avenuefashion.online** (зона avenuefashion.online на reg.ru).
Endpoint для 1С после деплоя: `https://1c-dev.avenuefashion.online/api/1c-exchange`.

Состав: `docker-compose.prod.yml` (db + backend + caddy), `deploy/Caddyfile` (HTTPS Let's Encrypt), `.env.production.example` (шаблон секретов), `deploy/backup-db.sh` (бэкап БД). Схема БД применяется приёмником идемпотентно при старте — отдельного шага миграций нет.

## 0. Предусловия (разово, вне сервера)

1. **DNS (reg.ru):** в зоне `avenuefashion.online` добавить A-запись `1c-dev` → `45.132.178.101` (TTL минимальный). Основной сайт на GitHub Pages это не задевает. Проверка с Мака: `dig +short 1c-dev.avenuefashion.online` → должен вернуться `45.132.178.101`.
2. **Cloud.ru, группа безопасности** машины fa-dev: добавить входящие правила TCP **80** и TCP **443** с `0.0.0.0/0` (вдобавок к существующему 22). Без 80 не выпустится сертификат Let's Encrypt.

## 1. Подготовка сервера (разово)

```bash
ssh user1@45.132.178.101

sudo apt-get update && sudo apt-get install -y git curl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker user1
exit
```

Перезайти (`ssh user1@45.132.178.101`), проверить: `docker ps` работает без sudo, `docker compose version` показывает v2.

## 2. Код и секреты

```bash
git clone https://github.com/yan228khertek-spec/fa.git ~/fa
cd ~/fa
cp .env.production.example .env
```

Сгенерировать секреты прямо на сервере и вписать в `.env` (nano .env):

```bash
echo "POSTGRES_PASSWORD: $(openssl rand -hex 16)"
echo "EXCHANGE_PASSWORD: $(openssl rand -base64 18)"
```

Заполнить также `ACME_EMAIL` (живой ящик для писем Let's Encrypt). `EXCHANGE_DOMAIN` и `EXCHANGE_LOGIN` уже стоят. Пароли никуда не пересылать; для 1С-специалиста логин/пароль обмена передать защищённым каналом (не почтой открытым текстом).

## 3. Запуск

```bash
cd ~/fa
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f caddy
```

В логах caddy дождаться выпуска сертификата (`certificate obtained successfully`). Статусы сервисов — `healthy`.

## 4. Smoke-тест снаружи (с Мака, из корня репо)

```bash
curl -i https://1c-dev.avenuefashion.online/healthz
```

Ожидается `200 ok`. Затем полный цикл обмена, как его делает 1С (фикстура генерится локально, нужен `npm ci` в репо):

```bash
BASE=https://1c-dev.avenuefashion.online LOGIN=fa-1c PASSWORD='<пароль обмена>' bash packages/backend/scripts/exchange-curl.sh
```

Ожидается «OK»-прохождение: checkauth (3 строки) → init → file×2 → import (`progress`→`success`) → sale query. Счётчики staging — на сервере:

```bash
docker compose -f docker-compose.prod.yml exec db psql -U fa fa -c "SELECT count(*) FROM products"
```

## 5. Чек-лист после деплоя

- [ ] `https://…/healthz` отвечает 200 по HTTPS, сертификат валиден (замок в браузере).
- [ ] Полный цикл exchange-curl.sh проходит извне.
- [ ] Порты наружу: только 22, 80, 443 (`sudo ss -ltnp` — 5432 и 3000 отсутствуют).
- [ ] Логи ротируются (docker json-file 10m×5 задан в compose; access-лог Caddy — roll 20MiB×5).
- [ ] Бэкап: `bash deploy/backup-db.sh` отрабатывает; строка в `crontab -e` добавлена (пример в шапке скрипта).
- [ ] Лимиты согласованы: `EXCHANGE_FILE_LIMIT` (.env) ≤ `request_body max_size` (deploy/Caddyfile).
- [ ] Баланс Cloud.ru пополнен / бонусы не на нуле.

## 6. Обновление версии

```bash
cd ~/fa
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Данные (pgdata, spool, сертификаты) живут в named volumes и переживают пересборку. Полный сброс БД: `docker compose -f docker-compose.prod.yml down -v` (УНИЧТОЖАЕТ каталог и журнал — только осознанно).

## 7. Подключение 1С (этап 6, после этого деплоя)

В настройке узла «Обмен с сайтом» (1С:Розница, узел «Fashion Avenue») переключить на «Выгрузка на сайт»:
- Адрес: `https://1c-dev.avenuefashion.online/api/1c-exchange`
- Пользователь: `fa-1c`, пароль — из `.env` сервера (передать специалисту защищённо).
- Запуск вручную; расписание — после успешной пробной выгрузки.

Диагностика при ошибках обмена: журнал запросов — таблица `exchange_log` (`docker compose … exec db psql -U fa fa -c "SELECT * FROM exchange_log ORDER BY id DESC LIMIT 20"`), access-лог Caddy, логи backend (`docker compose … logs backend`).

## 6. Админка брендов (`/admin`)

Подробности — `docs/admin-brands.md`. Выкатка на уже работающий сервер:

```bash
ssh user1@45.132.178.101
cd ~/fa
git pull
nano .env     # дописать (шаблон — в .env.production.example):
              #   ADMIN_LOGIN=fa-admin
              #   ADMIN_PASSWORD=<openssl rand -base64 18>
              #   PUBLIC_BASE_URL=https://1c-dev.avenuefashion.online
docker compose -f docker-compose.prod.yml up -d --build backend
docker compose -f docker-compose.prod.yml ps
```

Миграция `004_site_brands.sql` применится сама при старте backend (если задан `ADMIN_LOGIN`) или при первом обращении к API. Пересборка backend не трогает
БД и spool, но на время рестарта (несколько секунд) приёмник недоступен — не выкатывать во время сеанса обмена с 1С.

Проверка:

- [ ] `curl -s https://1c-dev.avenuefashion.online/api/brands?gender=men` → `{"gender":"men","top":[],"all":[]}`.
- [ ] `https://1c-dev.avenuefashion.online/admin` просит логин/пароль, после входа открывается «Обзор».
- [ ] В «Обзоре» нажать «Загрузить список брендов сайта» → API отдаёт 5 топ-брендов и список по разделам.
- [ ] Загрузить фото одному бренду → `photo` в API — рабочая ссылка `https://…/uploads/<16 hex>.<ext>`.
- [ ] Volume `uploads` включён в план бэкапов.
