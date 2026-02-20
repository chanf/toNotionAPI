export const ITEM_STATUSES = [
  "RECEIVED",
  "PARSING",
  "PARSE_FAILED",
  "SYNCING",
  "SYNC_FAILED",
  "SYNCED"
] as const;

export type ItemStatus = (typeof ITEM_STATUSES)[number];

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
}
