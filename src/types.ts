export const ITEM_STATUSES = [
  "RECEIVED",
  "PARSING",
  "PARSE_FAILED",
  "SYNCING",
  "SYNC_FAILED",
  "SYNCED"
] as const;

export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const APP_USER_ROLES = ["SUPER_ADMIN", "USER"] as const;
export type AppUserRole = (typeof APP_USER_ROLES)[number];

export const APP_USER_STATUSES = ["ACTIVE", "DISABLED", "DELETED"] as const;
export type AppUserStatus = (typeof APP_USER_STATUSES)[number];

export interface SyncError {
  code: string;
  message: string;
  retriable: boolean;
  trace_id: string;
}

export interface ArticleItem {
  id: string;
  user_id: string;
  client_item_id: string;
  source_url: string;
  normalized_url: string;
  source_type: "wechat_mp";
  raw_text: string | null;
  title: string | null;
  summary: string | null;
  cover_url: string | null;
  content_plaintext: string | null;
  status: ItemStatus;
  notion_page_id: string | null;
  notion_page_url: string | null;
  error: SyncError | null;
  created_at: string;
  updated_at: string;
}

export interface UserSettings {
  user_id: string;
  notion_connected: boolean;
  workspace_name: string | null;
  target_page_id: string | null;
  target_page_title: string | null;
}

export interface AppUser {
  id: string;
  display_name: string | null;
  role: AppUserRole;
  status: AppUserStatus;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface UserNotionCredential {
  user_id: string;
  token_hint: string | null;
  has_refresh_token: boolean;
  access_token_expires_at: string | null;
  api_version: string;
  api_base_url: string;
  created_at: string;
  updated_at: string;
}

export interface UserNotionCredentialSecret extends UserNotionCredential {
  token_ciphertext: string;
  token_iv: string;
  token_tag: string;
  refresh_token_ciphertext: string | null;
  refresh_token_iv: string | null;
  refresh_token_tag: string | null;
}

export interface AuditLog {
  id: string;
  actor_user_id: string | null;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface OAuthState {
  state: string;
  user_id: string;
  expires_at: string;
}

export interface ApiAccessToken {
  id: string;
  user_id: string;
  token_hash: string;
  label: string | null;
  scopes: string[];
  is_active: boolean;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IngestRequest {
  client_item_id: string;
  source_url: string;
  raw_text?: string;
  source_app?: string;
  source_type?: "wechat_mp";
  notion_api_token?: string;
  notion_api_version?: string;
  notion_api_base_url?: string;
}
