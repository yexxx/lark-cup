CREATE TABLE auth_identities (
 provider text NOT NULL, subject text NOT NULL, user_id text NOT NULL REFERENCES users(id),
 PRIMARY KEY(provider,subject), UNIQUE(user_id,provider)
);
CREATE TABLE local_credentials (
 user_id text PRIMARY KEY REFERENCES users(id), password_hash text NOT NULL
);
CREATE TABLE auth_sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE INDEX auth_sessions_activity ON auth_sessions(last_seen_at);
