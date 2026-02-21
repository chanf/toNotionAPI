-- WX2Notion PostgreSQL schema draft (MVP)
-- Created at: 2026-02-20

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Basic user identity (can map to your auth provider)
CREATE TABLE app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_user_id TEXT UNIQUE NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_app_users_updated_at
BEFORE UPDATE ON app_users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Store Notion OAuth tokens (encrypted at application layer)
CREATE TABLE notion_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  workspace_name TEXT,
  bot_id TEXT,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

CREATE TRIGGER trg_notion_connections_updated_at
BEFORE UPDATE ON notion_connections
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  target_page_id TEXT,
  target_page_title TEXT,
  content_mode TEXT NOT NULL DEFAULT 'LINK_AND_CONTENT'
    CHECK (content_mode IN ('LINK_ONLY', 'LINK_AND_CONTENT')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

CREATE TRIGGER trg_user_settings_updated_at
BEFORE UPDATE ON user_settings
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE article_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  client_item_id TEXT,
  source_url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('wechat_mp')),
  raw_text TEXT,

  -- parsed metadata
  title TEXT,
  summary TEXT,
  cover_url TEXT,
  content_plaintext TEXT,
  content_blocks JSONB,

  -- state machine
  status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED', 'PARSING', 'PARSE_FAILED', 'SYNCING', 'SYNC_FAILED', 'SYNCED')),

  -- notion mapping
  notion_page_id TEXT,
  notion_page_url TEXT,
  idempotency_hash TEXT NOT NULL,

  -- diagnostics
  parse_error_code TEXT,
  parse_error_message TEXT,
  sync_error_code TEXT,
  sync_error_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, normalized_url),
  UNIQUE (user_id, idempotency_hash)
);

CREATE INDEX idx_article_items_user_status_created
  ON article_items(user_id, status, created_at DESC);

CREATE INDEX idx_article_items_user_created
  ON article_items(user_id, created_at DESC);

CREATE TRIGGER trg_article_items_updated_at
BEFORE UPDATE ON article_items
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES article_items(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('PARSE', 'SYNC')),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sync_jobs_status_next_run
  ON sync_jobs(status, next_run_at);

CREATE INDEX idx_sync_jobs_item_job_type
  ON sync_jobs(item_id, job_type);

CREATE TRIGGER trg_sync_jobs_updated_at
BEFORE UPDATE ON sync_jobs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE sync_attempts (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES sync_jobs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  result_status TEXT NOT NULL
    CHECK (result_status IN ('SUCCEEDED', 'FAILED', 'RETRIABLE_FAILED')),
  error_code TEXT,
  error_message TEXT,
  trace_id TEXT,
  latency_ms INTEGER,
  response_payload JSONB
);

CREATE INDEX idx_sync_attempts_job_attempt_no
  ON sync_attempts(job_id, attempt_no DESC);

-- OAuth state records to validate callback and prevent replay
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  redirect_uri TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_oauth_states_expires_at
  ON oauth_states(expires_at);
