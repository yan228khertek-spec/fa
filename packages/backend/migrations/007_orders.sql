-- Заказы сайта (трек F1) и согласия на рекламные рассылки.
-- Применяется и автоматически при старте API заказов (PgOrderRepository), и вручную:
-- psql "$DATABASE_URL" -f migrations/007_orders.sql
--
-- Ссылок на staging (001–003) нет: позиция заказа хранит Ид SKU 1С и СНИМОК названия,
-- размера и цены на момент заказа — обмен с 1С заказы не меняет. Поля под выгрузку в 1С
-- (F2), статусы из 1С (F3), оплату ЮKassa (F4), личный кабинет (F5) и программу
-- лояльности заложены сразу и в v1 пустые, чтобы эти шаги не требовали новой миграции.
CREATE TABLE IF NOT EXISTS orders (
  id                  bigserial PRIMARY KEY,
  -- Номер для покупателя: FA- и 8 случайных цифр (не инкремент, в URL не используется).
  number              text NOT NULL,
  -- Неугадываемый токен страницы «Спасибо» и будущего return_url оплаты.
  public_token        text NOT NULL,
  -- Ключ из заголовка Idempotency-Key и хеш нормализованного запроса: повтор не плодит дубль.
  idempotency_key     text NOT NULL,
  request_hash        text NOT NULL,
  -- Аккаунт покупателя (F5, миграция 008+). NULL — гостевой заказ; FK появится вместе с users.
  user_id             bigint,
  status              text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed',
                        'processing', 'ready_for_pickup', 'shipped', 'delivered', 'completed',
                        'cancelled')),
  payment_method      text NOT NULL CHECK (payment_method IN ('on_receipt', 'online')),
  payment_status      text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid',
                        'pending', 'paid', 'canceled', 'refunded', 'partially_refunded')),
  customer_name       text NOT NULL,
  -- Телефон как ввёл покупатель и нормализованный +7XXXXXXXXXX — ключ склейки с аккаунтом (F5).
  customer_phone      text NOT NULL,
  phone_normalized    text NOT NULL CHECK (phone_normalized ~ '^\+7[0-9]{10}$'),
  customer_email      text NOT NULL CHECK (customer_email = lower(customer_email)),
  comment             text,
  delivery_method     text NOT NULL CHECK (delivery_method IN ('pickup', 'cdek')),
  delivery_city       text,
  delivery_address    text,
  delivery_pvz_code   text,
  -- Данные интеграции СДЭК (расчёт, ПВЗ, трек-номер) — после v1.
  delivery_data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  currency            text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  -- УСН: «без НДС» (для чека 54-ФЗ в F4).
  vat_mode            text NOT NULL DEFAULT 'none' CHECK (vat_mode = 'none'),
  items_total         numeric(14,2) NOT NULL CHECK (items_total > 0),
  delivery_cost       numeric(14,2) NOT NULL DEFAULT 0 CHECK (delivery_cost >= 0),
  -- Программа лояльности заказчика: сколько бонусов списано (в v1 всегда 0) и id клиента в ней.
  bonus_amount        numeric(14,2) NOT NULL DEFAULT 0 CHECK (bonus_amount >= 0),
  loyalty_account_ref text,
  total               numeric(14,2) NOT NULL CHECK (total >= 0),
  -- Согласие на обработку ПД (152-ФЗ): время сервера и версии документов, показанных покупателю.
  pd_consent_at       timestamptz NOT NULL,
  pd_policy_version   text NOT NULL,
  offer_version       text NOT NULL,
  client_ip           inet,
  user_agent          text,
  -- Статус из 1С как есть (F3) и служебные поля выгрузки в 1С (F2).
  status_1c           text,
  status_1c_at        timestamptz,
  exported_at         timestamptz,
  onec_id             text,
  onec_number         text,
  export_error        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_number_uniq UNIQUE (number),
  CONSTRAINT orders_public_token_uniq UNIQUE (public_token),
  CONSTRAINT orders_idempotency_key_uniq UNIQUE (idempotency_key),
  CONSTRAINT orders_number_format CHECK (number ~ '^FA-[0-9]{8}$'),
  CONSTRAINT orders_total_sum_check CHECK (total = items_total + delivery_cost - bonus_amount),
  CONSTRAINT orders_cdek_address_check CHECK (delivery_method <> 'cdek'
    OR (delivery_city IS NOT NULL AND delivery_address IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at);
CREATE INDEX IF NOT EXISTS orders_phone_idx ON orders (phone_normalized);
CREATE INDEX IF NOT EXISTS orders_email_idx ON orders (customer_email);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id) WHERE user_id IS NOT NULL;
-- Очередь выгрузки в 1С (F2): невыгруженные заказы по времени создания.
CREATE INDEX IF NOT EXISTS orders_not_exported_idx ON orders (created_at) WHERE exported_at IS NULL;

-- Позиции заказа: снимок на момент оформления. card_id без FK — карточку могут удалить,
-- заказ должен остаться. variant_source_id = Ид#ИдХарактеристики — ключ для sale:query (F2).
CREATE TABLE IF NOT EXISTS order_items (
  id                bigserial PRIMARY KEY,
  order_id          bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no           integer NOT NULL CHECK (line_no > 0),
  card_id           bigint,
  model_source_id   text NOT NULL,
  variant_source_id text NOT NULL,
  article           text,
  title             text NOT NULL,
  name_1c           text,
  size              text,
  color             text,
  price             numeric(14,2) NOT NULL CHECK (price > 0),
  quantity          integer NOT NULL CHECK (quantity > 0),
  amount            numeric(14,2) NOT NULL,
  CONSTRAINT order_items_line_uniq UNIQUE (order_id, line_no),
  CONSTRAINT order_items_amount_check CHECK (amount = price * quantity)
);
CREATE INDEX IF NOT EXISTS order_items_variant_idx ON order_items (variant_source_id);

-- Платежи (F4, ЮKassa): на один заказ бывает несколько попыток. В v1 пустая.
CREATE TABLE IF NOT EXISTS order_payments (
  id                  bigserial PRIMARY KEY,
  order_id            bigint NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider            text NOT NULL,
  provider_payment_id text,
  idempotency_key     text NOT NULL,
  status              text NOT NULL,
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  refunded_amount     numeric(14,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  currency            text NOT NULL DEFAULT 'RUB',
  -- Чек 54-ФЗ, отправленный провайдеру, и последний ответ/уведомление провайдера.
  receipt             jsonb,
  raw                 jsonb,
  paid_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_payments_provider_uniq UNIQUE (provider, provider_payment_id),
  CONSTRAINT order_payments_idempotency_uniq UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS order_payments_order_idx ON order_payments (order_id);

-- История смены статусов: сайт, 1С (F3), оплата (F4), админка. v1 пишет создание заказа.
CREATE TABLE IF NOT EXISTS order_status_history (
  id         bigserial PRIMARY KEY,
  order_id   bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  field      text NOT NULL CHECK (field IN ('status', 'payment_status', 'status_1c')),
  old_value  text,
  new_value  text NOT NULL,
  source     text NOT NULL CHECK (source IN ('site', '1c', 'payment', 'admin')),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_status_history_order_idx ON order_status_history (order_id, created_at);

-- Согласия на рекламные рассылки — ЗАПИСЯМИ, не флагом: доказывать согласие придётся
-- заказчику (152-ФЗ, закон о рекламе), нужна история выдачи и отзыва. Строка пишется,
-- только если покупатель сам поставил галочку. Отзыв — revoked_at + способ, строку не удаляем.
CREATE TABLE IF NOT EXISTS marketing_consents (
  id                   bigserial PRIMARY KEY,
  email                text NOT NULL CHECK (email = lower(email)),
  phone_normalized     text CHECK (phone_normalized ~ '^\+7[0-9]{10}$'),
  user_id              bigint,
  order_id             bigint REFERENCES orders(id) ON DELETE SET NULL,
  source               text NOT NULL CHECK (source ~ '^[a-z_]{1,32}$'),
  consent_text_version text NOT NULL,
  granted_at           timestamptz NOT NULL DEFAULT now(),
  ip                   inet,
  user_agent           text,
  revoked_at           timestamptz,
  revoke_method        text,
  CONSTRAINT marketing_consents_revoke_check CHECK ((revoked_at IS NULL) = (revoke_method IS NULL))
);
CREATE INDEX IF NOT EXISTS marketing_consents_email_idx ON marketing_consents (email);
CREATE INDEX IF NOT EXISTS marketing_consents_phone_idx ON marketing_consents (phone_normalized);
