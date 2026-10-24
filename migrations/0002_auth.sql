CREATE TABLE IF NOT EXISTS auth_admin (id INTEGER PRIMARY KEY CHECK(id=1), password_hash TEXT NOT NULL, session_version INTEGER NOT NULL DEFAULT 1 CHECK(session_version >= 1), updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, session_version INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at > created_at));
CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE IF NOT EXISTS gateway_api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, preview TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER, last_used_at INTEGER);
CREATE INDEX IF NOT EXISTS gateway_api_keys_created ON gateway_api_keys(created_at DESC);
CREATE TABLE IF NOT EXISTS login_attempts (ip_hash TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL CHECK(attempts >= 1));
CREATE INDEX IF NOT EXISTS login_attempts_window ON login_attempts(window_start);
