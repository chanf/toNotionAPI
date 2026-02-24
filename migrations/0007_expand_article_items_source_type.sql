-- Expand article_items.source_type to support non-WeChat URLs.
-- SQLite/D1 doesn't support altering CHECK constraints in-place, so we rebuild the table.

PRAGMA foreign_keys=OFF;

ALTER TABLE article_items RENAME TO article_items_old;

CREATE TABLE IF NOT EXISTS article_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_item_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('wechat_mp', 'generic_web')),
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

INSERT INTO article_items (
  id,
  user_id,
  client_item_id,
  source_url,
  normalized_url,
  source_type,
  raw_text,
  title,
  summary,
  cover_url,
  content_plaintext,
  status,
  notion_page_id,
  notion_page_url,
  error_code,
  error_message,
  error_retriable,
  error_trace_id,
  created_at,
  updated_at
)
SELECT
  id,
  user_id,
  client_item_id,
  source_url,
  normalized_url,
  source_type,
  raw_text,
  title,
  summary,
  cover_url,
  content_plaintext,
  status,
  notion_page_id,
  notion_page_url,
  error_code,
  error_message,
  error_retriable,
  error_trace_id,
  created_at,
  updated_at
FROM article_items_old;

DROP TABLE article_items_old;

CREATE INDEX IF NOT EXISTS idx_article_items_user_status_created
ON article_items(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_article_items_user_created
ON article_items(user_id, created_at DESC);

PRAGMA foreign_keys=ON;

