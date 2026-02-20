import type { D1Database } from "./d1";
import { createLogger, serializeError, type Logger } from "./logger";
import { OPENAPI_YAML } from "./openapi";
import { processItem, type NotionRuntimeInput } from "./pipeline";
import { D1Store, type Store } from "./store";
import type { ApiAccessToken, IngestRequest, ItemStatus } from "./types";
import { ITEM_STATUSES } from "./types";
import { errorResponse, jsonResponse, nowIso, parseBearerToken, randomId, sha256Hex } from "./utils";

export interface Env {
  WX2NOTION_DEV_TOKEN?: string;
  NOTION_API_TOKEN?: string;
  NOTION_API_VERSION?: string;
  NOTION_API_BASE_URL?: string;
  NOTION_MOCK?: string;
  LOG_LEVEL?: string;
  DB?: D1Database;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

const DEMO_USER_ID = "demo-user";
const OPENAPI_SPEC_PATH = "/openapi.yaml";
const SWAGGER_UI_DIST_BASE_URL = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5";
type AuthContext = {
  userId: string;
  isAdmin: boolean;
  tokenId: string | null;
  scopes: string[];
};
type AuthResult = { ok: true; auth: AuthContext } | { ok: false; response: Response };

function isItemStatus(value: string): value is ItemStatus {
  return (ITEM_STATUSES as readonly string[]).includes(value);
}

function hasTokenScope(scopes: string[], requiredScope: string): boolean {
  return scopes.includes("*") || scopes.includes(requiredScope);
}

function parseScopesInput(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

function parseBooleanInput(raw: string | null): boolean | null {
  if (raw === null) {
    return null;
  }
  if (raw === "1" || raw.toLowerCase() === "true") {
    return true;
  }
  if (raw === "0" || raw.toLowerCase() === "false") {
    return false;
  }
  return null;
}

function parseEnvBoolean(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function resolveNotionRuntime(env: Env): NotionRuntimeInput {
  return {
    mock: parseEnvBoolean(env.NOTION_MOCK),
    apiToken: env.NOTION_API_TOKEN ?? null,
    apiVersion: env.NOTION_API_VERSION ?? null,
    apiBaseUrl: env.NOTION_API_BASE_URL ?? null
  };
}

function normalizeExpiresAt(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return "__INVALID__";
  }
  if (value.trim().length === 0) {
    return null;
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return "__INVALID__";
  }
  return new Date(time).toISOString();
}

function isObjectBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePageSize(url: URL): number {
  const raw = url.searchParams.get("page_size");
  if (!raw) {
    return 20;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    return -1;
  }
  return parsed;
}

function createNotFound(): Response {
  return errorResponse(404, "NOT_FOUND", "Route not found.");
}

function textResponse(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType
    }
  });
}

function htmlResponse(html: string): Response {
  return textResponse(html, "text/html; charset=utf-8");
}

function buildSwaggerUiHtml(specUrl: string): string {
  const serializedSpecUrl = JSON.stringify(specUrl);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>WX2Notion API Docs</title>
    <link rel="stylesheet" href="${SWAGGER_UI_DIST_BASE_URL}/swagger-ui.css" />
    <style>
      body {
        margin: 0;
        background: #f5f5f6;
      }
      .topbar {
        display: none;
      }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${SWAGGER_UI_DIST_BASE_URL}/swagger-ui-bundle.js"></script>
    <script src="${SWAGGER_UI_DIST_BASE_URL}/swagger-ui-standalone-preset.js"></script>
    <script>
      window.addEventListener("load", () => {
        SwaggerUIBundle({
          url: ${serializedSpecUrl},
          dom_id: "#swagger-ui",
          deepLinking: true,
          displayRequestDuration: true,
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          layout: "BaseLayout"
        });
      });
    </script>
  </body>
</html>`;
}

function toPublicToken(token: ApiAccessToken): Record<string, unknown> {
  return {
    id: token.id,
    user_id: token.user_id,
    label: token.label,
    scopes: token.scopes,
    is_active: token.is_active,
    expires_at: token.expires_at,
    last_used_at: token.last_used_at,
    created_at: token.created_at,
    updated_at: token.updated_at
  };
}

function createStoreResolver(overrideStore?: Store) {
  let cachedBinding: D1Database | null = null;
  let cachedStore: D1Store | null = null;

  return (env: Env): Store | null => {
    if (overrideStore) {
      return overrideStore;
    }
    if (!env.DB) {
      return null;
    }
    if (!cachedStore || cachedBinding !== env.DB) {
      cachedBinding = env.DB;
      cachedStore = new D1Store(env.DB);
    }
    return cachedStore;
  };
}

export function createApp(options?: { store?: Store }) {
  const resolveStore = createStoreResolver(options?.store);

  async function requireUserId(request: Request, env: Env): Promise<AuthResult> {
    const token = parseBearerToken(request.headers.get("authorization"));
    if (!token) {
      return {
        ok: false,
        response: errorResponse(401, "UNAUTHORIZED", "Missing bearer token.")
      };
    }

    const expected = env.WX2NOTION_DEV_TOKEN ?? "dev-token";
    if (!env.DB && token === expected) {
      return {
        ok: true,
        auth: {
          userId: DEMO_USER_ID,
          isAdmin: true,
          tokenId: null,
          scopes: ["*"]
        }
      };
    }

    const store = resolveStore(env);
    if (!store) {
      return {
        ok: false,
        response: errorResponse(500, "STORE_NOT_CONFIGURED", "D1 binding DB is not configured.")
      };
    }

    try {
      const tokenHash = await sha256Hex(token);
      const tokenRecord = await store.getAccessTokenByHash(tokenHash);
      if (!tokenRecord || !tokenRecord.is_active) {
        return {
          ok: false,
          response: errorResponse(401, "UNAUTHORIZED", "Invalid bearer token.")
        };
      }
      if (tokenRecord.expires_at && Date.parse(tokenRecord.expires_at) < Date.now()) {
        return {
          ok: false,
          response: errorResponse(401, "TOKEN_EXPIRED", "Access token has expired.")
        };
      }

      const now = nowIso();
      await store.touchAccessToken(tokenRecord.id, now);

      return {
        ok: true,
        auth: {
          userId: tokenRecord.user_id,
          isAdmin: hasTokenScope(tokenRecord.scopes, "admin:tokens"),
          tokenId: tokenRecord.id,
          scopes: tokenRecord.scopes
        }
      };
    } catch {
      return {
        ok: false,
        response: errorResponse(500, "AUTH_BACKEND_ERROR", "Failed to validate access token.")
      };
    }
  }

  async function withStore<T>(
    env: Env,
    operation: (store: Store) => Promise<Response | T>,
    transform?: (value: T) => Response
  ): Promise<Response> {
    const store = resolveStore(env);
    if (!store) {
      return errorResponse(500, "STORE_NOT_CONFIGURED", "D1 binding DB is not configured.");
    }
    const result = await operation(store);
    if (result instanceof Response) {
      return result;
    }
    return transform ? transform(result) : jsonResponse(result);
  }

  async function handleHealthz(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return jsonResponse({ status: "ok" });
    }
    return null;
  }

  async function handleOpenApiSpec(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== OPENAPI_SPEC_PATH) {
      return null;
    }
    return textResponse(OPENAPI_YAML, "application/yaml; charset=utf-8");
  }

  async function handleDocs(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "GET" || (url.pathname !== "/docs" && url.pathname !== "/docs/")) {
      return null;
    }
    const specUrl = `${url.origin}${OPENAPI_SPEC_PATH}`;
    return htmlResponse(buildSwaggerUiHtml(specUrl));
  }

  async function handleIngest(
    request: Request,
    env: Env,
    ctx: ExecutionContextLike,
    logger: Logger
  ): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/ingest") {
      return null;
    }

    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "BAD_REQUEST", "Invalid JSON body.");
    }
    if (!isObjectBody(body)) {
      return errorResponse(400, "BAD_REQUEST", "Invalid request body.");
    }

    const payload = body as Partial<IngestRequest>;
    if (typeof payload.client_item_id !== "string" || typeof payload.source_url !== "string") {
      return errorResponse(400, "BAD_REQUEST", "client_item_id and source_url are required.");
    }
    const clientItemId = payload.client_item_id;
    const sourceUrl = payload.source_url;
    const notionRuntime = resolveNotionRuntime(env);

    return withStore(env, async (store) => {
      const result = await store.ingestItem({
        userId: auth.auth.userId,
        clientItemId,
        sourceUrl,
        rawText: typeof payload.raw_text === "string" ? payload.raw_text : null,
        sourceType: "wechat_mp"
      });

      if (!result.duplicated) {
        const taskLogger = logger.child({
          item_id: result.item.id,
          user_id: auth.auth.userId
        });
        ctx.waitUntil(
          processItem(store, {
            userId: auth.auth.userId,
            itemId: result.item.id,
            notion: notionRuntime,
            logger: taskLogger
          }).catch((error) => {
            taskLogger.error("pipeline.unhandled", {
              error: serializeError(error)
            });
          })
        );
      }

      logger.info("ingest.accepted", {
        user_id: auth.auth.userId,
        item_id: result.item.id,
        duplicated: result.duplicated
      });

      return jsonResponse(
        {
          item_id: result.item.id,
          status: result.item.status,
          duplicated_from_item_id: result.duplicated ? result.item.id : null
        },
        202
      );
    });
  }

  async function handleListItems(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/v1/items") {
      return null;
    }
    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }

    const statusRaw = url.searchParams.get("status");
    const statusFilter = statusRaw === null ? null : statusRaw;
    if (statusFilter !== null && !isItemStatus(statusFilter)) {
      return errorResponse(400, "BAD_REQUEST", "Invalid status query parameter.");
    }

    const pageSize = parsePageSize(url);
    if (pageSize < 0) {
      return errorResponse(400, "BAD_REQUEST", "page_size should be in range 1..100.");
    }

    return withStore(env, async (store) => {
      const result = await store.listItems({
        userId: auth.auth.userId,
        status: statusFilter,
        pageSize,
        pageToken: url.searchParams.get("page_token")
      });
      return jsonResponse({
        items: result.items,
        next_page_token: result.nextPageToken
      });
    });
  }

  async function handleGetItem(request: Request, env: Env): Promise<Response | null> {
    if (request.method !== "GET") {
      return null;
    }
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/v1\/items\/([^/]+)$/);
    if (!match) {
      return null;
    }

    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }

    return withStore(env, async (store) => {
      const item = await store.getItem({ userId: auth.auth.userId, itemId: match[1] });
      if (!item) {
        return errorResponse(404, "NOT_FOUND", "Item not found.");
      }
      return jsonResponse({ item });
    });
  }

  async function handleRetry(
    request: Request,
    env: Env,
    ctx: ExecutionContextLike,
    logger: Logger
  ): Promise<Response | null> {
    if (request.method !== "POST") {
      return null;
    }
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/v1\/items\/([^/]+)\/retry$/);
    if (!match) {
      return null;
    }

    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }

    const itemId = match[1];
    const notionRuntime = resolveNotionRuntime(env);

    return withStore(env, async (store) => {
      const existing = await store.getItem({ userId: auth.auth.userId, itemId });
      if (!existing) {
        return errorResponse(404, "NOT_FOUND", "Item not found.");
      }

      await store.patchItem({
        userId: auth.auth.userId,
        itemId,
        fields: { status: "RECEIVED", error: null }
      });
      const taskLogger = logger.child({
        item_id: itemId,
        user_id: auth.auth.userId
      });
      ctx.waitUntil(
        processItem(store, {
          userId: auth.auth.userId,
          itemId,
          notion: notionRuntime,
          logger: taskLogger
        }).catch((error) => {
          taskLogger.error("pipeline.unhandled", {
            error: serializeError(error)
          });
        })
      );

      logger.info("item.retry.accepted", {
        user_id: auth.auth.userId,
        item_id: itemId
      });

      return jsonResponse(
        {
          item_id: itemId,
          status: "RECEIVED"
        },
        202
      );
    });
  }

  async function handleAuthStart(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/v1/auth/notion/start") {
      return null;
    }
    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }

    return withStore(env, async (store) => {
      const state = randomId().replaceAll("-", "");
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await store.createOAuthState({ state, userId: auth.auth.userId, expiresAt });
      const authorizeUrl =
        "https://api.notion.com/v1/oauth/authorize" +
        `?owner=user&client_id=demo-client-id&response_type=code&state=${state}`;
      return jsonResponse({
        authorize_url: authorizeUrl,
        state,
        expires_at: expiresAt
      });
    });
  }

  async function handleAuthCallback(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/v1/auth/notion/callback") {
      return null;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return errorResponse(400, "BAD_REQUEST", "code and state are required.");
    }

    return withStore(env, async (store) => {
      const oauthState = await store.consumeOAuthState({ state, now: nowIso() });
      if (!oauthState) {
        return errorResponse(400, "BAD_REQUEST", "Invalid or expired OAuth state.");
      }
      const settings = await store.markNotionConnected({
        userId: oauthState.user_id,
        workspaceName: "Demo Workspace"
      });
      return jsonResponse({
        success: true,
        deep_link: "wx2notion://auth/success",
        workspace_name: settings.workspace_name
      });
    });
  }

  async function handleUpdateTarget(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "PUT" || url.pathname !== "/v1/settings/notion-target") {
      return null;
    }
    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "BAD_REQUEST", "Invalid JSON body.");
    }
    if (!isObjectBody(body) || typeof body.database_id !== "string") {
      return errorResponse(400, "BAD_REQUEST", "database_id is required.");
    }
    const databaseId = body.database_id;
    const databaseTitle = typeof body.database_title === "string" ? body.database_title : null;

    return withStore(env, async (store) => {
      const settings = await store.upsertSettings({
        userId: auth.auth.userId,
        targetDatabaseId: databaseId,
        targetDatabaseTitle: databaseTitle
      });
      return jsonResponse({
        database_id: settings.target_database_id,
        database_title: settings.target_database_title
      });
    });
  }

  async function handleAdminCreateToken(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/admin/tokens") {
      return null;
    }

    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }
    if (!auth.auth.isAdmin) {
      return errorResponse(403, "FORBIDDEN", "Admin scope is required.");
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "BAD_REQUEST", "Invalid JSON body.");
    }
    if (!isObjectBody(body)) {
      return errorResponse(400, "BAD_REQUEST", "Invalid request body.");
    }

    const targetUserId =
      typeof body.user_id === "string" && body.user_id.trim().length > 0
        ? body.user_id.trim()
        : auth.auth.userId;
    const label = typeof body.label === "string" ? body.label : null;
    const scopesInput = parseScopesInput(body.scopes);
    const scopes = scopesInput.length > 0 ? scopesInput : ["*"];
    const expiresAt = normalizeExpiresAt(body.expires_at);
    if (expiresAt === "__INVALID__") {
      return errorResponse(400, "BAD_REQUEST", "expires_at must be a valid ISO datetime.");
    }

    return withStore(env, async (store) => {
      const issued = await store.issueAccessToken({
        userId: targetUserId,
        label,
        scopes,
        expiresAt
      });
      return jsonResponse(
        {
          token: issued.plainToken,
          token_record: toPublicToken(issued.token)
        },
        201
      );
    });
  }

  async function handleAdminListTokens(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/v1/admin/tokens") {
      return null;
    }

    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }
    if (!auth.auth.isAdmin) {
      return errorResponse(403, "FORBIDDEN", "Admin scope is required.");
    }

    const userId =
      typeof url.searchParams.get("user_id") === "string"
        ? (url.searchParams.get("user_id") ?? "").trim() || null
        : null;
    const activeRaw = url.searchParams.get("active");
    const isActive = parseBooleanInput(activeRaw);
    if (activeRaw !== null && isActive === null) {
      return errorResponse(400, "BAD_REQUEST", "active must be true/false or 1/0.");
    }

    return withStore(env, async (store) => {
      const tokens = await store.listAccessTokens({
        userId,
        isActive
      });
      return jsonResponse({
        tokens: tokens.map(toPublicToken)
      });
    });
  }

  async function handleAdminRevokeToken(request: Request, env: Env): Promise<Response | null> {
    if (request.method !== "POST") {
      return null;
    }
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/v1\/admin\/tokens\/([^/]+)\/revoke$/);
    if (!match) {
      return null;
    }

    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }
    if (!auth.auth.isAdmin) {
      return errorResponse(403, "FORBIDDEN", "Admin scope is required.");
    }

    const tokenId = match[1];
    return withStore(env, async (store) => {
      const revoked = await store.revokeAccessToken({ tokenId });
      if (!revoked) {
        return errorResponse(404, "NOT_FOUND", "Token not found.");
      }
      return jsonResponse({
        token_id: tokenId,
        status: "REVOKED"
      });
    });
  }

  async function fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    const start = Date.now();
    const url = new URL(request.url);
    const requestId = randomId().replaceAll("-", "");
    const logger = createLogger({
      service: "tonotionapi",
      minLevel: env.LOG_LEVEL,
      bindings: {
        request_id: requestId,
        method: request.method,
        path: url.pathname
      }
    });

    logger.info("request.received");

    try {
      const handlers = [
        () => handleHealthz(request),
        () => handleDocs(request),
        () => handleOpenApiSpec(request),
        () => handleIngest(request, env, ctx, logger),
        () => handleListItems(request, env),
        () => handleGetItem(request, env),
        () => handleRetry(request, env, ctx, logger),
        () => handleAuthStart(request, env),
        () => handleAuthCallback(request, env),
        () => handleUpdateTarget(request, env),
        () => handleAdminCreateToken(request, env),
        () => handleAdminListTokens(request, env),
        () => handleAdminRevokeToken(request, env)
      ];

      for (const handler of handlers) {
        const response = await handler();
        if (response) {
          logger.info("request.completed", {
            status: response.status,
            duration_ms: Date.now() - start
          });
          return response;
        }
      }

      const notFound = createNotFound();
      logger.info("request.completed", {
        status: notFound.status,
        duration_ms: Date.now() - start
      });
      return notFound;
    } catch (error) {
      logger.error("request.failed", {
        duration_ms: Date.now() - start,
        error: serializeError(error)
      });
      return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.", requestId);
    }
  }

  return {
    fetch
  };
}

const app = createApp();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    return app.fetch(request, env, ctx);
  }
};

export { InMemoryStore } from "./store";
