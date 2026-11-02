export const AUTH_DDL = String.raw`-- Покупатели и авторизация ЛК. Гостевые заказы не переносятся.
CREATE TABLE IF NOT EXISTS customer_accounts (
  id bigserial PRIMARY KEY,
  phone text NOT NULL UNIQUE CHECK (phone ~ '^\+7[0-9]{10}$'),
  name text CHECK (name IS NULL OR char_length(name) BETWEEN 2 AND 100),
  email text CHECK (email IS NULL OR (email = lower(email) AND char_length(email) <= 254)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id uuid PRIMARY KEY,
  phone text NOT NULL CHECK (phone ~ '^\+7[0-9]{10}$'),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  state text NOT NULL CHECK (state IN ('pending', 'active', 'used')),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_challenges_phone_idx ON auth_challenges (phone);
CREATE INDEX IF NOT EXISTS auth_challenges_expiry_idx ON auth_challenges (expires_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id bigint NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at);

CREATE TABLE IF NOT EXISTS auth_limits (
  key text PRIMARY KEY,
  count integer NOT NULL CHECK (count > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_limits_expiry_idx ON auth_limits (expires_at);`;
