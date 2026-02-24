import type { D1Database } from "./d1";
import type {
  AuditLog,
  AppUser,
  AppUserRole,
  AppUserStatus,
  ApiAccessToken,
  ArticleItem,
  ItemStatus,
  OAuthState,
  SourceType,
  SyncError,
  UserNotionCredential,
  UserNotionCredentialSecret,
  UserSettings
} from "./types";
import { normalizeUrl, nowIso, randomId, sha256Hex } from "./utils";

type ListResult = { items: ArticleItem[]; nextPageToken: string | null };

type ArticleRow = {
  id: string;
  user_id: string;
  client_item_id: string;
  source_url: string;
  normalized_url: string;
  source_type: SourceType;
  raw_text: string | null;
  title: string | null;
  summary: string | null;
  cover_url: string | null;
  content_plaintext: string | null;
  status: ItemStatus;
  notion_page_id: string | null;
  notion_page_url: string | null;
  error_code: string | null;
  error_message: string | null;
  error_retriable: number | null;
  error_trace_id: string | null;
  created_at: string;
  updated_at: string;
};

type SettingsRow = {
  user_id: string;
  notion_connected: number;
  workspace_name: string | null;
  target_page_id: string | null;
  target_page_title: string | null;
};

type OAuthRow = {
  state: string;
  user_id: string;
  expires_at: string;
};

type AccessTokenRow = {
  id: string;
  user_id: string;
  token_hash: string;
  label: string | null;
  scopes: string;
  is_active: number;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

type AppUserRow = {
  id: string;
  display_name: string | null;
  role: AppUserRole;
  status: AppUserStatus;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type UserNotionCredentialRow = {
  user_id: string;
  token_ciphertext: string;
  token_iv: string;
  token_tag: string;
  refresh_token_ciphertext: string | null;
  refresh_token_iv: string | null;
  refresh_token_tag: string | null;
  token_hint: string | null;
  access_token_expires_at: string | null;
  api_version: string;
  api_base_url: string;
  created_at: string;
  updated_at: string;
};

type AuditLogRow = {
  id: string;
  actor_user_id: string | null;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata_json: string | null;
  created_at: string;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function oauthExpired(expiresAtIso: string, nowIsoValue: string): boolean {
  return Date.parse(expiresAtIso) < Date.parse(nowIsoValue);
}

function rowToItem(row: ArticleRow): ArticleItem {
  const error: SyncError | null = row.error_code
    ? {
        code: row.error_code,
        message: row.error_message ?? "",
        retriable: Boolean(row.error_retriable),
        trace_id: row.error_trace_id ?? ""
      }
    : null;

  return {
    id: row.id,
    user_id: row.user_id,
    client_item_id: row.client_item_id,
    source_url: row.source_url,
    normalized_url: row.normalized_url,
    source_type: row.source_type,
    raw_text: row.raw_text,
    title: row.title,
    summary: row.summary,
    cover_url: row.cover_url,
    content_plaintext: row.content_plaintext,
    status: row.status,
    notion_page_id: row.notion_page_id,
    notion_page_url: row.notion_page_url,
    error,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function rowToSettings(row: SettingsRow): UserSettings {
  return {
    user_id: row.user_id,
    notion_connected: Boolean(row.notion_connected),
    workspace_name: row.workspace_name,
    target_page_id: row.target_page_id,
    target_page_title: row.target_page_title
  };
}

function normalizeScopes(scopes: string[]): string[] {
  const cleaned = scopes
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
  return cleaned.length > 0 ? [...new Set(cleaned)] : ["*"];
}

function scopesToText(scopes: string[]): string {
  return normalizeScopes(scopes).join(",");
}

function scopesFromText(text: string | null): string[] {
  if (!text) {
    return ["*"];
  }
  return normalizeScopes(text.split(","));
}

function rowToAccessToken(row: AccessTokenRow): ApiAccessToken {
  return {
    id: row.id,
    user_id: row.user_id,
    token_hash: row.token_hash,
    label: row.label,
    scopes: scopesFromText(row.scopes),
    is_active: Boolean(row.is_active),
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function rowToAppUser(row: AppUserRow): AppUser {
  return {
    id: row.id,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at
  };
}

function rowToUserNotionCredential(row: UserNotionCredentialRow): UserNotionCredential {
  return {
    user_id: row.user_id,
    token_hint: row.token_hint,
    has_refresh_token: Boolean(
      row.refresh_token_ciphertext && row.refresh_token_iv && row.refresh_token_tag
    ),
    access_token_expires_at: row.access_token_expires_at,
    api_version: row.api_version,
    api_base_url: row.api_base_url,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function rowToUserNotionCredentialSecret(row: UserNotionCredentialRow): UserNotionCredentialSecret {
  return {
    ...rowToUserNotionCredential(row),
    token_ciphertext: row.token_ciphertext,
    token_iv: row.token_iv,
    token_tag: row.token_tag,
    refresh_token_ciphertext: row.refresh_token_ciphertext,
    refresh_token_iv: row.refresh_token_iv,
    refresh_token_tag: row.refresh_token_tag
  };
}

function rowToAuditLog(row: AuditLogRow): AuditLog {
  return {
    id: row.id,
    actor_user_id: row.actor_user_id,
    actor_role: row.actor_role,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    metadata_json: row.metadata_json,
    created_at: row.created_at
  };
}

async function checkedRun(db: D1Database, query: string, params: unknown[] = []): Promise<void> {
  const result = await db.prepare(query).bind(...params).run();
  if (!result.success) {
    throw new Error(result.error ?? "D1 run failed.");
  }
}

async function checkedFirst<T>(
  db: D1Database,
  query: string,
  params: unknown[] = []
): Promise<T | null> {
  return db.prepare(query).bind(...params).first<T>();
}

async function checkedAll<T>(db: D1Database, query: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.prepare(query).bind(...params).all<T>();
  if (!result.success) {
    throw new Error(result.error ?? "D1 all failed.");
  }
  return result.results ?? [];
}

export interface Store {
  ensureUser(input: {
    userId: string;
    role?: AppUserRole;
    displayName?: string | null;
  }): Promise<AppUser>;
  getUser(userId: string): Promise<AppUser | null>;
  listUsers(input?: { status?: AppUserStatus | null }): Promise<AppUser[]>;
  updateUser(input: {
    userId: string;
    status?: AppUserStatus;
    displayName?: string | null;
  }): Promise<AppUser | null>;
  deleteUser(userId: string): Promise<boolean>;
  ingestItem(input: {
    userId: string;
    clientItemId: string;
    sourceUrl: string;
    rawText: string | null;
    sourceType: SourceType;
  }): Promise<{ item: ArticleItem; duplicated: boolean }>;
  listItems(input: {
    userId: string;
    status: ItemStatus | null;
    pageSize: number;
    pageToken: string | null;
  }): Promise<ListResult>;
  getItem(input: { userId: string; itemId: string }): Promise<ArticleItem | null>;
  patchItem(input: {
    userId: string;
    itemId: string;
    fields: Partial<ArticleItem>;
  }): Promise<ArticleItem | null>;
  setError(input: {
    userId: string;
    itemId: string;
    status: ItemStatus;
    code: string;
    message: string;
    retriable: boolean;
    traceId: string;
  }): Promise<ArticleItem | null>;
  upsertSettings(input: {
    userId: string;
    targetPageId: string;
    targetPageTitle: string | null;
  }): Promise<UserSettings>;
  getSettings(userId: string): Promise<UserSettings>;
  markNotionConnected(input: { userId: string; workspaceName: string }): Promise<UserSettings>;
  createOAuthState(input: {
    state: string;
    userId: string;
    expiresAt: string;
  }): Promise<OAuthState>;
  consumeOAuthState(input: { state: string; now: string }): Promise<OAuthState | null>;
  upsertUserNotionCredential(input: {
    userId: string;
    tokenCiphertext: string;
    tokenIv: string;
    tokenTag: string;
    refreshTokenCiphertext?: string | null;
    refreshTokenIv?: string | null;
    refreshTokenTag?: string | null;
    tokenHint: string | null;
    accessTokenExpiresAt?: string | null;
    apiVersion: string;
    apiBaseUrl: string;
  }): Promise<UserNotionCredential>;
  getUserNotionCredential(userId: string): Promise<UserNotionCredential | null>;
  getUserNotionCredentialSecret(userId: string): Promise<UserNotionCredentialSecret | null>;
  deleteUserNotionCredential(userId: string): Promise<boolean>;
  appendAuditLog(input: {
    actorUserId: string | null;
    actorRole: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    metadataJson?: string | null;
  }): Promise<void>;
  listAuditLogs(input?: {
    limit?: number;
    pageToken?: string | null;
    actorUserId?: string | null;
    action?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    createdFrom?: string | null;
    createdTo?: string | null;
  }): Promise<AuditLog[]>;
  issueAccessToken(input: {
    userId: string;
    label: string | null;
    scopes: string[];
    expiresAt: string | null;
  }): Promise<{ plainToken: string; token: ApiAccessToken }>;
  listAccessTokens(input: {
    userId?: string | null;
    isActive?: boolean | null;
  }): Promise<ApiAccessToken[]>;
  revokeAccessToken(input: { tokenId: string }): Promise<boolean>;
  getAccessTokenById(tokenId: string): Promise<ApiAccessToken | null>;
  getAccessTokenByHash(tokenHash: string): Promise<ApiAccessToken | null>;
  touchAccessToken(tokenId: string, atIso: string): Promise<void>;
}

export class InMemoryStore implements Store {
  private users = new Map<string, AppUser>();
  private items = new Map<string, ArticleItem>();
  private userItemIds = new Map<string, string[]>();
  private urlIndex = new Map<string, string>();
  private settings = new Map<string, UserSettings>();
  private oauthStates = new Map<string, OAuthState>();
  private userNotionCredentials = new Map<
    string,
    UserNotionCredentialRow
  >();
  private accessTokens = new Map<string, ApiAccessToken>();
  private tokenHashIndex = new Map<string, string>();
  private auditLogs: AuditLog[] = [];

  private getUrlIndexKey(userId: string, normalizedUrl: string): string {
    return `${userId}::${normalizedUrl}`;
  }

  private ensureSettings(userId: string): UserSettings {
    const existing = this.settings.get(userId);
    if (existing) {
      return existing;
    }
    const created: UserSettings = {
      user_id: userId,
      notion_connected: false,
      workspace_name: null,
      target_page_id: null,
      target_page_title: null
    };
    this.settings.set(userId, created);
    return created;
  }

  async ensureUser(input: {
    userId: string;
    role?: AppUserRole;
    displayName?: string | null;
  }): Promise<AppUser> {
    const existing = this.users.get(input.userId);
    if (existing) {
      return clone(existing);
    }
    const now = nowIso();
    const created: AppUser = {
      id: input.userId,
      display_name: input.displayName ?? null,
      role: input.role ?? "USER",
      status: "ACTIVE",
      created_at: now,
      updated_at: now,
      deleted_at: null
    };
    this.users.set(created.id, created);
    return clone(created);
  }

  async getUser(userId: string): Promise<AppUser | null> {
    const user = this.users.get(userId);
    return user ? clone(user) : null;
  }

  async listUsers(input?: { status?: AppUserStatus | null }): Promise<AppUser[]> {
    let users = [...this.users.values()];
    if (input?.status) {
      users = users.filter((user) => user.status === input.status);
    }
    users.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return users.map(clone);
  }

  async updateUser(input: {
    userId: string;
    status?: AppUserStatus;
    displayName?: string | null;
  }): Promise<AppUser | null> {
    const user = this.users.get(input.userId);
    if (!user) {
      return null;
    }
    if (input.status) {
      user.status = input.status;
      user.deleted_at = input.status === "DELETED" ? nowIso() : null;
    }
    if ("displayName" in input) {
      user.display_name = input.displayName ?? null;
    }
    user.updated_at = nowIso();
    this.users.set(user.id, user);
    return clone(user);
  }

  async deleteUser(userId: string): Promise<boolean> {
    const user = this.users.get(userId);
    if (!user) {
      return false;
    }
    user.status = "DELETED";
    user.deleted_at = nowIso();
    user.updated_at = nowIso();
    this.users.set(user.id, user);

    this.userNotionCredentials.delete(userId);
    for (const token of this.accessTokens.values()) {
      if (token.user_id !== userId) {
        continue;
      }
      token.is_active = false;
      token.updated_at = nowIso();
      this.accessTokens.set(token.id, token);
    }
    return true;
  }

  async ingestItem(input: {
    userId: string;
    clientItemId: string;
    sourceUrl: string;
    rawText: string | null;
    sourceType: SourceType;
  }): Promise<{ item: ArticleItem; duplicated: boolean }> {
    const normalizedUrl = normalizeUrl(input.sourceUrl);
    const key = this.getUrlIndexKey(input.userId, normalizedUrl);
    const existingId = this.urlIndex.get(key);
    if (existingId) {
      const existing = this.items.get(existingId);
      if (existing) {
        return { item: clone(existing), duplicated: true };
      }
    }

    const now = nowIso();
    const item: ArticleItem = {
      id: randomId(),
      user_id: input.userId,
      client_item_id: input.clientItemId,
      source_url: input.sourceUrl,
      normalized_url: normalizedUrl,
      source_type: input.sourceType,
      raw_text: input.rawText,
      title: null,
      summary: null,
      cover_url: null,
      content_plaintext: null,
      status: "RECEIVED",
      notion_page_id: null,
      notion_page_url: null,
      error: null,
      created_at: now,
      updated_at: now
    };

    this.items.set(item.id, item);
    this.urlIndex.set(key, item.id);
    const ids = this.userItemIds.get(input.userId) ?? [];
    ids.push(item.id);
    this.userItemIds.set(input.userId, ids);
    return { item: clone(item), duplicated: false };
  }

  async listItems(input: {
    userId: string;
    status: ItemStatus | null;
    pageSize: number;
    pageToken: string | null;
  }): Promise<ListResult> {
    let start = 0;
    if (input.pageToken) {
      const parsed = Number.parseInt(input.pageToken, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        start = parsed;
      }
    }

    const ids = this.userItemIds.get(input.userId) ?? [];
    const ordered = [...ids].reverse().map((id) => this.items.get(id)).filter(Boolean) as ArticleItem[];
    const filtered =
      input.status === null ? ordered : ordered.filter((item) => item.status === input.status);
    const page = filtered.slice(start, start + input.pageSize).map(clone);
    const nextIdx = start + input.pageSize;
    return {
      items: page,
      nextPageToken: nextIdx < filtered.length ? String(nextIdx) : null
    };
  }

  async getItem(input: { userId: string; itemId: string }): Promise<ArticleItem | null> {
    const item = this.items.get(input.itemId);
    if (!item || item.user_id !== input.userId) {
      return null;
    }
    return clone(item);
  }

  async patchItem(input: {
    userId: string;
    itemId: string;
    fields: Partial<ArticleItem>;
  }): Promise<ArticleItem | null> {
    const item = this.items.get(input.itemId);
    if (!item || item.user_id !== input.userId) {
      return null;
    }
    Object.assign(item, input.fields);
    item.updated_at = nowIso();
    this.items.set(item.id, item);
    return clone(item);
  }

  async setError(input: {
    userId: string;
    itemId: string;
    status: ItemStatus;
    code: string;
    message: string;
    retriable: boolean;
    traceId: string;
  }): Promise<ArticleItem | null> {
    const error: SyncError = {
      code: input.code,
      message: input.message,
      retriable: input.retriable,
      trace_id: input.traceId
    };
    return this.patchItem({
      userId: input.userId,
      itemId: input.itemId,
      fields: { status: input.status, error }
    });
  }

  async upsertSettings(input: {
    userId: string;
    targetPageId: string;
    targetPageTitle: string | null;
  }): Promise<UserSettings> {
    await this.ensureUser({ userId: input.userId });
    const settings = this.ensureSettings(input.userId);
    settings.target_page_id = input.targetPageId;
    settings.target_page_title = input.targetPageTitle;
    this.settings.set(settings.user_id, settings);
    return clone(settings);
  }

  async getSettings(userId: string): Promise<UserSettings> {
    return clone(this.ensureSettings(userId));
  }

  async markNotionConnected(input: {
    userId: string;
    workspaceName: string;
  }): Promise<UserSettings> {
    await this.ensureUser({ userId: input.userId });
    const settings = this.ensureSettings(input.userId);
    settings.notion_connected = true;
    settings.workspace_name = input.workspaceName;
    this.settings.set(settings.user_id, settings);
    return clone(settings);
  }

  async createOAuthState(input: {
    state: string;
    userId: string;
    expiresAt: string;
  }): Promise<OAuthState> {
    const record: OAuthState = {
      state: input.state,
      user_id: input.userId,
      expires_at: input.expiresAt
    };
    this.oauthStates.set(record.state, record);
    return clone(record);
  }

  async consumeOAuthState(input: { state: string; now: string }): Promise<OAuthState | null> {
    const record = this.oauthStates.get(input.state);
    if (!record) {
      return null;
    }
    this.oauthStates.delete(input.state);
    if (oauthExpired(record.expires_at, input.now)) {
      return null;
    }
    return clone(record);
  }

  async upsertUserNotionCredential(input: {
    userId: string;
    tokenCiphertext: string;
    tokenIv: string;
    tokenTag: string;
    refreshTokenCiphertext?: string | null;
    refreshTokenIv?: string | null;
    refreshTokenTag?: string | null;
    tokenHint: string | null;
    accessTokenExpiresAt?: string | null;
    apiVersion: string;
    apiBaseUrl: string;
  }): Promise<UserNotionCredential> {
    await this.ensureUser({ userId: input.userId });
    const existing = this.userNotionCredentials.get(input.userId);
    const now = nowIso();
    const row: UserNotionCredentialRow = {
      user_id: input.userId,
      token_ciphertext: input.tokenCiphertext,
      token_iv: input.tokenIv,
      token_tag: input.tokenTag,
      refresh_token_ciphertext: input.refreshTokenCiphertext ?? null,
      refresh_token_iv: input.refreshTokenIv ?? null,
      refresh_token_tag: input.refreshTokenTag ?? null,
      token_hint: input.tokenHint,
      access_token_expires_at: input.accessTokenExpiresAt ?? null,
      api_version: input.apiVersion,
      api_base_url: input.apiBaseUrl,
      created_at: existing?.created_at ?? now,
      updated_at: now
    };
    this.userNotionCredentials.set(input.userId, row);
    return rowToUserNotionCredential(row);
  }

  async getUserNotionCredential(userId: string): Promise<UserNotionCredential | null> {
    const row = this.userNotionCredentials.get(userId);
    return row ? rowToUserNotionCredential(row) : null;
  }

  async getUserNotionCredentialSecret(userId: string): Promise<UserNotionCredentialSecret | null> {
    const row = this.userNotionCredentials.get(userId);
    return row ? rowToUserNotionCredentialSecret(row) : null;
  }

  async deleteUserNotionCredential(userId: string): Promise<boolean> {
    return this.userNotionCredentials.delete(userId);
  }

  async appendAuditLog(input: {
    actorUserId: string | null;
    actorRole: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    metadataJson?: string | null;
  }): Promise<void> {
    const log: AuditLog = {
      id: randomId(),
      actor_user_id: input.actorUserId,
      actor_role: input.actorRole,
      action: input.action,
      target_type: input.targetType ?? null,
      target_id: input.targetId ?? null,
      metadata_json: input.metadataJson ?? null,
      created_at: nowIso()
    };
    this.auditLogs.push(log);
  }

  async listAuditLogs(input?: {
    limit?: number;
    pageToken?: string | null;
    actorUserId?: string | null;
    action?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    createdFrom?: string | null;
    createdTo?: string | null;
  }): Promise<AuditLog[]> {
    const limit = typeof input?.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : 100;
    let start = 0;
    if (typeof input?.pageToken === "string" && input.pageToken.trim().length > 0) {
      const parsed = Number.parseInt(input.pageToken, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        start = parsed;
      }
    }

    return [...this.auditLogs]
      .filter((log) => !input?.actorUserId || log.actor_user_id === input.actorUserId)
      .filter((log) => !input?.action || log.action === input.action)
      .filter((log) => !input?.targetType || log.target_type === input.targetType)
      .filter((log) => !input?.targetId || log.target_id === input.targetId)
      .filter((log) => !input?.createdFrom || Date.parse(log.created_at) >= Date.parse(input.createdFrom))
      .filter((log) => !input?.createdTo || Date.parse(log.created_at) <= Date.parse(input.createdTo))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(start, start + limit)
      .map(clone);
  }

  async issueAccessToken(input: {
    userId: string;
    label: string | null;
    scopes: string[];
    expiresAt: string | null;
  }): Promise<{ plainToken: string; token: ApiAccessToken }> {
    await this.ensureUser({ userId: input.userId });
    const plainToken = `wx2n_${randomId().replaceAll("-", "")}`;
    const tokenHash = await sha256Hex(plainToken);
    const now = nowIso();
    const token: ApiAccessToken = {
      id: randomId(),
      user_id: input.userId,
      token_hash: tokenHash,
      label: input.label,
      scopes: normalizeScopes(input.scopes),
      is_active: true,
      expires_at: input.expiresAt,
      last_used_at: null,
      created_at: now,
      updated_at: now
    };
    this.accessTokens.set(token.id, token);
    this.tokenHashIndex.set(token.token_hash, token.id);
    return { plainToken, token: clone(token) };
  }

  async listAccessTokens(input: {
    userId?: string | null;
    isActive?: boolean | null;
  }): Promise<ApiAccessToken[]> {
    let tokens = [...this.accessTokens.values()];
    if (input.userId) {
      tokens = tokens.filter((token) => token.user_id === input.userId);
    }
    if (typeof input.isActive === "boolean") {
      tokens = tokens.filter((token) => token.is_active === input.isActive);
    }
    tokens.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return tokens.map(clone);
  }

  async revokeAccessToken(input: { tokenId: string }): Promise<boolean> {
    const token = this.accessTokens.get(input.tokenId);
    if (!token) {
      return false;
    }
    token.is_active = false;
    token.updated_at = nowIso();
    this.accessTokens.set(token.id, token);
    return true;
  }

  async getAccessTokenById(tokenId: string): Promise<ApiAccessToken | null> {
    const token = this.accessTokens.get(tokenId);
    return token ? clone(token) : null;
  }

  async getAccessTokenByHash(tokenHash: string): Promise<ApiAccessToken | null> {
    const tokenId = this.tokenHashIndex.get(tokenHash);
    if (!tokenId) {
      return null;
    }
    const token = this.accessTokens.get(tokenId);
    return token ? clone(token) : null;
  }

  async touchAccessToken(tokenId: string, atIso: string): Promise<void> {
    const token = this.accessTokens.get(tokenId);
    if (!token) {
      return;
    }
    token.last_used_at = atIso;
    token.updated_at = atIso;
    this.accessTokens.set(token.id, token);
  }
}

export class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

  async ensureUser(input: {
    userId: string;
    role?: AppUserRole;
    displayName?: string | null;
  }): Promise<AppUser> {
    const now = nowIso();
    await checkedRun(
      this.db,
      `INSERT INTO app_users (id, display_name, role, status, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?, NULL)
       ON CONFLICT(id) DO NOTHING`,
      [input.userId, input.displayName ?? null, input.role ?? "USER", now, now]
    );
    const user = await this.getUser(input.userId);
    if (!user) {
      throw new Error("Failed to ensure app user.");
    }
    return user;
  }

  async getUser(userId: string): Promise<AppUser | null> {
    const row = await checkedFirst<AppUserRow>(
      this.db,
      `SELECT id, display_name, role, status, created_at, updated_at, deleted_at
       FROM app_users
       WHERE id = ?
       LIMIT 1`,
      [userId]
    );
    return row ? rowToAppUser(row) : null;
  }

  async listUsers(input?: { status?: AppUserStatus | null }): Promise<AppUser[]> {
    const params: unknown[] = [];
    let whereClause = "";
    if (input?.status) {
      whereClause = "WHERE status = ?";
      params.push(input.status);
    }
    const rows = await checkedAll<AppUserRow>(
      this.db,
      `SELECT id, display_name, role, status, created_at, updated_at, deleted_at
       FROM app_users
       ${whereClause}
       ORDER BY created_at DESC`,
      params
    );
    return rows.map(rowToAppUser);
  }

  async updateUser(input: {
    userId: string;
    status?: AppUserStatus;
    displayName?: string | null;
  }): Promise<AppUser | null> {
    const current = await this.getUser(input.userId);
    if (!current) {
      return null;
    }

    const clauses: string[] = [];
    const params: unknown[] = [];
    if ("displayName" in input) {
      clauses.push("display_name = ?");
      params.push(input.displayName ?? null);
    }
    if (input.status) {
      clauses.push("status = ?");
      params.push(input.status);
      clauses.push("deleted_at = ?");
      params.push(input.status === "DELETED" ? nowIso() : null);
    }
    if (clauses.length === 0) {
      return current;
    }

    clauses.push("updated_at = ?");
    params.push(nowIso());
    params.push(input.userId);
    await checkedRun(
      this.db,
      `UPDATE app_users
       SET ${clauses.join(", ")}
       WHERE id = ?`,
      params
    );
    return this.getUser(input.userId);
  }

  async deleteUser(userId: string): Promise<boolean> {
    const existing = await this.getUser(userId);
    if (!existing) {
      return false;
    }
    const now = nowIso();
    await checkedRun(
      this.db,
      `UPDATE app_users
       SET status = 'DELETED', deleted_at = ?, updated_at = ?
       WHERE id = ?`,
      [now, now, userId]
    );
    await checkedRun(
      this.db,
      `UPDATE api_access_tokens
       SET is_active = 0, updated_at = ?
       WHERE user_id = ?`,
      [now, userId]
    );
    await checkedRun(this.db, `DELETE FROM user_notion_credentials WHERE user_id = ?`, [userId]);
    return true;
  }

  private async getItemByNormalizedUrl(
    userId: string,
    normalizedUrl: string
  ): Promise<ArticleItem | null> {
    const row = await checkedFirst<ArticleRow>(
      this.db,
      `SELECT * FROM article_items WHERE user_id = ? AND normalized_url = ? LIMIT 1`,
      [userId, normalizedUrl]
    );
    return row ? rowToItem(row) : null;
  }

  async ingestItem(input: {
    userId: string;
    clientItemId: string;
    sourceUrl: string;
    rawText: string | null;
    sourceType: SourceType;
  }): Promise<{ item: ArticleItem; duplicated: boolean }> {
    const normalizedUrl = normalizeUrl(input.sourceUrl);
    const existing = await this.getItemByNormalizedUrl(input.userId, normalizedUrl);
    if (existing) {
      return { item: existing, duplicated: true };
    }

    const now = nowIso();
    const item: ArticleItem = {
      id: randomId(),
      user_id: input.userId,
      client_item_id: input.clientItemId,
      source_url: input.sourceUrl,
      normalized_url: normalizedUrl,
      source_type: input.sourceType,
      raw_text: input.rawText,
      title: null,
      summary: null,
      cover_url: null,
      content_plaintext: null,
      status: "RECEIVED",
      notion_page_id: null,
      notion_page_url: null,
      error: null,
      created_at: now,
      updated_at: now
    };

    try {
      await checkedRun(
        this.db,
        `INSERT INTO article_items (
          id, user_id, client_item_id, source_url, normalized_url, source_type, raw_text,
          title, summary, cover_url, content_plaintext, status,
          notion_page_id, notion_page_url,
          error_code, error_message, error_retriable, error_trace_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          item.user_id,
          item.client_item_id,
          item.source_url,
          item.normalized_url,
          item.source_type,
          item.raw_text,
          item.title,
          item.summary,
          item.cover_url,
          item.content_plaintext,
          item.status,
          item.notion_page_id,
          item.notion_page_url,
          null,
          null,
          null,
          null,
          item.created_at,
          item.updated_at
        ]
      );
      return { item, duplicated: false };
    } catch {
      const raceExisting = await this.getItemByNormalizedUrl(input.userId, normalizedUrl);
      if (raceExisting) {
        return { item: raceExisting, duplicated: true };
      }
      throw new Error("Failed to ingest item into D1.");
    }
  }

  async listItems(input: {
    userId: string;
    status: ItemStatus | null;
    pageSize: number;
    pageToken: string | null;
  }): Promise<ListResult> {
    const parsedOffset =
      input.pageToken && Number.isFinite(Number.parseInt(input.pageToken, 10))
        ? Math.max(0, Number.parseInt(input.pageToken, 10))
        : 0;

    const sqlBase = `SELECT * FROM article_items WHERE user_id = ?`;
    const params: unknown[] = [input.userId];
    const statusClause = input.status ? ` AND status = ?` : "";
    if (input.status) {
      params.push(input.status);
    }
    params.push(input.pageSize, parsedOffset);

    const rows = await checkedAll<ArticleRow>(
      this.db,
      `${sqlBase}${statusClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      params
    );
    const items = rows.map(rowToItem);
    const nextPageToken = rows.length === input.pageSize ? String(parsedOffset + input.pageSize) : null;
    return { items, nextPageToken };
  }

  async getItem(input: { userId: string; itemId: string }): Promise<ArticleItem | null> {
    const row = await checkedFirst<ArticleRow>(
      this.db,
      `SELECT * FROM article_items WHERE user_id = ? AND id = ? LIMIT 1`,
      [input.userId, input.itemId]
    );
    return row ? rowToItem(row) : null;
  }

  async patchItem(input: {
    userId: string;
    itemId: string;
    fields: Partial<ArticleItem>;
  }): Promise<ArticleItem | null> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      setClauses.push(`${column} = ?`);
      values.push(value);
    };

    if ("source_url" in input.fields) add("source_url", input.fields.source_url);
    if ("normalized_url" in input.fields) add("normalized_url", input.fields.normalized_url);
    if ("source_type" in input.fields) add("source_type", input.fields.source_type);
    if ("raw_text" in input.fields) add("raw_text", input.fields.raw_text);
    if ("title" in input.fields) add("title", input.fields.title);
    if ("summary" in input.fields) add("summary", input.fields.summary);
    if ("cover_url" in input.fields) add("cover_url", input.fields.cover_url);
    if ("content_plaintext" in input.fields) add("content_plaintext", input.fields.content_plaintext);
    if ("status" in input.fields) add("status", input.fields.status);
    if ("notion_page_id" in input.fields) add("notion_page_id", input.fields.notion_page_id);
    if ("notion_page_url" in input.fields) add("notion_page_url", input.fields.notion_page_url);
    if ("error" in input.fields) {
      const err = input.fields.error;
      add("error_code", err?.code ?? null);
      add("error_message", err?.message ?? null);
      add("error_retriable", err ? Number(err.retriable) : null);
      add("error_trace_id", err?.trace_id ?? null);
    }

    if (setClauses.length === 0) {
      return this.getItem({ userId: input.userId, itemId: input.itemId });
    }

    const now = nowIso();
    await checkedRun(
      this.db,
      `UPDATE article_items SET ${setClauses.join(", ")}, updated_at = ? WHERE user_id = ? AND id = ?`,
      [...values, now, input.userId, input.itemId]
    );
    return this.getItem({ userId: input.userId, itemId: input.itemId });
  }

  async setError(input: {
    userId: string;
    itemId: string;
    status: ItemStatus;
    code: string;
    message: string;
    retriable: boolean;
    traceId: string;
  }): Promise<ArticleItem | null> {
    const error: SyncError = {
      code: input.code,
      message: input.message,
      retriable: input.retriable,
      trace_id: input.traceId
    };
    return this.patchItem({
      userId: input.userId,
      itemId: input.itemId,
      fields: { status: input.status, error }
    });
  }

  private async ensureSettings(userId: string): Promise<void> {
    const now = nowIso();
    await checkedRun(
      this.db,
      `INSERT INTO user_settings (
        user_id, notion_connected, workspace_name, target_page_id, target_page_title, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO NOTHING`,
      [userId, 0, null, null, null, now, now]
    );
  }

  async upsertSettings(input: {
    userId: string;
    targetPageId: string;
    targetPageTitle: string | null;
  }): Promise<UserSettings> {
    await this.ensureUser({ userId: input.userId });
    await this.ensureSettings(input.userId);
    await checkedRun(
      this.db,
      `UPDATE user_settings
       SET target_page_id = ?, target_page_title = ?, updated_at = ?
       WHERE user_id = ?`,
      [input.targetPageId, input.targetPageTitle, nowIso(), input.userId]
    );
    return this.getSettings(input.userId);
  }

  async getSettings(userId: string): Promise<UserSettings> {
    await this.ensureSettings(userId);
    const row = await checkedFirst<SettingsRow>(
      this.db,
      `SELECT user_id, notion_connected, workspace_name,
              target_page_id,
              target_page_title
       FROM user_settings WHERE user_id = ? LIMIT 1`,
      [userId]
    );
    if (!row) {
      throw new Error("Failed to load user settings.");
    }
    return rowToSettings(row);
  }

  async markNotionConnected(input: {
    userId: string;
    workspaceName: string;
  }): Promise<UserSettings> {
    await this.ensureUser({ userId: input.userId });
    await this.ensureSettings(input.userId);
    await checkedRun(
      this.db,
      `UPDATE user_settings
       SET notion_connected = 1, workspace_name = ?, updated_at = ?
       WHERE user_id = ?`,
      [input.workspaceName, nowIso(), input.userId]
    );
    return this.getSettings(input.userId);
  }

  async createOAuthState(input: {
    state: string;
    userId: string;
    expiresAt: string;
  }): Promise<OAuthState> {
    const now = nowIso();
    await checkedRun(
      this.db,
      `INSERT INTO oauth_states (state, user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(state) DO UPDATE SET
         user_id = excluded.user_id,
         expires_at = excluded.expires_at,
         created_at = excluded.created_at`,
      [input.state, input.userId, input.expiresAt, now]
    );
    return {
      state: input.state,
      user_id: input.userId,
      expires_at: input.expiresAt
    };
  }

  async consumeOAuthState(input: { state: string; now: string }): Promise<OAuthState | null> {
    const row = await checkedFirst<OAuthRow>(
      this.db,
      `SELECT state, user_id, expires_at FROM oauth_states WHERE state = ? LIMIT 1`,
      [input.state]
    );
    if (!row) {
      return null;
    }
    await checkedRun(this.db, `DELETE FROM oauth_states WHERE state = ?`, [input.state]);
    if (oauthExpired(row.expires_at, input.now)) {
      return null;
    }
    return row;
  }

  async upsertUserNotionCredential(input: {
    userId: string;
    tokenCiphertext: string;
    tokenIv: string;
    tokenTag: string;
    refreshTokenCiphertext?: string | null;
    refreshTokenIv?: string | null;
    refreshTokenTag?: string | null;
    tokenHint: string | null;
    accessTokenExpiresAt?: string | null;
    apiVersion: string;
    apiBaseUrl: string;
  }): Promise<UserNotionCredential> {
    await this.ensureUser({ userId: input.userId });
    const now = nowIso();
    await checkedRun(
      this.db,
      `INSERT INTO user_notion_credentials (
        user_id, token_ciphertext, token_iv, token_tag,
        refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
        token_hint, access_token_expires_at, api_version, api_base_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        token_ciphertext = excluded.token_ciphertext,
        token_iv = excluded.token_iv,
        token_tag = excluded.token_tag,
        refresh_token_ciphertext = excluded.refresh_token_ciphertext,
        refresh_token_iv = excluded.refresh_token_iv,
        refresh_token_tag = excluded.refresh_token_tag,
        token_hint = excluded.token_hint,
        access_token_expires_at = excluded.access_token_expires_at,
        api_version = excluded.api_version,
        api_base_url = excluded.api_base_url,
        updated_at = excluded.updated_at`,
      [
        input.userId,
        input.tokenCiphertext,
        input.tokenIv,
        input.tokenTag,
        input.refreshTokenCiphertext ?? null,
        input.refreshTokenIv ?? null,
        input.refreshTokenTag ?? null,
        input.tokenHint,
        input.accessTokenExpiresAt ?? null,
        input.apiVersion,
        input.apiBaseUrl,
        now,
        now
      ]
    );
    const credential = await this.getUserNotionCredential(input.userId);
    if (!credential) {
      throw new Error("Failed to upsert user Notion credential.");
    }
    return credential;
  }

  async getUserNotionCredential(userId: string): Promise<UserNotionCredential | null> {
    const row = await checkedFirst<UserNotionCredentialRow>(
      this.db,
      `SELECT user_id, token_ciphertext, token_iv, token_tag,
              refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
              token_hint, access_token_expires_at, api_version, api_base_url, created_at, updated_at
       FROM user_notion_credentials
       WHERE user_id = ?
       LIMIT 1`,
      [userId]
    );
    return row ? rowToUserNotionCredential(row) : null;
  }

  async getUserNotionCredentialSecret(userId: string): Promise<UserNotionCredentialSecret | null> {
    const row = await checkedFirst<UserNotionCredentialRow>(
      this.db,
      `SELECT user_id, token_ciphertext, token_iv, token_tag,
              refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
              token_hint, access_token_expires_at, api_version, api_base_url, created_at, updated_at
       FROM user_notion_credentials
       WHERE user_id = ?
       LIMIT 1`,
      [userId]
    );
    return row ? rowToUserNotionCredentialSecret(row) : null;
  }

  async deleteUserNotionCredential(userId: string): Promise<boolean> {
    const existing = await checkedFirst<{ user_id: string }>(
      this.db,
      `SELECT user_id FROM user_notion_credentials WHERE user_id = ? LIMIT 1`,
      [userId]
    );
    if (!existing) {
      return false;
    }
    await checkedRun(this.db, `DELETE FROM user_notion_credentials WHERE user_id = ?`, [userId]);
    return true;
  }

  async appendAuditLog(input: {
    actorUserId: string | null;
    actorRole: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    metadataJson?: string | null;
  }): Promise<void> {
    await checkedRun(
      this.db,
      `INSERT INTO audit_logs (
        id, actor_user_id, actor_role, action, target_type, target_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomId(),
        input.actorUserId,
        input.actorRole,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        input.metadataJson ?? null,
        nowIso()
      ]
    );
  }

  async listAuditLogs(input?: {
    limit?: number;
    pageToken?: string | null;
    actorUserId?: string | null;
    action?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    createdFrom?: string | null;
    createdTo?: string | null;
  }): Promise<AuditLog[]> {
    const limit = typeof input?.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : 100;
    let offset = 0;
    if (typeof input?.pageToken === "string" && input.pageToken.trim().length > 0) {
      const parsed = Number.parseInt(input.pageToken, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        offset = parsed;
      }
    }
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (input?.actorUserId) {
      conditions.push("actor_user_id = ?");
      params.push(input.actorUserId);
    }
    if (input?.action) {
      conditions.push("action = ?");
      params.push(input.action);
    }
    if (input?.targetType) {
      conditions.push("target_type = ?");
      params.push(input.targetType);
    }
    if (input?.targetId) {
      conditions.push("target_id = ?");
      params.push(input.targetId);
    }
    if (input?.createdFrom) {
      conditions.push("created_at >= ?");
      params.push(input.createdFrom);
    }
    if (input?.createdTo) {
      conditions.push("created_at <= ?");
      params.push(input.createdTo);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);
    const rows = await checkedAll<AuditLogRow>(
      this.db,
      `SELECT id, actor_user_id, actor_role, action, target_type, target_id, metadata_json, created_at
       FROM audit_logs
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ?
       OFFSET ?`,
      params
    );
    return rows.map(rowToAuditLog);
  }

  async issueAccessToken(input: {
    userId: string;
    label: string | null;
    scopes: string[];
    expiresAt: string | null;
  }): Promise<{ plainToken: string; token: ApiAccessToken }> {
    await this.ensureUser({ userId: input.userId });
    const plainToken = `wx2n_${randomId().replaceAll("-", "")}`;
    const tokenHash = await sha256Hex(plainToken);
    const now = nowIso();
    const token: ApiAccessToken = {
      id: randomId(),
      user_id: input.userId,
      token_hash: tokenHash,
      label: input.label,
      scopes: normalizeScopes(input.scopes),
      is_active: true,
      expires_at: input.expiresAt,
      last_used_at: null,
      created_at: now,
      updated_at: now
    };

    await checkedRun(
      this.db,
      `INSERT INTO api_access_tokens (
        id, user_id, token_hash, label, scopes, is_active, expires_at, last_used_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        token.id,
        token.user_id,
        token.token_hash,
        token.label,
        scopesToText(token.scopes),
        1,
        token.expires_at,
        null,
        token.created_at,
        token.updated_at
      ]
    );

    return { plainToken, token };
  }

  async listAccessTokens(input: {
    userId?: string | null;
    isActive?: boolean | null;
  }): Promise<ApiAccessToken[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.userId) {
      clauses.push("user_id = ?");
      params.push(input.userId);
    }
    if (typeof input.isActive === "boolean") {
      clauses.push("is_active = ?");
      params.push(input.isActive ? 1 : 0);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await checkedAll<AccessTokenRow>(
      this.db,
      `SELECT id, user_id, token_hash, label, scopes, is_active, expires_at, last_used_at, created_at, updated_at
       FROM api_access_tokens
       ${where}
       ORDER BY created_at DESC`,
      params
    );
    return rows.map(rowToAccessToken);
  }

  async revokeAccessToken(input: { tokenId: string }): Promise<boolean> {
    const existing = await checkedFirst<AccessTokenRow>(
      this.db,
      `SELECT id, user_id, token_hash, label, scopes, is_active, expires_at, last_used_at, created_at, updated_at
       FROM api_access_tokens
       WHERE id = ?
       LIMIT 1`,
      [input.tokenId]
    );
    if (!existing) {
      return false;
    }
    await checkedRun(
      this.db,
      `UPDATE api_access_tokens
       SET is_active = 0, updated_at = ?
       WHERE id = ?`,
      [nowIso(), input.tokenId]
    );
    return true;
  }

  async getAccessTokenById(tokenId: string): Promise<ApiAccessToken | null> {
    const row = await checkedFirst<AccessTokenRow>(
      this.db,
      `SELECT id, user_id, token_hash, label, scopes, is_active, expires_at, last_used_at, created_at, updated_at
       FROM api_access_tokens
       WHERE id = ?
       LIMIT 1`,
      [tokenId]
    );
    return row ? rowToAccessToken(row) : null;
  }

  async getAccessTokenByHash(tokenHash: string): Promise<ApiAccessToken | null> {
    const row = await checkedFirst<AccessTokenRow>(
      this.db,
      `SELECT id, user_id, token_hash, label, scopes, is_active, expires_at, last_used_at, created_at, updated_at
       FROM api_access_tokens
       WHERE token_hash = ?
       LIMIT 1`,
      [tokenHash]
    );
    return row ? rowToAccessToken(row) : null;
  }

  async touchAccessToken(tokenId: string, atIso: string): Promise<void> {
    await checkedRun(
      this.db,
      `UPDATE api_access_tokens
       SET last_used_at = ?, updated_at = ?
       WHERE id = ?`,
      [atIso, atIso, tokenId]
    );
  }
}
