CREATE TABLE IF NOT EXISTS api_access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  scopes TEXT NOT NULL DEFAULT '*',
  is_active INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_access_tokens_user_active
ON api_access_tokens(user_id, is_active);
