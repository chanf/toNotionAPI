ALTER TABLE user_notion_credentials
ADD COLUMN refresh_token_ciphertext TEXT;

ALTER TABLE user_notion_credentials
ADD COLUMN refresh_token_iv TEXT;

ALTER TABLE user_notion_credentials
ADD COLUMN refresh_token_tag TEXT;

ALTER TABLE user_notion_credentials
ADD COLUMN access_token_expires_at TEXT;
