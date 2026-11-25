-- AA 账本数据库结构。金额一律用"分"（整数）保存。
CREATE TABLE IF NOT EXISTS admins (
  id         serial PRIMARY KEY,
  username   text NOT NULL UNIQUE,
  pw_hash    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token      text PRIMARY KEY,
  admin_id   int NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS login_fails (
  key      text PRIMARY KEY,
  count    int NOT NULL,
  first_at timestamptz NOT NULL
);

-- 人：跨活动共用（同名即同一个人），收款码挂在人身上
CREATE TABLE IF NOT EXISTS people (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pay_codes (
  person_id  int  NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('wechat','alipay')),
  file       text NOT NULL,
  mime       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, kind)
);

-- 一次游玩。key 是分享链接里的密钥，拿到链接就能查看和记账
CREATE TABLE IF NOT EXISTS trips (
  id         serial PRIMARY KEY,
  key        text NOT NULL UNIQUE,
  name       text NOT NULL,
  start_day  date NOT NULL,
  end_day    date,
  note       text NOT NULL DEFAULT '',
  locked     boolean NOT NULL DEFAULT false,
  locked_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 参加这次游玩的人；weight 是默认份数（如带家属算 2 份）
CREATE TABLE IF NOT EXISTS members (
  id         serial PRIMARY KEY,
  trip_id    int NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  person_id  int NOT NULL REFERENCES people(id),
  weight     numeric(5,2) NOT NULL DEFAULT 1 CHECK (weight > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, person_id)
);

CREATE TABLE IF NOT EXISTS expenses (
  id         serial PRIMARY KEY,
  trip_id    int  NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  payer_id   int  NOT NULL REFERENCES members(id),
  cents      int  NOT NULL CHECK (cents > 0),
  category   text NOT NULL,
  title      text NOT NULL DEFAULT '',
  note       text NOT NULL DEFAULT '',
  day        date NOT NULL,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_trip ON expenses(trip_id);

-- 每笔里每个人分摊多少：fixed_cents 不为空 = 指定金额；否则按 weight 分剩下的。cents 是算好的结果
CREATE TABLE IF NOT EXISTS expense_shares (
  expense_id  int NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id   int NOT NULL REFERENCES members(id),
  weight      numeric(5,2) NOT NULL DEFAULT 1,
  fixed_cents int,
  cents       int NOT NULL,
  PRIMARY KEY (expense_id, member_id)
);

CREATE TABLE IF NOT EXISTS images (
  id         serial PRIMARY KEY,
  expense_id int  NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  file       text NOT NULL,
  mime       text NOT NULL,
  bytes      int  NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS images_expense ON images(expense_id);

-- 结算时的转账（标记"已转"）
CREATE TABLE IF NOT EXISTS payments (
  id         serial PRIMARY KEY,
  trip_id    int NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  from_id    int NOT NULL REFERENCES members(id),
  to_id      int NOT NULL REFERENCES members(id),
  cents      int NOT NULL CHECK (cents > 0),
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit (
  id      bigserial PRIMARY KEY,
  trip_id int  NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  at      timestamptz NOT NULL DEFAULT now(),
  actor   text NOT NULL,
  action  text NOT NULL,
  detail  text NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_trip ON audit(trip_id, id);

-- ===== v2：多币种。结算统一用人民币（cents 一律是人民币分） =====
-- orig_cents = 原币金额（×100），rate = 1 单位原币折合多少人民币；cny_override = 直接填了实付人民币（如刷卡账单），不按汇率算
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'CNY';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS orig_cents int;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS rate numeric(16,8) NOT NULL DEFAULT 1;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS cny_override boolean NOT NULL DEFAULT false;
UPDATE expenses SET orig_cents = cents WHERE orig_cents IS NULL;
-- 每人分摊的原币金额；fixed_cents 是原币的指定金额
ALTER TABLE expense_shares ADD COLUMN IF NOT EXISTS orig_cents int;
UPDATE expense_shares SET orig_cents = cents WHERE orig_cents IS NULL;

-- 每次游玩各币种的汇率（同一次游玩里同一币种用同一个汇率）
CREATE TABLE IF NOT EXISTS trip_rates (
  trip_id    int  NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  currency   text NOT NULL,
  rate       numeric(16,8) NOT NULL CHECK (rate > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, currency)
);
-- 市场参考汇率缓存
CREATE TABLE IF NOT EXISTS fx_cache (
  currency   text PRIMARY KEY,
  rate       numeric(16,8) NOT NULL,
  source_at  timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
