CREATE TABLE IF NOT EXISTS article_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_item_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('wechat_mp')),
  raw_text TEXT,
  title TEXT,
  summary TEXT,
  cover_url TEXT,
  content_plaintext TEXT,
  status TEXT NOT NULL CHECK (status IN ('RECEIVED', 'PARSING', 'PARSE_FAILED', 'SYNCING', 'SYNC_FAILED', 'SYNCED')),
  notion_page_id TEXT,
  notion_page_url TEXT,
  error_code TEXT,
  error_message TEXT,
  error_retriable INTEGER,
  error_trace_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, normalized_url)
);

CREATE INDEX IF NOT EXISTS idx_article_items_user_status_created
ON article_items(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_article_items_user_created
ON article_items(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  notion_connected INTEGER NOT NULL DEFAULT 0,
  workspace_name TEXT,
  target_database_id TEXT,
  target_database_title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at
ON oauth_states(expires_at);
