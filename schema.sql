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
ALTER TABLE images ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';   -- 图片备注（最多 200 字）

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

-- ===== v3：结算币种、邀请码 =====
-- 每次游玩的结算币种（分摊、结算、统计都用它）。expenses.cents / payments.cents 都是结算币种的"分"；
-- expenses.rate = 1 单位原币折合多少结算币种；cny_override 现在表示"直接填了实付结算币种金额"
ALTER TABLE trips ADD COLUMN IF NOT EXISTS base_currency text NOT NULL DEFAULT 'CNY';
-- 邀请码：朋友凭邀请码可以自己新建游玩
CREATE TABLE IF NOT EXISTS invites (
  id         serial PRIMARY KEY,
  code       text NOT NULL UNIQUE,
  note       text NOT NULL DEFAULT '',
  uses       int  NOT NULL DEFAULT 0,
  revoked    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE trips ADD COLUMN IF NOT EXISTS invite_id int REFERENCES invites(id) ON DELETE SET NULL;

-- ===== v4：数据安全 =====
-- 删除游玩先进回收站（deleted_at 不为空），30 天后才真正删除；期间管理员可以恢复
ALTER TABLE trips ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
-- 删除的账目 / 截图先放这里（data 是删除前的完整快照，files 是对应的图片文件，文件保留不删），30 天后清理
CREATE TABLE IF NOT EXISTS trash (
  id         serial PRIMARY KEY,
  trip_id    int  NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('expense','image')),
  label      text NOT NULL,
  data       jsonb NOT NULL,
  files      text[] NOT NULL DEFAULT '{}',
  deleted_by text NOT NULL DEFAULT '',
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trash_trip ON trash(trip_id, id);

-- 数据库层面的金额校验（事务提交时检查，不满足就整笔回滚，代码有 bug 也存不进错账）：
--   每笔账至少一人分摊；各人分摊（结算币种、原币）加起来正好等于这笔的金额；没有负数；
--   付款人、分摊人、转账双方都是这次游玩的成员；转账双方不是同一人
CREATE OR REPLACE FUNCTION aa_check_expense() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid int; e record; s record;
BEGIN
  IF TG_TABLE_NAME = 'expenses' THEN
    eid := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    eid := CASE WHEN TG_OP = 'DELETE' THEN OLD.expense_id ELSE NEW.expense_id END;
  END IF;
  SELECT x.id, x.trip_id, x.cents, x.orig_cents, m.trip_id AS payer_trip INTO e
    FROM expenses x JOIN members m ON m.id = x.payer_id WHERE x.id = eid;
  IF NOT FOUND THEN RETURN NULL; END IF;  -- 这笔已经整笔删除
  IF e.payer_trip <> e.trip_id THEN
    RAISE EXCEPTION 'aa_invariant: 账目 % 的付款人不是这次游玩的成员', eid;
  END IF;
  SELECT count(*) AS n, coalesce(sum(es.cents), 0) AS c, coalesce(sum(es.orig_cents), 0) AS o,
         count(*) FILTER (WHERE m.trip_id <> e.trip_id) AS outsider,
         count(*) FILTER (WHERE es.cents < 0 OR es.orig_cents IS NULL OR es.orig_cents < 0) AS neg
    INTO s FROM expense_shares es JOIN members m ON m.id = es.member_id WHERE es.expense_id = eid;
  IF s.n = 0 OR s.c <> e.cents OR s.o <> e.orig_cents OR s.outsider > 0 OR s.neg > 0 THEN
    RAISE EXCEPTION 'aa_invariant: 账目 % 分摊不平（% 人，合计 %/%，总额 %/%）', eid, s.n, s.c, s.o, e.cents, e.orig_cents;
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION aa_check_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.from_id = NEW.to_id
     OR NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.from_id AND trip_id = NEW.trip_id)
     OR NOT EXISTS (SELECT 1 FROM members WHERE id = NEW.to_id AND trip_id = NEW.trip_id) THEN
    RAISE EXCEPTION 'aa_invariant: 转账 % 的双方不对', NEW.id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS aa_expense_check ON expenses;
CREATE CONSTRAINT TRIGGER aa_expense_check AFTER INSERT OR UPDATE ON expenses
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aa_check_expense();
DROP TRIGGER IF EXISTS aa_share_check ON expense_shares;
CREATE CONSTRAINT TRIGGER aa_share_check AFTER INSERT OR UPDATE OR DELETE ON expense_shares
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aa_check_expense();
DROP TRIGGER IF EXISTS aa_payment_check ON payments;
CREATE CONSTRAINT TRIGGER aa_payment_check AFTER INSERT OR UPDATE ON payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aa_check_payment();
