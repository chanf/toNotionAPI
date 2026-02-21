CREATE TABLE user_notion_credentials_next (
  user_id TEXT PRIMARY KEY,
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  token_tag TEXT NOT NULL,
  token_hint TEXT,
  api_version TEXT NOT NULL DEFAULT '2025-09-03',
  api_base_url TEXT NOT NULL DEFAULT 'https://api.notion.com/v1',
  refresh_token_ciphertext TEXT,
  refresh_token_iv TEXT,
  refresh_token_tag TEXT,
  access_token_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES app_users(id)
);

INSERT INTO user_notion_credentials_next (
  user_id,
  token_ciphertext,
  token_iv,
  token_tag,
  token_hint,
  api_version,
  api_base_url,
  refresh_token_ciphertext,
  refresh_token_iv,
  refresh_token_tag,
  access_token_expires_at,
  created_at,
  updated_at
)
SELECT
  user_id,
  token_ciphertext,
  token_iv,
  token_tag,
  token_hint,
  api_version,
  api_base_url,
  refresh_token_ciphertext,
  refresh_token_iv,
  refresh_token_tag,
  access_token_expires_at,
  created_at,
  updated_at
FROM user_notion_credentials;

DROP TABLE user_notion_credentials;
ALTER TABLE user_notion_credentials_next RENAME TO user_notion_credentials;
