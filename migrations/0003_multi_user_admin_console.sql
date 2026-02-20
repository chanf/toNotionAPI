CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('SUPER_ADMIN', 'USER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED', 'DELETED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_app_users_status_created
ON app_users(status, created_at DESC);

INSERT INTO app_users (id, display_name, role, status, created_at, updated_at, deleted_at)
SELECT DISTINCT src.user_id, NULL, 'USER', 'ACTIVE', datetime('now'), datetime('now'), NULL
FROM (
  SELECT user_id FROM api_access_tokens
  UNION
  SELECT user_id FROM user_settings
  UNION
  SELECT user_id FROM article_items
) AS src
WHERE src.user_id IS NOT NULL
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_notion_credentials (
  user_id TEXT PRIMARY KEY,
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  token_tag TEXT NOT NULL,
  token_hint TEXT,
  api_version TEXT NOT NULL DEFAULT '2022-06-28',
  api_base_url TEXT NOT NULL DEFAULT 'https://api.notion.com/v1',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES app_users(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created
ON audit_logs(actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created
ON audit_logs(action, created_at DESC);
