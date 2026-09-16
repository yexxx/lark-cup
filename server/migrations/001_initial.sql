CREATE TABLE IF NOT EXISTS users (
 id text PRIMARY KEY, name text NOT NULL, role text NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS competition (
 id integer PRIMARY KEY CHECK(id=1), data jsonb NOT NULL
);
INSERT INTO competition VALUES (1, '{"title":"百灵鸟杯","tagline":"一只百灵鸟，无限种可能。","description":"用 AI，让想象自由鸣唱。一个主题，不同模型，创造属于你的百灵鸟世界。","prompt":"用 HTML、CSS 和 JavaScript 创作一只会唱歌的百灵鸟。让它拥有独特的性格，并加入至少一种可交互的体验。","rules":"原创 AI 辅助作品；Classic 赛道使用统一提示词，Open 赛道自由创作。提交自包含 HTML，不依赖外部网络。作品审核通过后进入展区，评选期间作者匿名。禁止刷票，违规票经审核后作废。","prizes":"金羽奖 · Classic 赛道第一名\n灵感奖 · Open 赛道第一名\n人气奖 · 双赛道人气作品\n具体奖品由主办方公布。","submissionStart":"2026-01-01T00:00:00+08:00","submissionEnd":"2026-12-20T23:59:59+08:00","voteStart":"2026-01-01T00:00:00+08:00","voteEnd":"2026-12-31T23:59:59+08:00","dailyLimit":10,"nextDailyLimit":null,"limitEffectiveDate":null}'::jsonb) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS tracks (id text PRIMARY KEY, name text NOT NULL);
INSERT INTO tracks VALUES ('classic','Classic'),('open','Open') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS assets (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), kind text NOT NULL CHECK(kind IN ('html','cover')),
 filename text NOT NULL UNIQUE, mime text NOT NULL, bytes integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS works (
 id uuid PRIMARY KEY, number bigserial UNIQUE, owner_id text NOT NULL REFERENCES users(id), track text NOT NULL REFERENCES tracks(id),
 title text NOT NULL, description text NOT NULL, model text NOT NULL, prompt text NOT NULL,
 cover_id uuid REFERENCES assets(id), html_id uuid REFERENCES assets(id),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','approved','rejected','withdrawn')),
 reason text NOT NULL DEFAULT '', recommended boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS works_gallery ON works(status, track, created_at DESC);
CREATE INDEX IF NOT EXISTS works_owner ON works(owner_id);
CREATE TABLE IF NOT EXISTS work_versions (
 id bigserial PRIMARY KEY, work_id uuid NOT NULL REFERENCES works(id), version integer NOT NULL, snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(work_id, version)
);
CREATE TABLE IF NOT EXISTS reviews (
 id bigserial PRIMARY KEY, work_id uuid NOT NULL REFERENCES works(id), actor_id text NOT NULL REFERENCES users(id),
 decision text NOT NULL, reason text NOT NULL, version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS daily_quotas (
 user_id text NOT NULL REFERENCES users(id), track text NOT NULL REFERENCES tracks(id), day date NOT NULL,
 used integer NOT NULL DEFAULT 0 CHECK(used>=0), PRIMARY KEY(user_id, track, day)
);
CREATE TABLE IF NOT EXISTS votes (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), work_id uuid NOT NULL REFERENCES works(id),
 track text NOT NULL REFERENCES tracks(id), day date NOT NULL, idempotency_key uuid NOT NULL,
 valid boolean NOT NULL DEFAULT true, void_reason text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id, work_id, day), UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS votes_work_valid ON votes(work_id) WHERE valid;
CREATE INDEX IF NOT EXISTS votes_user_day ON votes(user_id,day);
CREATE TABLE IF NOT EXISTS audit_logs (
 id bigserial PRIMARY KEY, actor_id text NOT NULL REFERENCES users(id), action text NOT NULL,
 target text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
