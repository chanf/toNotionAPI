import type { D1Database } from "./d1";
import { createLogger, serializeError, type Logger } from "./logger";
import { OPENAPI_YAML } from "./openapi";
import { processItem, type NotionRuntimeInput } from "./pipeline";
import { D1Store, type Store } from "./store";
import type { ApiAccessToken, AppUserRole, AppUserStatus, AuditLog, IngestRequest, ItemStatus } from "./types";
import { APP_USER_ROLES, APP_USER_STATUSES, ITEM_STATUSES } from "./types";
import { errorResponse, jsonResponse, nowIso, parseBearerToken, randomId, sha256Hex } from "./utils";

export interface Env {
  WX2NOTION_DEV_TOKEN?: string;
  NOTION_API_VERSION?: string;
  NOTION_API_BASE_URL?: string;
  NOTION_OAUTH_CLIENT_ID?: string;
  NOTION_OAUTH_CLIENT_SECRET?: string;
  NOTION_OAUTH_REDIRECT_URI?: string;
  CONSOLE_SESSION_SECRET?: string;
  CREDENTIALS_ENCRYPTION_KEY?: string;
  NOTION_MOCK?: string;
  LOG_LEVEL?: string;
  DB?: D1Database;
  PROCESS_ITEM_QUEUE?: QueueBindingLike;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface QueueBindingLike {
  send(message: unknown): Promise<void>;
}

export interface QueueMessageLike<T = unknown> {
  body: T;
  id?: string;
  attempts?: number;
  ack?: () => void;
  retry?: () => void;
}

export interface QueueBatchLike<T = unknown> {
  messages: Array<QueueMessageLike<T>>;
}

const DEMO_USER_ID = "demo-user";
const OPENAPI_SPEC_PATH = "/openapi.yaml";
const SWAGGER_UI_DIST_BASE_URL = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5";
const CONSOLE_SESSION_COOKIE_NAME = "tonotion_console_session";
const CONSOLE_SESSION_TTL_SECONDS = 8 * 60 * 60;
type AuthContext = {
  userId: string;
  isAdmin: boolean;
  tokenId: string | null;
  scopes: string[];
};
type AuthResult = { ok: true; auth: AuthContext } | { ok: false; response: Response };
type ConsoleSessionPayload = {
  uid: string;
  tid: string | null;
  scp: string[];
  adm: boolean;
  exp: number;
};

type QueueNotionRuntime = {
  mock: boolean;
  apiToken: string | null;
  apiVersion: string | null;
  apiBaseUrl: string | null;
};

type ProcessItemTaskMessage = {
  type: "PROCESS_ITEM";
  source: "ingest" | "retry";
  userId: string;
  itemId: string;
  notion: QueueNotionRuntime;
  queuedAt: string;
};

function isItemStatus(value: string): value is ItemStatus {
  return (ITEM_STATUSES as readonly string[]).includes(value);
}

function hasTokenScope(scopes: string[], requiredScope: string): boolean {
  return scopes.includes("*") || scopes.includes(requiredScope);
}

function isAppUserRole(value: string): value is AppUserRole {
  return (APP_USER_ROLES as readonly string[]).includes(value);
}

function isAppUserStatus(value: string): value is AppUserStatus {
  return (APP_USER_STATUSES as readonly string[]).includes(value);
}

function canManageUsers(scopes: string[]): boolean {
  return hasTokenScope(scopes, "admin:users") || hasTokenScope(scopes, "admin:tokens");
}

function containsPrivilegedScope(scopes: string[]): boolean {
  return scopes.some((scope) => scope === "*" || scope.startsWith("admin:"));
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

function normalizeApiBaseUrl(raw: string | null | undefined): string {
  if (!raw) {
    return "https://api.notion.com/v1";
  }
  return raw.trim().replace(/\/+$/, "");
}

function bytesToBase64(bytes: Uint8Array): string {
  const maybeBuffer = (globalThis as unknown as {
    Buffer?: { from(data: Uint8Array): { toString(encoding: string): string } };
  }).Buffer;
  if (maybeBuffer) {
    return maybeBuffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(input: string): Uint8Array {
  const maybeBuffer = (globalThis as unknown as {
    Buffer?: { from(data: string, encoding: string): Uint8Array };
  }).Buffer;
  if (maybeBuffer) {
    return new Uint8Array(maybeBuffer.from(input, "base64"));
  }
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

function base64FromText(input: string): string {
  const maybeBuffer = (globalThis as unknown as {
    Buffer?: { from(data: string, encoding: string): { toString(encoding: string): string } };
  }).Buffer;
  if (maybeBuffer) {
    return maybeBuffer.from(input, "utf8").toString("base64");
  }
  return btoa(input);
}

function toBase64Url(input: string): string {
  return input.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = padded.length % 4;
  if (remainder === 0) {
    return padded;
  }
  return padded + "=".repeat(4 - remainder);
}

function textToBase64Url(input: string): string {
  return toBase64Url(base64FromText(input));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return toBase64Url(bytesToBase64(bytes));
}

function base64UrlToText(input: string): string | null {
  try {
    const bytes = base64ToBytes(fromBase64Url(input));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function parseCookieValue(cookieHeader: string | null, key: string): string | null {
  if (!cookieHeader) {
    return null;
  }
  const segments = cookieHeader.split(";");
  for (const segment of segments) {
    const [name, ...rest] = segment.split("=");
    if (!name || rest.length === 0) {
      continue;
    }
    if (name.trim() !== key) {
      continue;
    }
    return rest.join("=").trim() || null;
  }
  return null;
}

function isConsoleSessionPayload(value: unknown): value is ConsoleSessionPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const raw = value as Record<string, unknown>;
  const scopes = raw.scp;
  return (
    typeof raw.uid === "string" &&
    raw.uid.length > 0 &&
    (typeof raw.tid === "string" || raw.tid === null) &&
    Array.isArray(scopes) &&
    scopes.every((scope) => typeof scope === "string") &&
    typeof raw.adm === "boolean" &&
    typeof raw.exp === "number" &&
    Number.isFinite(raw.exp)
  );
}

async function signSessionPayload(payloadPart: string, secret: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto API is unavailable.");
  }
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadPart)
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

async function createConsoleSessionToken(auth: AuthContext, secret: string): Promise<{
  token: string;
  expiresAt: string;
}> {
  const expiresAtMs = Date.now() + CONSOLE_SESSION_TTL_SECONDS * 1000;
  const payload: ConsoleSessionPayload = {
    uid: auth.userId,
    tid: auth.tokenId,
    scp: auth.scopes,
    adm: auth.isAdmin,
    exp: Math.floor(expiresAtMs / 1000)
  };
  const payloadPart = textToBase64Url(JSON.stringify(payload));
  const signature = await signSessionPayload(payloadPart, secret);
  return {
    token: `${payloadPart}.${signature}`,
    expiresAt: new Date(expiresAtMs).toISOString()
  };
}

async function verifyConsoleSessionToken(
  token: string,
  secret: string
): Promise<ConsoleSessionPayload | null> {
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) {
    return null;
  }
  const payloadPart = token.slice(0, separator);
  const signaturePart = token.slice(separator + 1);
  const expectedSignature = await signSessionPayload(payloadPart, secret);
  if (expectedSignature !== signaturePart) {
    return null;
  }
  const payloadText = base64UrlToText(payloadPart);
  if (!payloadText) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return null;
  }
  if (!isConsoleSessionPayload(parsed)) {
    return null;
  }
  if (parsed.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return parsed;
}

function buildSessionCookieValue(token: string, secure: boolean): string {
  const securePart = secure ? "; Secure" : "";
  return (
    `${CONSOLE_SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${CONSOLE_SESSION_TTL_SECONDS}` +
    securePart
  );
}

function buildClearSessionCookieValue(secure: boolean): string {
  const securePart = secure ? "; Secure" : "";
  return (
    `${CONSOLE_SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; ` +
    `Expires=Thu, 01 Jan 1970 00:00:00 GMT${securePart}`
  );
}

async function encryptSecret(plain: string, rawKey: string): Promise<{
  tokenCiphertext: string;
  tokenIv: string;
  tokenTag: string;
}> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto API is unavailable.");
  }
  const encodedKey = new TextEncoder().encode(rawKey);
  const keyDigest = await globalThis.crypto.subtle.digest("SHA-256", encodedKey);
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    keyDigest,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const cipher = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv
    },
    cryptoKey,
    new TextEncoder().encode(plain)
  );
  const cipherBytes = new Uint8Array(cipher);
  const tagLength = 16;
  if (cipherBytes.length <= tagLength) {
    throw new Error("Ciphertext is unexpectedly short.");
  }
  return {
    tokenCiphertext: bytesToBase64(cipherBytes.slice(0, -tagLength)),
    tokenIv: bytesToBase64(iv),
    tokenTag: bytesToBase64(cipherBytes.slice(-tagLength))
  };
}

async function decryptSecret(input: {
  tokenCiphertext: string;
  tokenIv: string;
  tokenTag: string;
}, rawKey: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto API is unavailable.");
  }
  const encodedKey = new TextEncoder().encode(rawKey);
  const keyDigest = await globalThis.crypto.subtle.digest("SHA-256", encodedKey);
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    keyDigest,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const iv = base64ToBytes(input.tokenIv);
  const cipherBytes = base64ToBytes(input.tokenCiphertext);
  const tagBytes = base64ToBytes(input.tokenTag);
  const encrypted = concatBytes(cipherBytes, tagBytes);
  const plainBuffer = await globalThis.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv as unknown as BufferSource
    },
    cryptoKey,
    encrypted as unknown as BufferSource
  );
  return new TextDecoder().decode(new Uint8Array(plainBuffer));
}

function parseEnvBoolean(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

type NotionOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  apiVersion: string;
};

type NotionOAuthTokenPayload = {
  accessToken: string;
  refreshToken: string | null;
  workspaceName: string | null;
  workspaceId: string | null;
  workspaceIcon: string | null;
  botId: string | null;
  accessTokenExpiresAt: string | null;
};

function extractTokenHint(token: string): string {
  return token.length <= 6 ? token : token.slice(-6);
}

function resolveNotionOAuthConfig(env: Env): NotionOAuthConfig | null {
  const clientId = env.NOTION_OAUTH_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.NOTION_OAUTH_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = env.NOTION_OAUTH_REDIRECT_URI?.trim() ?? "";
  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }
  const apiBaseUrl = normalizeApiBaseUrl(env.NOTION_API_BASE_URL);
  return {
    clientId,
    clientSecret,
    redirectUri,
    authorizeUrl: `${apiBaseUrl}/oauth/authorize`,
    tokenUrl: `${apiBaseUrl}/oauth/token`,
    apiVersion: env.NOTION_API_VERSION?.trim() || "2025-09-03"
  };
}

function parseNotionOAuthTokenPayload(raw: unknown): NotionOAuthTokenPayload | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const payload = raw as Record<string, unknown>;
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) {
    return null;
  }
  const refreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token.trim().length > 0
      ? payload.refresh_token.trim()
      : null;
  const workspaceName = typeof payload.workspace_name === "string" ? payload.workspace_name : null;
  const workspaceId = typeof payload.workspace_id === "string" ? payload.workspace_id : null;
  const workspaceIcon = typeof payload.workspace_icon === "string" ? payload.workspace_icon : null;
  const botId = typeof payload.bot_id === "string" ? payload.bot_id : null;
  let accessTokenExpiresAt: string | null = null;
  if (typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) && payload.expires_in > 0) {
    accessTokenExpiresAt = new Date(Date.now() + payload.expires_in * 1000).toISOString();
  }
  return {
    accessToken,
    refreshToken,
    workspaceName,
    workspaceId,
    workspaceIcon,
    botId,
    accessTokenExpiresAt
  };
}

async function parseNotionApiErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code : null;
    const message = typeof body.message === "string" ? body.message : null;
    if (message && code) {
      return `${message} (code: ${code})`;
    }
    return message ?? code;
  } catch {
    return null;
  }
}

async function requestNotionOAuthToken(
  config: NotionOAuthConfig,
  body: Record<string, string>
): Promise<
  | { ok: true; payload: NotionOAuthTokenPayload }
  | { ok: false; status: number; message: string }
> {
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${base64FromText(`${config.clientId}:${config.clientSecret}`)}`,
      "content-type": "application/json",
      "notion-version": config.apiVersion
    },
    body: JSON.stringify(body)
  });
  let responseBody: unknown = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }
  if (!response.ok) {
    if (responseBody && typeof responseBody === "object") {
      const errorBody = responseBody as Record<string, unknown>;
      const errorCode = typeof errorBody.error === "string" ? errorBody.error : "oauth_error";
      const errorDescription =
        typeof errorBody.error_description === "string" ? errorBody.error_description : "OAuth request failed.";
      return {
        ok: false,
        status: response.status,
        message: `${errorCode}: ${errorDescription}`
      };
    }
    return {
      ok: false,
      status: response.status,
      message: `OAuth request failed with status ${response.status}.`
    };
  }
  const parsed = parseNotionOAuthTokenPayload(responseBody);
  if (!parsed) {
    return {
      ok: false,
      status: 502,
      message: "OAuth response missing access token."
    };
  }
  return { ok: true, payload: parsed };
}

function resolveNotionRuntime(env: Env): NotionRuntimeInput {
  return {
    mock: parseEnvBoolean(env.NOTION_MOCK),
    apiToken: null,
    apiVersion: env.NOTION_API_VERSION ?? null,
    apiBaseUrl: env.NOTION_API_BASE_URL ?? null
  };
}

function resolveNotionRuntimeFromRequest(
  env: Env,
  payload: Partial<Pick<IngestRequest, "notion_api_token" | "notion_api_version" | "notion_api_base_url">>
): NotionRuntimeInput {
  const fallback = resolveNotionRuntime(env);
  const apiToken =
    typeof payload.notion_api_token === "string" && payload.notion_api_token.trim().length > 0
      ? payload.notion_api_token.trim()
      : null;
  const apiVersion =
    typeof payload.notion_api_version === "string" && payload.notion_api_version.trim().length > 0
      ? payload.notion_api_version.trim()
      : fallback.apiVersion;
  const apiBaseUrl = normalizeApiBaseUrl(
    typeof payload.notion_api_base_url === "string" ? payload.notion_api_base_url : fallback.apiBaseUrl
  );
  return {
    mock: fallback.mock,
    apiToken,
    apiVersion,
    apiBaseUrl
  };
}

function toQueueNotionRuntime(input: NotionRuntimeInput): QueueNotionRuntime {
  return {
    mock: Boolean(input.mock),
    apiToken: input.apiToken?.trim() || null,
    apiVersion: input.apiVersion?.trim() || null,
    apiBaseUrl: input.apiBaseUrl ? normalizeApiBaseUrl(input.apiBaseUrl) : null
  };
}

function toNotionRuntimeInputFromQueue(input: QueueNotionRuntime): NotionRuntimeInput {
  return {
    mock: input.mock,
    apiToken: input.apiToken,
    apiVersion: input.apiVersion,
    apiBaseUrl: input.apiBaseUrl
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

function normalizeOptionalIsoDatetime(value: string | null): string | "__INVALID__" | null {
  if (value === null) {
    return null;
  }
  if (value.trim().length === 0) {
    return "__INVALID__";
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

function isQueueNotionRuntime(value: unknown): value is QueueNotionRuntime {
  if (!isObjectBody(value)) {
    return false;
  }
  return (
    typeof value.mock === "boolean" &&
    (typeof value.apiToken === "string" || value.apiToken === null) &&
    (typeof value.apiVersion === "string" || value.apiVersion === null) &&
    (typeof value.apiBaseUrl === "string" || value.apiBaseUrl === null)
  );
}

function isProcessItemTaskMessage(value: unknown): value is ProcessItemTaskMessage {
  if (!isObjectBody(value)) {
    return false;
  }
  return (
    value.type === "PROCESS_ITEM" &&
    (value.source === "ingest" || value.source === "retry") &&
    typeof value.userId === "string" &&
    value.userId.length > 0 &&
    typeof value.itemId === "string" &&
    value.itemId.length > 0 &&
    typeof value.queuedAt === "string" &&
    value.queuedAt.length > 0 &&
    isQueueNotionRuntime(value.notion)
  );
}

function ackQueueMessage(message: QueueMessageLike<unknown>): void {
  if (typeof message.ack === "function") {
    message.ack();
  }
}

function retryQueueMessage(message: QueueMessageLike<unknown>): void {
  if (typeof message.retry === "function") {
    message.retry();
  }
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

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function buildAuditCsv(logs: AuditLog[]): string {
  const headers = [
    "id",
    "actor_user_id",
    "actor_role",
    "action",
    "target_type",
    "target_id",
    "metadata_json",
    "created_at"
  ];
  const lines = [headers.join(",")];
  for (const log of logs) {
    lines.push(
      [
        log.id,
        log.actor_user_id,
        log.actor_role,
        log.action,
        log.target_type,
        log.target_id,
        log.metadata_json,
        log.created_at
      ].map(csvEscape).join(",")
    );
  }
  return lines.join("\n");
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

function buildConsoleHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>toNotion 管理后台（MVP）</title>
    <style>
      :root {
        --bg: #f2f5f9;
        --panel: #ffffff;
        --line: #d9e1ea;
        --text: #16202b;
        --muted: #61788f;
        --brand: #0f5f8a;
        --brand-strong: #0a4a6c;
        --accent: #146b54;
        --accent-2: #8a4a2b;
        --danger: #b83232;
        --sidebar-bg: #102a43;
        --sidebar-line: #24476a;
        --sidebar-text: #d8e7f7;
        --sidebar-muted: #9cb6d2;
        --chip: #eaf2fb;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background:
          radial-gradient(circle at 12% 14%, #ffffff 0%, rgba(255, 255, 255, 0) 38%),
          radial-gradient(circle at 88% 88%, #deefff 0%, rgba(222, 239, 255, 0) 46%),
          linear-gradient(135deg, #eef4fa 0%, #e7edf5 100%);
        color: var(--text);
        font-family: "IBM Plex Sans", "PingFang SC", "Helvetica Neue", sans-serif;
      }
      .console-shell {
        width: min(1320px, 96%);
        margin: 20px auto;
        display: grid;
        grid-template-columns: 270px minmax(0, 1fr);
        border: 1px solid var(--line);
        border-radius: 18px;
        overflow: hidden;
        box-shadow: 0 20px 40px rgba(18, 42, 68, 0.08);
        min-height: calc(100vh - 40px);
      }
      .sidebar {
        background: linear-gradient(175deg, var(--sidebar-bg) 0%, #0d253b 100%);
        color: var(--sidebar-text);
        border-right: 1px solid var(--sidebar-line);
        display: flex;
        flex-direction: column;
        padding: 16px 14px;
        gap: 14px;
      }
      .brand {
        border: 1px solid var(--sidebar-line);
        border-radius: 12px;
        padding: 12px;
        background: rgba(255, 255, 255, 0.03);
      }
      .brand h1 {
        margin: 0;
        font-size: 20px;
        letter-spacing: 0.5px;
      }
      .brand p {
        margin: 6px 0 0 0;
        font-size: 13px;
        color: var(--sidebar-muted);
      }
      .menu-group {
        border: 1px solid var(--sidebar-line);
        border-radius: 12px;
        padding: 10px;
        background: rgba(255, 255, 255, 0.03);
      }
      .menu-label {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--sidebar-muted);
        margin: 0 0 8px 0;
      }
      .menu-btn {
        width: 100%;
        text-align: left;
        margin: 0 0 8px 0;
        border: 1px solid transparent;
        border-radius: 10px;
        padding: 9px 10px;
        background: transparent;
        color: var(--sidebar-text);
        cursor: pointer;
        font-size: 14px;
      }
      .menu-btn:last-child {
        margin-bottom: 0;
      }
      .menu-btn:hover {
        border-color: #3a628a;
        background: rgba(121, 173, 224, 0.15);
      }
      .menu-btn.is-active {
        border-color: #6ba1d8;
        background: rgba(107, 161, 216, 0.24);
        color: #ffffff;
      }
      .sidebar-foot {
        margin-top: auto;
        font-size: 12px;
        color: var(--sidebar-muted);
        border-top: 1px solid var(--sidebar-line);
        padding-top: 10px;
      }
      .workspace {
        padding: 16px;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        gap: 14px;
      }
      .workspace-head {
        background: linear-gradient(155deg, #f9fcff 0%, #eff6ff 100%);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px;
      }
      .workspace-head h2 {
        margin: 0;
        font-size: 26px;
      }
      .workspace-head .hint {
        margin: 8px 0 0 0;
        color: var(--muted);
        font-size: 13px;
      }
      .status-line {
        margin-top: 10px;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 14px 14px 12px;
      }
      .card h2 {
        margin: 0 0 8px 0;
        font-size: 18px;
      }
      .section-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 14px;
      }
      .view-section {
        display: none;
      }
      .view-section.is-active {
        display: block;
      }
      .admin-sections {
        display: grid;
        gap: 14px;
      }
      .row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin: 8px 0;
      }
      input, select, textarea, button {
        border-radius: 8px;
        border: 1px solid var(--line);
        padding: 9px 10px;
        font-size: 14px;
      }
      textarea {
        min-height: 120px;
        width: 100%;
      }
      button {
        cursor: pointer;
        background: #ffffff;
      }
      button.primary {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
      }
      button.warn {
        background: var(--accent-2);
        color: white;
        border-color: var(--accent-2);
      }
      button.danger {
        background: var(--danger);
        color: white;
        border-color: var(--danger);
      }
      .status {
        font-size: 13px;
        color: var(--muted);
      }
      .chip {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid #cddff4;
        background: var(--chip);
        font-size: 12px;
        margin-right: 6px;
      }
      pre {
        margin: 0;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 10px;
        background: #fdfefe;
        max-height: 280px;
        overflow: auto;
        font-size: 12px;
        font-family: "IBM Plex Mono", "SFMono-Regular", Menlo, monospace;
      }
      @media (min-width: 1080px) {
        .section-grid.split-2 {
          grid-template-columns: 1fr 1fr;
        }
      }
      @media (max-width: 980px) {
        .console-shell {
          grid-template-columns: 1fr;
          min-height: auto;
        }
        .sidebar {
          border-right: none;
          border-bottom: 1px solid var(--sidebar-line);
        }
        .menu-group {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap: 8px;
        }
        .menu-label {
          grid-column: 1 / -1;
          margin: 0;
        }
        .menu-btn {
          margin: 0;
        }
      }
    </style>
  </head>
  <body>
    <div class="console-shell">
      <aside class="sidebar">
        <div class="brand">
          <h1>toNotion Console</h1>
          <p>多用户同步管理台</p>
        </div>

        <div class="menu-group">
          <div class="menu-label">基础功能</div>
          <button class="menu-btn is-active" data-target="section-login">会话登录</button>
          <button class="menu-btn" data-target="section-profile">个人配置</button>
          <button class="menu-btn" data-target="section-sync">同步测试</button>
        </div>

        <div class="menu-group" id="adminMenuGroup" style="display:none;">
          <div class="menu-label">超管功能</div>
          <button class="menu-btn" data-target="section-admin-users">用户管理</button>
          <button class="menu-btn" data-target="section-admin-user-tokens">用户 Token</button>
          <button class="menu-btn" data-target="section-admin-audit">审计日志</button>
        </div>

        <div class="sidebar-foot">左侧菜单用于分区导航。移动端可横向滚动切换分组。</div>
      </aside>

      <main class="workspace">
        <header class="workspace-head">
          <h2>toNotion 管理后台（MVP）</h2>
          <p class="hint">使用 API Token 登录并创建会话。普通用户可管理自己的 token 与 Notion 配置；超管额外支持用户管理。</p>
          <div class="status-line">
            <span class="chip" id="loginStatus">未登录</span>
            <span class="chip" id="sessionStatus">会话状态：未建立</span>
          </div>
        </header>

        <section class="view-section is-active" id="section-login">
          <div class="card">
            <h2>会话登录</h2>
            <div class="row">
              <input id="tokenInput" style="flex:1; min-width:280px;" placeholder="Bearer Token，例如 wx2n_..." />
              <button id="saveTokenBtn" class="primary">登录并加载</button>
              <button id="clearTokenBtn">退出登录</button>
            </div>
            <div class="status">登录后会自动加载个人信息与可用能力。</div>
          </div>
        </section>

        <section class="view-section" id="section-profile">
          <div class="section-grid split-2">
            <div class="card">
              <h2>我的信息与目标页</h2>
              <div id="meProfile" class="status">尚未加载</div>
              <div class="row">
                <input id="pageIdInput" placeholder="Notion page_id" style="flex:1; min-width:220px;" />
                <input id="pageTitleInput" placeholder="page_title（可选）" style="flex:1; min-width:180px;" />
                <button id="saveTargetBtn" class="primary">保存目标页</button>
              </div>

              <h2>我的 Notion 凭证</h2>
              <div class="row">
                <input id="notionTokenInput" type="password" placeholder="NOTION_API_TOKEN" style="flex:1; min-width:220px;" />
              </div>
              <div class="row">
                <input id="notionVersionInput" value="2025-09-03" placeholder="NOTION_API_VERSION" />
                <input id="notionBaseUrlInput" value="https://api.notion.com/v1" placeholder="NOTION_API_BASE_URL" style="flex:1; min-width:200px;" />
              </div>
              <div class="row">
                <button id="saveNotionBtn" class="primary">保存 Notion 凭证</button>
                <button id="deleteNotionBtn" class="danger">删除 Notion 凭证</button>
                <button id="testNotionBtn">测试连通性</button>
                <button id="refreshNotionBtn">刷新状态</button>
              </div>
              <pre id="notionResult">暂无结果</pre>
            </div>

            <div class="card">
              <h2>我的 API Token</h2>
              <div class="row">
                <input id="tokenLabelInput" placeholder="label（可选）" />
                <input id="tokenScopesInput" value="items:read,items:write" placeholder="scopes，逗号分隔" style="flex:1; min-width:180px;" />
              </div>
              <div class="row">
                <input id="tokenExpiresInput" placeholder="expires_at（ISO，可选）" style="flex:1; min-width:220px;" />
                <button id="createSelfTokenBtn" class="primary">创建我的 token</button>
                <button id="listSelfTokenBtn">刷新列表</button>
              </div>
              <pre id="selfTokenResult">暂无结果</pre>
            </div>
          </div>
        </section>

        <section class="view-section" id="section-sync">
          <div class="card">
            <h2>同步测试工具</h2>
            <div class="status">输入公众号 URL + notion_api_token，调用 /v1/ingest 并在页面内轮询最终状态。</div>
            <div class="row">
              <input
                id="ingestSourceUrlInput"
                style="flex:1; min-width:280px;"
                placeholder="https://mp.weixin.qq.com/s/..."
                value=""
              />
            </div>
            <div class="row">
              <input
                id="ingestNotionTokenInput"
                type="password"
                style="flex:1; min-width:280px;"
                placeholder="notion_api_token（每次提交必填，mock 模式除外）"
              />
            </div>
            <div class="row">
              <input id="ingestClientItemIdInput" style="flex:1; min-width:220px;" placeholder="client_item_id（可选，默认自动生成）" />
              <input id="ingestPollTimeoutInput" value="60" placeholder="轮询超时秒数（默认60）" />
              <button id="submitIngestTestBtn" class="primary">提交并轮询</button>
            </div>
            <div class="row">
              <input id="ingestItemIdInput" style="flex:1; min-width:220px;" placeholder="item_id（可选，手工查询）" />
              <button id="queryIngestItemBtn">查询 item</button>
            </div>
            <div class="status" id="ingestTestStatus">等待提交</div>
            <pre id="ingestTestResult">暂无结果</pre>
          </div>
        </section>

        <div class="admin-sections" id="adminPanel" style="display:none;">
          <section class="view-section" id="section-admin-users">
            <div class="card">
              <h2>超管：用户管理</h2>
              <div class="row">
                <input id="newUserIdInput" placeholder="user_id" />
                <input id="newUserNameInput" placeholder="display_name（可选）" />
                <select id="newUserRoleSelect">
                  <option value="USER">USER</option>
                  <option value="SUPER_ADMIN">SUPER_ADMIN</option>
                </select>
                <button id="createUserBtn" class="primary">创建用户</button>
              </div>
              <div class="row">
                <select id="userStatusFilter">
                  <option value="">全部状态</option>
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="DISABLED">DISABLED</option>
                  <option value="DELETED">DELETED</option>
                </select>
                <button id="listUsersBtn">刷新用户列表</button>
              </div>
              <div class="row">
                <input id="manageUserIdInput" placeholder="目标 user_id" />
                <select id="manageUserStatusSelect">
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="DISABLED">DISABLED</option>
                  <option value="DELETED">DELETED</option>
                </select>
                <button id="updateUserStatusBtn" class="warn">更新状态</button>
                <button id="deleteUserBtn" class="danger">删除用户</button>
              </div>
              <pre id="adminUsersResult">暂无结果</pre>
            </div>
          </section>

          <section class="view-section" id="section-admin-user-tokens">
            <div class="card">
              <h2>超管：用户 Token 管理</h2>
              <div class="row">
                <input id="adminTokenUserIdInput" placeholder="目标 user_id" />
                <input id="adminTokenLabelInput" placeholder="label（可选）" />
                <input id="adminTokenScopesInput" value="items:read,items:write" placeholder="scopes，逗号分隔" style="flex:1; min-width:180px;" />
              </div>
              <div class="row">
                <input id="adminTokenExpiresInput" placeholder="expires_at（ISO，可选）" style="flex:1; min-width:220px;" />
                <select id="adminTokenActiveFilter">
                  <option value="">全部</option>
                  <option value="true">active=true</option>
                  <option value="false">active=false</option>
                </select>
                <button id="createUserTokenBtn" class="primary">创建用户 token</button>
                <button id="listUserTokensBtn">查询用户 token</button>
              </div>
              <div class="row">
                <input id="adminRevokeTokenIdInput" placeholder="待吊销 token_id" style="flex:1; min-width:220px;" />
                <button id="revokeUserTokenBtn" class="danger">吊销用户 token</button>
              </div>
              <pre id="adminUserTokensResult">暂无结果</pre>
            </div>
          </section>

          <section class="view-section" id="section-admin-audit">
            <div class="card">
              <h2>超管：审计日志</h2>
              <div class="row">
                <input id="auditLimitInput" value="50" placeholder="limit (1-500)" />
                <input id="auditPageTokenInput" placeholder="page_token（可选）" />
              </div>
              <div class="row">
                <input id="auditFromInput" placeholder="from（ISO 时间，可选）" style="flex:1; min-width:220px;" />
                <input id="auditToInput" placeholder="to（ISO 时间，可选）" style="flex:1; min-width:220px;" />
              </div>
              <div class="row">
                <input id="auditActorInput" placeholder="actor_user_id（可选）" />
                <input id="auditActionInput" placeholder="action（可选）" />
                <input id="auditTargetTypeInput" placeholder="target_type（可选）" />
                <input id="auditTargetIdInput" placeholder="target_id（可选）" />
                <button id="listAuditLogsBtn">刷新审计日志</button>
                <button id="exportAuditJsonBtn">导出 JSON</button>
                <button id="exportAuditCsvBtn">导出 CSV</button>
              </div>
              <pre id="auditLogsResult">暂无结果</pre>
            </div>
          </section>
        </div>
      </main>
    </div>

    <script>
      const loginStatusEl = document.getElementById("loginStatus");
      const sessionStatusEl = document.getElementById("sessionStatus");
      const meProfileEl = document.getElementById("meProfile");
      const adminPanelEl = document.getElementById("adminPanel");
      const adminMenuGroupEl = document.getElementById("adminMenuGroup");
      const tokenInputEl = document.getElementById("tokenInput");
      const selfTokenResultEl = document.getElementById("selfTokenResult");
      const notionResultEl = document.getElementById("notionResult");
      const adminUsersResultEl = document.getElementById("adminUsersResult");
      const adminUserTokensResultEl = document.getElementById("adminUserTokensResult");
      const auditLogsResultEl = document.getElementById("auditLogsResult");
      const ingestTestStatusEl = document.getElementById("ingestTestStatus");
      const ingestTestResultEl = document.getElementById("ingestTestResult");
      const menuButtons = Array.from(document.querySelectorAll(".menu-btn"));
      const viewSections = Array.from(document.querySelectorAll(".view-section"));
      const authRequiredMenuButtons = menuButtons.filter((button) => button.dataset.target !== "section-login");

      const INGEST_FINAL_STATUSES = new Set(["SYNCED", "SYNC_FAILED", "PARSE_FAILED"]);
      const ADMIN_SECTION_IDS = new Set([
        "section-admin-users",
        "section-admin-user-tokens",
        "section-admin-audit"
      ]);
      const SESSION_WARN_THRESHOLD_MS = 10 * 60 * 1000;
      const SESSION_AUTO_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
      let sessionExpiresAtMs = null;
      let sessionTimerHandle = null;
      let sessionRefreshInFlight = false;
      let isAuthenticatedSession = false;
      let isAdminSession = false;

      function isAdminSectionId(sectionId) {
        return ADMIN_SECTION_IDS.has(sectionId);
      }

      function activateSection(sectionId) {
        let targetId = sectionId;
        if (!isAuthenticatedSession && targetId !== "section-login") {
          targetId = "section-login";
        }
        if (isAdminSectionId(targetId) && !isAdminSession) {
          targetId = isAuthenticatedSession ? "section-profile" : "section-login";
        }
        const targetExists = viewSections.some((section) => section.id === targetId);
        if (!targetExists) {
          return;
        }
        for (const section of viewSections) {
          section.classList.toggle("is-active", section.id === targetId);
        }
        for (const button of menuButtons) {
          button.classList.toggle("is-active", button.dataset.target === targetId);
        }
      }

      function setAuthenticatedVisibility(isAuthenticated) {
        isAuthenticatedSession = Boolean(isAuthenticated);
        for (const button of authRequiredMenuButtons) {
          button.style.display = isAuthenticatedSession ? "" : "none";
        }
        if (!isAuthenticatedSession) {
          setAdminVisibility(false);
          activateSection("section-login");
        }
      }

      function setAdminVisibility(isAdmin) {
        isAdminSession = Boolean(isAdmin);
        adminPanelEl.style.display = isAdminSession ? "" : "none";
        adminMenuGroupEl.style.display = isAdminSession ? "" : "none";
        const activeSection = viewSections.find((section) => section.classList.contains("is-active"));
        if (!isAdminSession && activeSection && isAdminSectionId(activeSection.id)) {
          activateSection("section-profile");
        }
      }

      function getToken() {
        return (tokenInputEl.value || "").trim();
      }

      function setStatus(text) {
        loginStatusEl.textContent = text;
      }

      function clearSessionState() {
        sessionExpiresAtMs = null;
        sessionRefreshInFlight = false;
        if (sessionTimerHandle !== null) {
          clearInterval(sessionTimerHandle);
          sessionTimerHandle = null;
        }
        sessionStatusEl.textContent = "会话状态：未建立";
      }

      function parseExpiresAtToMs(expiresAtRaw) {
        if (typeof expiresAtRaw !== "string" || !expiresAtRaw.trim()) {
          return null;
        }
        const parsed = Date.parse(expiresAtRaw);
        return Number.isFinite(parsed) ? parsed : null;
      }

      function formatRemainingDuration(ms) {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) {
          return hours + "小时" + String(minutes).padStart(2, "0") + "分" + String(seconds).padStart(2, "0") + "秒";
        }
        return minutes + "分" + String(seconds).padStart(2, "0") + "秒";
      }

      function renderSessionCountdown() {
        if (sessionExpiresAtMs === null) {
          sessionStatusEl.textContent = "会话状态：未建立";
          return;
        }
        const remainingMs = sessionExpiresAtMs - Date.now();
        if (remainingMs <= 0) {
          sessionStatusEl.textContent = "会话状态：已过期，请重新登录";
          return;
        }
        const suffix = remainingMs <= SESSION_WARN_THRESHOLD_MS ? "（即将过期）" : "";
        sessionStatusEl.textContent = "会话剩余：" + formatRemainingDuration(remainingMs) + suffix;
      }

      function startSessionTicker() {
        if (sessionTimerHandle !== null) {
          clearInterval(sessionTimerHandle);
        }
        renderSessionCountdown();
        sessionTimerHandle = setInterval(() => {
          renderSessionCountdown();
          maybeAutoRefreshSession();
        }, 1000);
      }

      function applySessionExpiry(expiresAtRaw) {
        const parsed = parseExpiresAtToMs(expiresAtRaw);
        if (parsed === null) {
          clearSessionState();
          return;
        }
        sessionExpiresAtMs = parsed;
        startSessionTicker();
      }

      function pretty(data) {
        return JSON.stringify(data, null, 2);
      }

      function parsePositiveInt(raw, fallback) {
        const parsed = Number.parseInt(raw || "", 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
      }

      function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      function setIngestStatus(text) {
        ingestTestStatusEl.textContent = text;
      }

      function getItemFromBody(body) {
        if (!body || typeof body !== "object" || !body.item || typeof body.item !== "object") {
          return null;
        }
        return body.item;
      }

      function getItemIdFromBody(body) {
        if (!body || typeof body !== "object" || typeof body.item_id !== "string") {
          return null;
        }
        return body.item_id;
      }

      async function api(path, init) {
        const token = getToken();
        const headers = Object.assign({}, (init && init.headers) || {});
        if (token) {
          headers.authorization = "Bearer " + token;
        }
        const resp = await fetch(path, Object.assign({ credentials: "same-origin" }, init || {}, { headers }));
        const text = await resp.text();
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        return { resp, body };
      }

      async function maybeAutoRefreshSession() {
        if (sessionExpiresAtMs === null || sessionRefreshInFlight) {
          return;
        }
        const remainingMs = sessionExpiresAtMs - Date.now();
        if (remainingMs <= 0) {
          return;
        }
        if (remainingMs > SESSION_AUTO_REFRESH_THRESHOLD_MS) {
          return;
        }
        sessionRefreshInFlight = true;
        try {
          const { resp, body } = await api("/v1/console/refresh", { method: "POST" });
          if (!resp.ok) {
            if (resp.status === 401) {
              clearSessionState();
              setStatus("会话已失效，请重新登录");
              meProfileEl.textContent = "尚未加载";
              setAuthenticatedVisibility(false);
            }
            return;
          }
          applySessionExpiry(body && body.expires_at);
        } catch {
          // Ignore transient network errors and retry in next tick.
        } finally {
          sessionRefreshInFlight = false;
        }
      }

      async function loadProfile() {
        try {
          const { resp, body } = await api("/v1/me", { method: "GET" });
          if (!resp.ok) {
            meProfileEl.textContent = "加载失败: " + pretty(body);
            if (resp.status === 401) {
              setAuthenticatedVisibility(false);
              setStatus("未登录");
            } else {
              setAdminVisibility(false);
            }
            return;
          }
          const user = body.user || {};
          const isAdmin = Boolean(body.is_admin);
          const chips = [
            "<span class='chip'>id: " + (user.id || "-") + "</span>",
            "<span class='chip'>role: " + (user.role || "-") + "</span>",
            "<span class='chip'>status: " + (user.status || "-") + "</span>"
          ];
          meProfileEl.innerHTML = chips.join("");
          setAuthenticatedVisibility(true);
          setAdminVisibility(isAdmin);
          setStatus("登录成功（" + (isAdmin ? "超管" : "普通用户") + "）");
          activateSection("section-profile");
          if (isAdmin) {
            await refreshUsers();
            await refreshAuditLogs();
          }
        } catch (error) {
          meProfileEl.textContent = "加载失败: " + String(error);
          setAdminVisibility(false);
        }
      }

      async function refreshSelfTokens() {
        try {
          const { resp, body } = await api("/v1/me/tokens", { method: "GET" });
          selfTokenResultEl.textContent = pretty({ status: resp.status, body });
        } catch (error) {
          selfTokenResultEl.textContent = String(error);
        }
      }

      async function refreshNotionCredential() {
        try {
          const { resp, body } = await api("/v1/me/notion-credentials", { method: "GET" });
          notionResultEl.textContent = pretty({ status: resp.status, body });
        } catch (error) {
          notionResultEl.textContent = String(error);
        }
      }

      async function refreshUsers() {
        const filter = document.getElementById("userStatusFilter").value;
        const query = filter ? ("?status=" + encodeURIComponent(filter)) : "";
        try {
          const { resp, body } = await api("/v1/admin/users" + query, { method: "GET" });
          adminUsersResultEl.textContent = pretty({ status: resp.status, body });
        } catch (error) {
          adminUsersResultEl.textContent = String(error);
        }
      }

      async function refreshAdminUserTokens() {
        const userId = (document.getElementById("adminTokenUserIdInput").value || "").trim();
        if (!userId) {
          adminUserTokensResultEl.textContent = "请先输入目标 user_id";
          return;
        }
        const active = (document.getElementById("adminTokenActiveFilter").value || "").trim();
        const query = active ? ("?active=" + encodeURIComponent(active)) : "";
        try {
          const { resp, body } = await api("/v1/admin/users/" + encodeURIComponent(userId) + "/tokens" + query, {
            method: "GET"
          });
          adminUserTokensResultEl.textContent = pretty({ status: resp.status, body });
        } catch (error) {
          adminUserTokensResultEl.textContent = String(error);
        }
      }

      function buildAuditLogQuery(extraParams) {
        const params = new URLSearchParams();
        const limitRaw = (document.getElementById("auditLimitInput").value || "").trim();
        const pageTokenRaw = (document.getElementById("auditPageTokenInput").value || "").trim();
        const fromRaw = (document.getElementById("auditFromInput").value || "").trim();
        const toRaw = (document.getElementById("auditToInput").value || "").trim();
        const actorUserId = (document.getElementById("auditActorInput").value || "").trim();
        const action = (document.getElementById("auditActionInput").value || "").trim();
        const targetType = (document.getElementById("auditTargetTypeInput").value || "").trim();
        const targetId = (document.getElementById("auditTargetIdInput").value || "").trim();

        if (limitRaw) {
          params.set("limit", limitRaw);
        }
        if (pageTokenRaw) {
          params.set("page_token", pageTokenRaw);
        }
        if (fromRaw) {
          params.set("from", fromRaw);
        }
        if (toRaw) {
          params.set("to", toRaw);
        }
        if (actorUserId) {
          params.set("actor_user_id", actorUserId);
        }
        if (action) {
          params.set("action", action);
        }
        if (targetType) {
          params.set("target_type", targetType);
        }
        if (targetId) {
          params.set("target_id", targetId);
        }
        if (extraParams && typeof extraParams === "object") {
          for (const [key, value] of Object.entries(extraParams)) {
            if (value === null || value === undefined || value === "") {
              continue;
            }
            params.set(key, String(value));
          }
        }
        return params;
      }

      async function refreshAuditLogs() {
        const params = buildAuditLogQuery();
        const queryText = params.toString();
        const query = queryText ? ("?" + queryText) : "";
        try {
          const { resp, body } = await api("/v1/admin/audit-logs" + query, { method: "GET" });
          if (resp.ok && body && typeof body === "object") {
            const nextToken =
              typeof body.next_page_token === "string" ? body.next_page_token : "";
            document.getElementById("auditPageTokenInput").value = nextToken;
          }
          auditLogsResultEl.textContent = pretty({ status: resp.status, body });
        } catch (error) {
          auditLogsResultEl.textContent = String(error);
        }
      }

      async function exportAuditLogs(format) {
        const params = buildAuditLogQuery({
          format,
          limit: 500,
          page_token: ""
        });
        params.delete("page_token");
        const queryText = params.toString();
        const path = "/v1/admin/audit-logs" + (queryText ? ("?" + queryText) : "");
        try {
          const token = getToken();
          const headers = {};
          if (token) {
            headers.authorization = "Bearer " + token;
          }
          const resp = await fetch(path, { method: "GET", credentials: "same-origin", headers });
          if (!resp.ok) {
            const text = await resp.text();
            let body = text;
            try {
              body = text ? JSON.parse(text) : null;
            } catch {
              // Keep raw text when parsing fails.
            }
            auditLogsResultEl.textContent = pretty({ status: resp.status, body });
            return;
          }
          const content = await resp.text();
          const blob = new Blob([content], { type: resp.headers.get("content-type") || "text/plain" });
          const url = URL.createObjectURL(blob);
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const extension = format === "csv" ? "csv" : "json";
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = "audit-logs-" + timestamp + "." + extension;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          URL.revokeObjectURL(url);
        } catch (error) {
          auditLogsResultEl.textContent = String(error);
        }
      }

      async function queryIngestItem(itemId) {
        const { resp, body } = await api("/v1/items/" + encodeURIComponent(itemId), { method: "GET" });
        ingestTestResultEl.textContent = pretty({ status: resp.status, body });
        const item = getItemFromBody(body);
        const itemStatus = item && typeof item.status === "string" ? item.status : "";
        if (itemStatus) {
          setIngestStatus("item 状态：" + itemStatus);
        }
        return { resp, body, item };
      }

      async function submitAndPollIngest() {
        const sourceUrl = (document.getElementById("ingestSourceUrlInput").value || "").trim();
        const notionApiToken = (document.getElementById("ingestNotionTokenInput").value || "").trim();
        const clientItemIdInput = (document.getElementById("ingestClientItemIdInput").value || "").trim();
        const timeoutSec = parsePositiveInt((document.getElementById("ingestPollTimeoutInput").value || "").trim(), 60);

        if (!sourceUrl) {
          setIngestStatus("请先输入公众号 URL");
          return;
        }
        if (!notionApiToken) {
          setIngestStatus("请先输入 notion_api_token");
          return;
        }

        const clientItemId = clientItemIdInput || ("console-test-" + Date.now());
        setIngestStatus("提交中...");
        ingestTestResultEl.textContent = "提交中...";

        let ingestResp;
        try {
          ingestResp = await api("/v1/ingest", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              client_item_id: clientItemId,
              source_url: sourceUrl,
              raw_text: sourceUrl,
              notion_api_token: notionApiToken
            })
          });
        } catch (error) {
          setIngestStatus("提交失败: " + String(error));
          ingestTestResultEl.textContent = String(error);
          return;
        }

        ingestTestResultEl.textContent = pretty({ status: ingestResp.resp.status, body: ingestResp.body });
        const itemId = getItemIdFromBody(ingestResp.body);
        if (itemId) {
          document.getElementById("ingestItemIdInput").value = itemId;
        }

        if (!ingestResp.resp.ok || !itemId) {
          setIngestStatus("提交完成，但未获取到可轮询的 item_id");
          return;
        }

        setIngestStatus("已提交，开始轮询 item 状态...");
        const deadline = Date.now() + timeoutSec * 1000;
        while (Date.now() < deadline) {
          await sleep(2000);
          let queryResult;
          try {
            queryResult = await queryIngestItem(itemId);
          } catch (error) {
            setIngestStatus("查询 item 失败: " + String(error));
            ingestTestResultEl.textContent = String(error);
            return;
          }

          if (!queryResult.resp.ok || !queryResult.item) {
            continue;
          }
          const status = typeof queryResult.item.status === "string" ? queryResult.item.status : "";
          if (!status) {
            continue;
          }
          if (INGEST_FINAL_STATUSES.has(status)) {
            const notionUrl =
              typeof queryResult.item.notion_page_url === "string" ? queryResult.item.notion_page_url : "";
            setIngestStatus(
              "轮询完成，最终状态：" + status + (notionUrl ? "，Notion 页面：" + notionUrl : "")
            );
            return;
          }
        }

        setIngestStatus("轮询超时（" + timeoutSec + " 秒），请稍后手工查询 item");
      }

      document.getElementById("saveTokenBtn").addEventListener("click", async () => {
        const token = getToken();
        if (!token) {
          setStatus("token 不能为空");
          activateSection("section-login");
          return;
        }
        try {
          const resp = await fetch("/v1/console/login", {
            method: "POST",
            headers: { authorization: "Bearer " + token },
            credentials: "same-origin"
          });
          const text = await resp.text();
          let body = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          if (!resp.ok) {
            setStatus("登录失败: " + pretty(body));
            activateSection("section-login");
            return;
          }
          applySessionExpiry(body && body.expires_at);
          tokenInputEl.value = "";
          setAuthenticatedVisibility(true);
          setStatus("会话登录成功");
          await loadProfile();
          await refreshSelfTokens();
          await refreshNotionCredential();
        } catch (error) {
          setStatus("登录失败: " + String(error));
          activateSection("section-login");
        }
      });

      document.getElementById("clearTokenBtn").addEventListener("click", async () => {
        try {
          await fetch("/v1/console/logout", {
            method: "POST",
            credentials: "same-origin"
          });
        } catch {
          // Ignore network errors when clearing UI state.
        }
        tokenInputEl.value = "";
        clearSessionState();
        setStatus("已退出登录");
        meProfileEl.textContent = "尚未加载";
        setAuthenticatedVisibility(false);
      });

      document.getElementById("saveTargetBtn").addEventListener("click", async () => {
        const pageId = (document.getElementById("pageIdInput").value || "").trim();
        const pageTitle = (document.getElementById("pageTitleInput").value || "").trim();
        try {
          const { resp, body } = await api("/v1/me/notion-target", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ page_id: pageId, page_title: pageTitle || null })
          });
          notionResultEl.textContent = pretty({ status: resp.status, body });
        } catch (error) {
          notionResultEl.textContent = String(error);
        }
      });

      document.getElementById("saveNotionBtn").addEventListener("click", async () => {
        const notionApiToken = (document.getElementById("notionTokenInput").value || "").trim();
        const notionApiVersion = (document.getElementById("notionVersionInput").value || "").trim();
        const notionApiBaseUrl = (document.getElementById("notionBaseUrlInput").value || "").trim();
        try {
          const { resp, body } = await api("/v1/me/notion-credentials", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              notion_api_token: notionApiToken,
              notion_api_version: notionApiVersion || "2025-09-03",
              notion_api_base_url: notionApiBaseUrl || "https://api.notion.com/v1"
            })
          });
          notionResultEl.textContent = pretty({ status: resp.status, body });
        } catch (error) {
          notionResultEl.textContent = String(error);
        }
      });

      document.getElementById("deleteNotionBtn").addEventListener("click", async () => {
        try {
          const { resp, body } = await api("/v1/me/notion-credentials", { method: "DELETE" });
          notionResultEl.textContent = pretty({ status: resp.status, body });
        } catch (error) {
          notionResultEl.textContent = String(error);
        }
      });

      document.getElementById("testNotionBtn").addEventListener("click", async () => {
        const notionApiToken = (document.getElementById("notionTokenInput").value || "").trim();
        const notionApiVersion = (document.getElementById("notionVersionInput").value || "").trim();
        const notionApiBaseUrl = (document.getElementById("notionBaseUrlInput").value || "").trim();
        try {
          const { resp, body } = await api("/v1/me/notion-connectivity-test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              notion_api_token: notionApiToken || null,
              notion_api_version: notionApiVersion || null,
              notion_api_base_url: notionApiBaseUrl || null
            })
          });
          notionResultEl.textContent = pretty({ status: resp.status, body });
        } catch (error) {
          notionResultEl.textContent = String(error);
        }
      });

      document.getElementById("refreshNotionBtn").addEventListener("click", refreshNotionCredential);
      document.getElementById("listSelfTokenBtn").addEventListener("click", refreshSelfTokens);
      document.getElementById("submitIngestTestBtn").addEventListener("click", submitAndPollIngest);
      document.getElementById("queryIngestItemBtn").addEventListener("click", async () => {
        const itemId = (document.getElementById("ingestItemIdInput").value || "").trim();
        if (!itemId) {
          setIngestStatus("请先输入 item_id");
          return;
        }
        try {
          await queryIngestItem(itemId);
        } catch (error) {
          setIngestStatus("查询 item 失败: " + String(error));
          ingestTestResultEl.textContent = String(error);
        }
      });

      document.getElementById("createSelfTokenBtn").addEventListener("click", async () => {
        const label = (document.getElementById("tokenLabelInput").value || "").trim();
        const scopes = (document.getElementById("tokenScopesInput").value || "").trim();
        const expiresAt = (document.getElementById("tokenExpiresInput").value || "").trim();
        try {
          const { resp, body } = await api("/v1/me/tokens", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              label: label || null,
              scopes: scopes || null,
              expires_at: expiresAt || null
            })
          });
          selfTokenResultEl.textContent = pretty({ status: resp.status, body });
          await refreshSelfTokens();
        } catch (error) {
          selfTokenResultEl.textContent = String(error);
        }
      });

      document.getElementById("createUserBtn").addEventListener("click", async () => {
        const userId = (document.getElementById("newUserIdInput").value || "").trim();
        const displayName = (document.getElementById("newUserNameInput").value || "").trim();
        const role = document.getElementById("newUserRoleSelect").value;
        try {
          const { resp, body } = await api("/v1/admin/users", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              user_id: userId,
              display_name: displayName || null,
              role
            })
          });
          adminUsersResultEl.textContent = pretty({ status: resp.status, body });
          await refreshUsers();
        } catch (error) {
          adminUsersResultEl.textContent = String(error);
        }
      });

      document.getElementById("listUsersBtn").addEventListener("click", refreshUsers);
      document.getElementById("listUserTokensBtn").addEventListener("click", refreshAdminUserTokens);

      document.getElementById("createUserTokenBtn").addEventListener("click", async () => {
        const userId = (document.getElementById("adminTokenUserIdInput").value || "").trim();
        const label = (document.getElementById("adminTokenLabelInput").value || "").trim();
        const scopes = (document.getElementById("adminTokenScopesInput").value || "").trim();
        const expiresAt = (document.getElementById("adminTokenExpiresInput").value || "").trim();
        if (!userId) {
          adminUserTokensResultEl.textContent = "请先输入目标 user_id";
          return;
        }
        try {
          const { resp, body } = await api("/v1/admin/users/" + encodeURIComponent(userId) + "/tokens", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              label: label || null,
              scopes: scopes || null,
              expires_at: expiresAt || null
            })
          });
          adminUserTokensResultEl.textContent = pretty({ status: resp.status, body });
          if (body && body.token_record && body.token_record.id) {
            document.getElementById("adminRevokeTokenIdInput").value = body.token_record.id;
          }
        } catch (error) {
          adminUserTokensResultEl.textContent = String(error);
        }
      });

      document.getElementById("revokeUserTokenBtn").addEventListener("click", async () => {
        const userId = (document.getElementById("adminTokenUserIdInput").value || "").trim();
        const tokenId = (document.getElementById("adminRevokeTokenIdInput").value || "").trim();
        if (!userId) {
          adminUserTokensResultEl.textContent = "请先输入目标 user_id";
          return;
        }
        if (!tokenId) {
          adminUserTokensResultEl.textContent = "请先输入待吊销 token_id";
          return;
        }
        try {
          const { resp, body } = await api(
            "/v1/admin/users/" + encodeURIComponent(userId) + "/tokens/" + encodeURIComponent(tokenId) + "/revoke",
            { method: "POST" }
          );
          adminUserTokensResultEl.textContent = pretty({ status: resp.status, body });
          await refreshAdminUserTokens();
        } catch (error) {
          adminUserTokensResultEl.textContent = String(error);
        }
      });
      document.getElementById("listAuditLogsBtn").addEventListener("click", refreshAuditLogs);
      document.getElementById("exportAuditJsonBtn").addEventListener("click", () => exportAuditLogs("json"));
      document.getElementById("exportAuditCsvBtn").addEventListener("click", () => exportAuditLogs("csv"));

      document.getElementById("updateUserStatusBtn").addEventListener("click", async () => {
        const userId = (document.getElementById("manageUserIdInput").value || "").trim();
        const status = (document.getElementById("manageUserStatusSelect").value || "").trim();
        if (!userId) {
          adminUsersResultEl.textContent = "请先输入目标 user_id";
          return;
        }
        try {
          const { resp, body } = await api("/v1/admin/users/" + encodeURIComponent(userId), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status })
          });
          adminUsersResultEl.textContent = pretty({ status: resp.status, body });
          await refreshUsers();
        } catch (error) {
          adminUsersResultEl.textContent = String(error);
        }
      });

      document.getElementById("deleteUserBtn").addEventListener("click", async () => {
        const userId = (document.getElementById("manageUserIdInput").value || "").trim();
        if (!userId) {
          adminUsersResultEl.textContent = "请先输入目标 user_id";
          return;
        }
        if (!confirm("确认删除用户 " + userId + " 吗？")) {
          return;
        }
        try {
          const { resp, body } = await api("/v1/admin/users/" + encodeURIComponent(userId), {
            method: "DELETE"
          });
          adminUsersResultEl.textContent = pretty({ status: resp.status, body });
          await refreshUsers();
        } catch (error) {
          adminUsersResultEl.textContent = String(error);
        }
      });

      for (const button of menuButtons) {
        button.addEventListener("click", () => {
          const target = button.dataset.target || "section-login";
          activateSection(target);
        });
      }

      setAuthenticatedVisibility(false);

      (async function bootstrap() {
        try {
          const { resp, body } = await api("/v1/console/session", { method: "GET" });
          if (!resp.ok) {
            clearSessionState();
            setStatus("未登录");
            meProfileEl.textContent = "尚未加载";
            setAuthenticatedVisibility(false);
            return;
          }
          applySessionExpiry(body && body.session_expires_at);
          setAuthenticatedVisibility(true);
          await loadProfile();
          await refreshSelfTokens();
          await refreshNotionCredential();
        } catch {
          clearSessionState();
          setStatus("未登录");
          meProfileEl.textContent = "尚未加载";
          setAuthenticatedVisibility(false);
        }
      })();
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

  function authRole(auth: AuthContext): AppUserRole {
    return canManageUsers(auth.scopes) ? "SUPER_ADMIN" : "USER";
  }

  function toMetadataJson(metadata: Record<string, unknown> | undefined): string | null {
    if (!metadata) {
      return null;
    }
    try {
      return JSON.stringify(metadata);
    } catch {
      return null;
    }
  }

  async function appendAuditLog(
    store: Store,
    input: {
      actor: AuthContext;
      action: string;
      targetType?: string;
      targetId?: string | null;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    await store.appendAuditLog({
      actorUserId: input.actor.userId,
      actorRole: authRole(input.actor),
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadataJson: toMetadataJson(input.metadata)
    });
  }

  async function dispatchProcessItemTask(
    store: Store,
    input: {
      env: Env;
      ctx: ExecutionContextLike;
      logger: Logger;
      source: "ingest" | "retry";
      userId: string;
      itemId: string;
      notion: NotionRuntimeInput;
    }
  ): Promise<void> {
    const taskLogger = input.logger.child({
      source: input.source,
      user_id: input.userId,
      item_id: input.itemId
    });
    const taskMessage: ProcessItemTaskMessage = {
      type: "PROCESS_ITEM",
      source: input.source,
      userId: input.userId,
      itemId: input.itemId,
      notion: toQueueNotionRuntime(input.notion),
      queuedAt: nowIso()
    };

    if (input.env.PROCESS_ITEM_QUEUE) {
      try {
        await input.env.PROCESS_ITEM_QUEUE.send(taskMessage);
        taskLogger.info("pipeline.task.enqueued");
        return;
      } catch (error) {
        taskLogger.error("pipeline.task.enqueue_failed", {
          error: serializeError(error)
        });
      }
    } else {
      taskLogger.warn("pipeline.queue.binding_missing", {
        queue_binding: "PROCESS_ITEM_QUEUE"
      });
    }

    taskLogger.info("pipeline.task.waituntil_fallback");
    input.ctx.waitUntil(
      processItem(store, {
        userId: input.userId,
        itemId: input.itemId,
        notion: input.notion,
        logger: taskLogger
      }).catch((error) => {
        taskLogger.error("pipeline.unhandled", {
          error: serializeError(error)
        });
      })
    );
  }

  async function authenticateByAccessToken(token: string, env: Env): Promise<AuthResult> {
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

      const user = await store.getUser(tokenRecord.user_id);
      if (user && user.status !== "ACTIVE") {
        return {
          ok: false,
          response: errorResponse(403, "USER_INACTIVE", "Current user is disabled or deleted.")
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

  async function authenticateByConsoleSession(request: Request, env: Env): Promise<AuthResult | null> {
    const sessionToken = parseCookieValue(
      request.headers.get("cookie"),
      CONSOLE_SESSION_COOKIE_NAME
    );
    if (!sessionToken) {
      return null;
    }
    const secret = env.CONSOLE_SESSION_SECRET?.trim() ?? "";
    if (!secret) {
      return {
        ok: false,
        response: errorResponse(500, "CONFIG_MISSING", "CONSOLE_SESSION_SECRET is required.")
      };
    }

    let payload: ConsoleSessionPayload | null = null;
    try {
      payload = await verifyConsoleSessionToken(sessionToken, secret);
    } catch {
      payload = null;
    }
    if (!payload) {
      return {
        ok: false,
        response: errorResponse(401, "UNAUTHORIZED", "Invalid or expired console session.")
      };
    }

    if (payload.tid === null) {
      if (!env.DB && payload.uid === DEMO_USER_ID) {
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
      return {
        ok: false,
        response: errorResponse(401, "UNAUTHORIZED", "Console session is no longer valid.")
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
      const tokenRecord = await store.getAccessTokenById(payload.tid);
      if (!tokenRecord || !tokenRecord.is_active || tokenRecord.user_id !== payload.uid) {
        return {
          ok: false,
          response: errorResponse(401, "UNAUTHORIZED", "Console session is no longer valid.")
        };
      }
      if (tokenRecord.expires_at && Date.parse(tokenRecord.expires_at) < Date.now()) {
        return {
          ok: false,
          response: errorResponse(401, "TOKEN_EXPIRED", "Access token has expired.")
        };
      }
      const user = await store.getUser(tokenRecord.user_id);
      if (user && user.status !== "ACTIVE") {
        return {
          ok: false,
          response: errorResponse(403, "USER_INACTIVE", "Current user is disabled or deleted.")
        };
      }

      await store.touchAccessToken(tokenRecord.id, nowIso());

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
        response: errorResponse(500, "AUTH_BACKEND_ERROR", "Failed to validate console session.")
      };
    }
  }

  async function requireUserId(request: Request, env: Env): Promise<AuthResult> {
    const token = parseBearerToken(request.headers.get("authorization"));
    if (token) {
      return authenticateByAccessToken(token, env);
    }

    const sessionAuth = await authenticateByConsoleSession(request, env);
    if (sessionAuth) {
      return sessionAuth;
    }

    return {
      ok: false,
      response: errorResponse(401, "UNAUTHORIZED", "Missing bearer token or console session.")
    };
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

  async function handleConsole(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "GET" || (url.pathname !== "/console" && url.pathname !== "/console/")) {
      return null;
    }
    return htmlResponse(buildConsoleHtml());
  }

  async function handleConsoleLogin(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/console/login") {
      return null;
    }

    const secret = env.CONSOLE_SESSION_SECRET?.trim() ?? "";
    if (!secret) {
      return errorResponse(500, "CONFIG_MISSING", "CONSOLE_SESSION_SECRET is required.");
    }

    let token = parseBearerToken(request.headers.get("authorization"));
    if (!token) {
      try {
        const bodyText = await request.text();
        if (bodyText.trim().length > 0) {
          const parsed = JSON.parse(bodyText) as unknown;
          if (isObjectBody(parsed) && typeof parsed.token === "string" && parsed.token.trim().length > 0) {
            token = parsed.token.trim();
          }
        }
      } catch {
        return errorResponse(400, "BAD_REQUEST", "Invalid JSON body.");
      }
    }
    if (!token) {
      return errorResponse(400, "BAD_REQUEST", "Bearer token is required.");
    }

    const auth = await authenticateByAccessToken(token, env);
    if (!auth.ok) {
      return auth.response;
    }

    const session = await createConsoleSessionToken(auth.auth, secret);
    const secure = url.protocol === "https:";
    const responseBody: Record<string, unknown> = {
      logged_in: true,
      user_id: auth.auth.userId,
      is_admin: auth.auth.isAdmin,
      expires_at: session.expiresAt
    };

    const store = resolveStore(env);
    if (store) {
      const user = await store.ensureUser({
        userId: auth.auth.userId,
        role: authRole(auth.auth)
      });
      responseBody.user = user;
    }

    const response = jsonResponse(responseBody);
    response.headers.append("set-cookie", buildSessionCookieValue(session.token, secure));
    return response;
  }

  async function handleConsoleLogout(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/console/logout") {
      return null;
    }
    const secure = url.protocol === "https:";
    const response = jsonResponse({ logged_out: true });
    response.headers.append("set-cookie", buildClearSessionCookieValue(secure));
    return response;
  }

  async function handleConsoleRefresh(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/console/refresh") {
      return null;
    }

    const sessionAuth = await authenticateByConsoleSession(request, env);
    if (!sessionAuth) {
      return errorResponse(401, "UNAUTHORIZED", "Missing console session.");
    }
    if (!sessionAuth.ok) {
      return sessionAuth.response;
    }

    const secret = env.CONSOLE_SESSION_SECRET?.trim() ?? "";
    if (!secret) {
      return errorResponse(500, "CONFIG_MISSING", "CONSOLE_SESSION_SECRET is required.");
    }

    const session = await createConsoleSessionToken(sessionAuth.auth, secret);
    const secure = url.protocol === "https:";
    const response = jsonResponse({
      refreshed: true,
      expires_at: session.expiresAt
    });
    response.headers.append("set-cookie", buildSessionCookieValue(session.token, secure));
    return response;
  }

  async function handleConsoleSession(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/v1/console/session") {
      return null;
    }

    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }
    let sessionExpiresAt: string | null = null;
    const sessionToken = parseCookieValue(request.headers.get("cookie"), CONSOLE_SESSION_COOKIE_NAME);
    if (sessionToken) {
      const secret = env.CONSOLE_SESSION_SECRET?.trim() ?? "";
      if (secret) {
        try {
          const payload = await verifyConsoleSessionToken(sessionToken, secret);
          if (payload) {
            sessionExpiresAt = new Date(payload.exp * 1000).toISOString();
          }
        } catch {
          sessionExpiresAt = null;
        }
      }
    }

    const store = resolveStore(env);
    if (!store) {
      return jsonResponse({
        user: {
          id: auth.auth.userId,
          role: authRole(auth.auth),
          status: "ACTIVE"
        },
        is_admin: auth.auth.isAdmin,
        session_expires_at: sessionExpiresAt
      });
    }

    const user = await store.ensureUser({
      userId: auth.auth.userId,
      role: authRole(auth.auth)
    });
    return jsonResponse({
      user,
      is_admin: auth.auth.isAdmin,
      session_expires_at: sessionExpiresAt
    });
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
    const notionRuntime = resolveNotionRuntimeFromRequest(env, payload);
    if (!notionRuntime.mock && !notionRuntime.apiToken) {
      return errorResponse(400, "BAD_REQUEST", "notion_api_token is required when NOTION_MOCK is disabled.");
    }

    return withStore(env, async (store) => {
      const result = await store.ingestItem({
        userId: auth.auth.userId,
        clientItemId,
        sourceUrl,
        rawText: typeof payload.raw_text === "string" ? payload.raw_text : null,
        sourceType: "wechat_mp"
      });

      if (!result.duplicated) {
        await dispatchProcessItemTask(store, {
          env,
          ctx,
          logger,
          source: "ingest",
          userId: auth.auth.userId,
          itemId: result.item.id,
          notion: notionRuntime
        });
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

    let body: unknown = {};
    try {
      const raw = await request.text();
      if (raw.trim().length > 0) {
        body = JSON.parse(raw);
      }
    } catch {
      return errorResponse(400, "BAD_REQUEST", "Invalid JSON body.");
    }
    if (!isObjectBody(body)) {
      return errorResponse(400, "BAD_REQUEST", "Invalid request body.");
    }

    const itemId = match[1];
    const payload = body as Partial<IngestRequest>;
    const notionRuntime = resolveNotionRuntimeFromRequest(env, payload);
    if (!notionRuntime.mock && !notionRuntime.apiToken) {
      return errorResponse(400, "BAD_REQUEST", "notion_api_token is required when NOTION_MOCK is disabled.");
    }

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
      await dispatchProcessItemTask(store, {
        env,
        ctx,
        logger,
        source: "retry",
        userId: auth.auth.userId,
        itemId,
        notion: notionRuntime
      });

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
    const oauthConfig = resolveNotionOAuthConfig(env);
    if (!oauthConfig) {
      return errorResponse(
        500,
        "CONFIG_MISSING",
        "NOTION_OAUTH_CLIENT_ID, NOTION_OAUTH_CLIENT_SECRET and NOTION_OAUTH_REDIRECT_URI are required."
      );
    }

    return withStore(env, async (store) => {
      const state = randomId().replaceAll("-", "");
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await store.createOAuthState({ state, userId: auth.auth.userId, expiresAt });
      const authorizeUrl =
        `${oauthConfig.authorizeUrl}` +
        `?owner=user&client_id=${encodeURIComponent(oauthConfig.clientId)}` +
        `&response_type=code&redirect_uri=${encodeURIComponent(oauthConfig.redirectUri)}` +
        `&state=${encodeURIComponent(state)}`;
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
    const oauthConfig = resolveNotionOAuthConfig(env);
    if (!oauthConfig) {
      return errorResponse(
        500,
        "CONFIG_MISSING",
        "NOTION_OAUTH_CLIENT_ID, NOTION_OAUTH_CLIENT_SECRET and NOTION_OAUTH_REDIRECT_URI are required."
      );
    }
    const rawKey = env.CREDENTIALS_ENCRYPTION_KEY?.trim() ?? "";
    if (!rawKey) {
      return errorResponse(500, "CONFIG_MISSING", "CREDENTIALS_ENCRYPTION_KEY is required.");
    }

    return withStore(env, async (store) => {
      const oauthState = await store.consumeOAuthState({ state, now: nowIso() });
      if (!oauthState) {
        return errorResponse(400, "BAD_REQUEST", "Invalid or expired OAuth state.");
      }
      const oauthResult = await requestNotionOAuthToken(oauthConfig, {
        grant_type: "authorization_code",
        code,
        redirect_uri: oauthConfig.redirectUri
      });
      if (!oauthResult.ok) {
        const status = oauthResult.status >= 500 ? 502 : 400;
        return errorResponse(status, "NOTION_OAUTH_FAILED", oauthResult.message);
      }
      const encryptedAccessToken = await encryptSecret(oauthResult.payload.accessToken, rawKey);
      const encryptedRefreshToken = oauthResult.payload.refreshToken
        ? await encryptSecret(oauthResult.payload.refreshToken, rawKey)
        : null;
      await store.upsertUserNotionCredential({
        userId: oauthState.user_id,
        tokenCiphertext: encryptedAccessToken.tokenCiphertext,
        tokenIv: encryptedAccessToken.tokenIv,
        tokenTag: encryptedAccessToken.tokenTag,
        refreshTokenCiphertext: encryptedRefreshToken?.tokenCiphertext ?? null,
        refreshTokenIv: encryptedRefreshToken?.tokenIv ?? null,
        refreshTokenTag: encryptedRefreshToken?.tokenTag ?? null,
        tokenHint: extractTokenHint(oauthResult.payload.accessToken),
        accessTokenExpiresAt: oauthResult.payload.accessTokenExpiresAt,
        apiVersion: oauthConfig.apiVersion,
        apiBaseUrl: normalizeApiBaseUrl(env.NOTION_API_BASE_URL)
      });
      const settings = await store.markNotionConnected({
        userId: oauthState.user_id,
        workspaceName: oauthResult.payload.workspaceName ?? "Notion Workspace"
      });
      await appendAuditLog(store, {
        actor: {
          userId: oauthState.user_id,
          isAdmin: false,
          tokenId: null,
          scopes: ["self:notion"]
        },
        action: "NOTION_OAUTH_CALLBACK",
        targetType: "user_notion_credentials",
        targetId: oauthState.user_id,
        metadata: {
          workspace_name: oauthResult.payload.workspaceName,
          workspace_id: oauthResult.payload.workspaceId,
          workspace_icon: oauthResult.payload.workspaceIcon,
          bot_id: oauthResult.payload.botId,
          has_refresh_token: Boolean(oauthResult.payload.refreshToken)
        }
      });
      return jsonResponse({
        success: true,
        deep_link: "wx2notion://auth/success",
        workspace_name: settings.workspace_name,
        workspace_id: oauthResult.payload.workspaceId,
        workspace_icon: oauthResult.payload.workspaceIcon,
        bot_id: oauthResult.payload.botId,
        has_refresh_token: Boolean(oauthResult.payload.refreshToken),
        access_token_expires_at: oauthResult.payload.accessTokenExpiresAt
      });
    });
  }

  async function handleAuthRefresh(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/auth/notion/refresh") {
      return null;
    }
    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }
    const oauthConfig = resolveNotionOAuthConfig(env);
    if (!oauthConfig) {
      return errorResponse(
        500,
        "CONFIG_MISSING",
        "NOTION_OAUTH_CLIENT_ID, NOTION_OAUTH_CLIENT_SECRET and NOTION_OAUTH_REDIRECT_URI are required."
      );
    }
    const rawKey = env.CREDENTIALS_ENCRYPTION_KEY?.trim() ?? "";
    if (!rawKey) {
      return errorResponse(500, "CONFIG_MISSING", "CREDENTIALS_ENCRYPTION_KEY is required.");
    }

    return withStore(env, async (store) => {
      const credential = await store.getUserNotionCredentialSecret(auth.auth.userId);
      if (!credential) {
        return errorResponse(404, "NOT_FOUND", "Notion credential is not configured.");
      }
      if (
        !credential.refresh_token_ciphertext ||
        !credential.refresh_token_iv ||
        !credential.refresh_token_tag
      ) {
        return errorResponse(400, "BAD_REQUEST", "Refresh token is not configured for current user.");
      }

      let refreshToken = "";
      try {
        refreshToken = (await decryptSecret(
          {
            tokenCiphertext: credential.refresh_token_ciphertext,
            tokenIv: credential.refresh_token_iv,
            tokenTag: credential.refresh_token_tag
          },
          rawKey
        )).trim();
      } catch {
        return errorResponse(500, "DECRYPT_FAILED", "Failed to decrypt refresh token.");
      }
      if (!refreshToken) {
        return errorResponse(400, "BAD_REQUEST", "Refresh token is empty.");
      }

      const oauthResult = await requestNotionOAuthToken(oauthConfig, {
        grant_type: "refresh_token",
        refresh_token: refreshToken
      });
      if (!oauthResult.ok) {
        const status = oauthResult.status >= 500 ? 502 : 400;
        return errorResponse(status, "NOTION_OAUTH_FAILED", oauthResult.message);
      }

      const encryptedAccessToken = await encryptSecret(oauthResult.payload.accessToken, rawKey);
      const encryptedRefreshToken = oauthResult.payload.refreshToken
        ? await encryptSecret(oauthResult.payload.refreshToken, rawKey)
        : null;
      await store.upsertUserNotionCredential({
        userId: auth.auth.userId,
        tokenCiphertext: encryptedAccessToken.tokenCiphertext,
        tokenIv: encryptedAccessToken.tokenIv,
        tokenTag: encryptedAccessToken.tokenTag,
        refreshTokenCiphertext:
          encryptedRefreshToken?.tokenCiphertext ?? credential.refresh_token_ciphertext,
        refreshTokenIv: encryptedRefreshToken?.tokenIv ?? credential.refresh_token_iv,
        refreshTokenTag: encryptedRefreshToken?.tokenTag ?? credential.refresh_token_tag,
        tokenHint: extractTokenHint(oauthResult.payload.accessToken),
        accessTokenExpiresAt: oauthResult.payload.accessTokenExpiresAt,
        apiVersion: oauthConfig.apiVersion,
        apiBaseUrl: normalizeApiBaseUrl(env.NOTION_API_BASE_URL)
      });
      await store.markNotionConnected({
        userId: auth.auth.userId,
        workspaceName: oauthResult.payload.workspaceName ?? "Notion Workspace"
      });
      await appendAuditLog(store, {
        actor: auth.auth,
        action: "NOTION_OAUTH_REFRESH",
        targetType: "user_notion_credentials",
        targetId: auth.auth.userId,
        metadata: {
          workspace_name: oauthResult.payload.workspaceName,
          workspace_id: oauthResult.payload.workspaceId,
          workspace_icon: oauthResult.payload.workspaceIcon,
          bot_id: oauthResult.payload.botId,
          has_refresh_token: true
        }
      });

      return jsonResponse({
        refreshed: true,
        workspace_name: oauthResult.payload.workspaceName,
        workspace_id: oauthResult.payload.workspaceId,
        workspace_icon: oauthResult.payload.workspaceIcon,
        bot_id: oauthResult.payload.botId,
        has_refresh_token: true,
        access_token_expires_at: oauthResult.payload.accessTokenExpiresAt
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
    if (!isObjectBody(body)) {
      return errorResponse(400, "BAD_REQUEST", "Invalid request body.");
    }
    const rawPageId =
      typeof body.page_id === "string"
        ? body.page_id
        : typeof body.target_id === "string"
          ? body.target_id
          : null;
    if (!rawPageId || rawPageId.trim().length === 0) {
      return errorResponse(400, "BAD_REQUEST", "page_id is required.");
    }
    const pageId = rawPageId.trim();
    const pageTitleRaw =
      typeof body.page_title === "string"
        ? body.page_title
        : typeof body.target_title === "string"
          ? body.target_title
          : null;
    const pageTitle = pageTitleRaw && pageTitleRaw.trim().length > 0 ? pageTitleRaw.trim() : null;

    return withStore(env, async (store) => {
      const settings = await store.upsertSettings({
        userId: auth.auth.userId,
        targetPageId: pageId,
        targetPageTitle: pageTitle
      });
      await appendAuditLog(store, {
        actor: auth.auth,
        action: "NOTION_TARGET_UPDATE",
        targetType: "user_settings",
        targetId: auth.auth.userId,
        metadata: {
          page_id: settings.target_page_id,
          page_title: settings.target_page_title
        }
      });
      return jsonResponse({
        page_id: settings.target_page_id,
        page_title: settings.target_page_title
      });
    });
  }

  async function handleAdminCreateUser(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/admin/users") {
      return null;
    }
    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }
    if (!canManageUsers(auth.auth.scopes)) {
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

    const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
    if (!userId) {
      return errorResponse(400, "BAD_REQUEST", "user_id is required.");
    }
    const roleRaw = typeof body.role === "string" ? body.role.trim() : "USER";
    if (!isAppUserRole(roleRaw)) {
      return errorResponse(400, "BAD_REQUEST", "role must be SUPER_ADMIN or USER.");
    }
    const displayName =
      typeof body.display_name === "string" && body.display_name.trim().length > 0
        ? body.display_name.trim()
        : null;

    return withStore(env, async (store) => {
      const existing = await store.getUser(userId);
      if (existing) {
        return errorResponse(409, "CONFLICT", "User already exists.");
      }
      const user = await store.ensureUser({
        userId,
        role: roleRaw,
        displayName
      });
      await appendAuditLog(store, {
        actor: auth.auth,
        action: "USER_CREATE",
        targetType: "app_user",
        targetId: user.id,
        metadata: {
          role: user.role,
          status: user.status
        }
      });
      return jsonResponse({ user }, 201);
    });
  }

  async function handleAdminListUsers(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/v1/admin/users") {
      return null;
    }
    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }
    if (!canManageUsers(auth.auth.scopes)) {
      return errorResponse(403, "FORBIDDEN", "Admin scope is required.");
    }

    const statusRaw = typeof url.searchParams.get("status") === "string" ? (url.searchParams.get("status") ?? "").trim() : "";
    if (statusRaw.length > 0 && !isAppUserStatus(statusRaw)) {
      return errorResponse(400, "BAD_REQUEST", "status must be ACTIVE, DISABLED or DELETED.");
    }
    const statusFilter: AppUserStatus | null = isAppUserStatus(statusRaw) ? statusRaw : null;

    return withStore(env, async (store) => {
      const users = await store.listUsers({
        status: statusFilter
      });
      return jsonResponse({ users });
    });
  }

  async function handleAdminUpdateUser(request: Request, env: Env): Promise<Response | null> {
    if (request.method !== "PATCH") {
      return null;
    }
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)$/);
    if (!match) {
      return null;
    }

    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }
    if (!canManageUsers(auth.auth.scopes)) {
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

    const statusRaw = typeof body.status === "string" ? body.status.trim() : null;
    if (statusRaw !== null && !isAppUserStatus(statusRaw)) {
      return errorResponse(400, "BAD_REQUEST", "status must be ACTIVE, DISABLED or DELETED.");
    }
    const status: AppUserStatus | undefined = statusRaw !== null ? statusRaw : undefined;
    const hasDisplayName = Object.prototype.hasOwnProperty.call(body, "display_name");
    if (hasDisplayName && body.display_name !== null && typeof body.display_name !== "string") {
      return errorResponse(400, "BAD_REQUEST", "display_name must be string or null.");
    }
    if (statusRaw === null && !hasDisplayName) {
      return errorResponse(400, "BAD_REQUEST", "At least one updatable field is required.");
    }

    const displayName =
      hasDisplayName && typeof body.display_name === "string" && body.display_name.trim().length > 0
        ? body.display_name.trim()
        : hasDisplayName
          ? null
          : undefined;

    return withStore(env, async (store) => {
      const user = await store.updateUser({
        userId: match[1],
        status,
        displayName
      });
      if (!user) {
        return errorResponse(404, "NOT_FOUND", "User not found.");
      }
      await appendAuditLog(store, {
        actor: auth.auth,
        action: "USER_UPDATE",
        targetType: "app_user",
        targetId: user.id,
        metadata: {
          status: user.status,
          display_name: user.display_name
        }
      });
      return jsonResponse({ user });
    });
  }

  async function handleAdminDeleteUser(request: Request, env: Env): Promise<Response | null> {
    if (request.method !== "DELETE") {
      return null;
    }
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)$/);
    if (!match) {
      return null;
    }

    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }
    if (!canManageUsers(auth.auth.scopes)) {
      return errorResponse(403, "FORBIDDEN", "Admin scope is required.");
    }
    if (match[1] === auth.auth.userId) {
      return errorResponse(400, "BAD_REQUEST", "Current admin user cannot delete itself.");
    }

    return withStore(env, async (store) => {
      const deleted = await store.deleteUser(match[1]);
      if (!deleted) {
        return errorResponse(404, "NOT_FOUND", "User not found.");
      }
      await appendAuditLog(store, {
        actor: auth.auth,
        action: "USER_DELETE",
        targetType: "app_user",
        targetId: match[1]
      });
      return jsonResponse({
        user_id: match[1],
        status: "DELETED"
      });
    });
  }

  async function handleMeProfile(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/v1/me") {
      return null;
    }
    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }

    return withStore(env, async (store) => {
      const user = await store.ensureUser({
        userId: auth.auth.userId,
        role: canManageUsers(auth.auth.scopes) ? "SUPER_ADMIN" : "USER"
      });
      return jsonResponse({
        user,
        is_admin: canManageUsers(auth.auth.scopes)
      });
    });
  }

  async function handleMeListTokens(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/v1/me/tokens") {
      return null;
    }
    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }

    return withStore(env, async (store) => {
      const tokens = await store.listAccessTokens({
        userId: auth.auth.userId
      });
      return jsonResponse({
        tokens: tokens.map(toPublicToken)
      });
    });
  }

  async function handleMeCreateToken(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/me/tokens") {
      return null;
    }
    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }

    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "BAD_REQUEST", "Invalid JSON body.");
    }
    if (!isObjectBody(body)) {
      return errorResponse(400, "BAD_REQUEST", "Invalid request body.");
    }

    const label = typeof body.label === "string" ? body.label : null;
    const scopesInput = parseScopesInput(body.scopes);
    const scopes = scopesInput.length > 0 ? scopesInput : ["items:read", "items:write"];
    if (!canManageUsers(auth.auth.scopes) && containsPrivilegedScope(scopes)) {
      return errorResponse(403, "FORBIDDEN", "Creating privileged scopes is not allowed.");
    }
    const expiresAt = normalizeExpiresAt(body.expires_at);
    if (expiresAt === "__INVALID__") {
      return errorResponse(400, "BAD_REQUEST", "expires_at must be a valid ISO datetime.");
    }

    return withStore(env, async (store) => {
      await store.ensureUser({
        userId: auth.auth.userId,
        role: authRole(auth.auth)
      });
      const issued = await store.issueAccessToken({
        userId: auth.auth.userId,
        label,
        scopes,
        expiresAt
      });
      await appendAuditLog(store, {
        actor: auth.auth,
        action: "TOKEN_CREATE",
        targetType: "api_access_token",
        targetId: issued.token.id,
        metadata: {
          user_id: issued.token.user_id,
          scopes: issued.token.scopes,
          expires_at: issued.token.expires_at
        }
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

  async function handleMeRevokeToken(request: Request, env: Env): Promise<Response | null> {
    if (request.method !== "POST") {
      return null;
    }
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/v1\/me\/tokens\/([^/]+)\/revoke$/);
    if (!match) {
      return null;
    }
    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }

    const tokenId = match[1];
    return withStore(env, async (store) => {
      const token = await store.getAccessTokenById(tokenId);
      if (!token || token.user_id !== auth.auth.userId) {
        return errorResponse(404, "NOT_FOUND", "Token not found.");
      }
      await store.revokeAccessToken({ tokenId });
      await appendAuditLog(store, {
        actor: auth.auth,
        action: "TOKEN_REVOKE",
        targetType: "api_access_token",
        targetId: tokenId
      });
      return jsonResponse({
        token_id: tokenId,
        status: "REVOKED"
      });
    });
  }

  async function handleMeGetNotionCredentials(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/v1/me/notion-credentials") {
      return null;
    }
    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }

    return withStore(env, async (store) => {
      const credential = await store.getUserNotionCredential(auth.auth.userId);
      return jsonResponse({
        configured: Boolean(credential),
        credential
      });
    });
  }

  async function handleMePutNotionCredentials(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "PUT" || url.pathname !== "/v1/me/notion-credentials") {
      return null;
    }
    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }
    const rawKey = env.CREDENTIALS_ENCRYPTION_KEY?.trim() ?? "";
    if (!rawKey) {
      return errorResponse(500, "CONFIG_MISSING", "CREDENTIALS_ENCRYPTION_KEY is required.");
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
    const notionApiToken =
      typeof body.notion_api_token === "string" ? body.notion_api_token.trim() : "";
    if (!notionApiToken) {
      return errorResponse(400, "BAD_REQUEST", "notion_api_token is required.");
    }
    const apiVersion =
      typeof body.notion_api_version === "string" && body.notion_api_version.trim().length > 0
        ? body.notion_api_version.trim()
        : (env.NOTION_API_VERSION ?? "2025-09-03");
    const apiBaseUrl = normalizeApiBaseUrl(
      typeof body.notion_api_base_url === "string" ? body.notion_api_base_url : env.NOTION_API_BASE_URL
    );

    const encrypted = await encryptSecret(notionApiToken, rawKey);
    const tokenHint = notionApiToken.length <= 6 ? notionApiToken : notionApiToken.slice(-6);

    return withStore(env, async (store) => {
      await store.ensureUser({
        userId: auth.auth.userId,
        role: authRole(auth.auth)
      });
      const credential = await store.upsertUserNotionCredential({
        userId: auth.auth.userId,
        tokenCiphertext: encrypted.tokenCiphertext,
        tokenIv: encrypted.tokenIv,
        tokenTag: encrypted.tokenTag,
        tokenHint,
        apiVersion,
        apiBaseUrl
      });
      await appendAuditLog(store, {
        actor: auth.auth,
        action: "NOTION_CREDENTIAL_UPSERT",
        targetType: "user_notion_credentials",
        targetId: auth.auth.userId,
        metadata: {
          token_hint: credential.token_hint,
          api_version: credential.api_version,
          api_base_url: credential.api_base_url
        }
      });
      return jsonResponse({
        configured: true,
        credential
      });
    });
  }

  async function handleMeDeleteNotionCredentials(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "DELETE" || url.pathname !== "/v1/me/notion-credentials") {
      return null;
    }
    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }

    return withStore(env, async (store) => {
      const deleted = await store.deleteUserNotionCredential(auth.auth.userId);
      if (deleted) {
        await appendAuditLog(store, {
          actor: auth.auth,
          action: "NOTION_CREDENTIAL_DELETE",
          targetType: "user_notion_credentials",
          targetId: auth.auth.userId
        });
      }
      return jsonResponse({
        configured: false,
        deleted
      });
    });
  }

  async function handleMeTestNotionConnectivity(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/me/notion-connectivity-test") {
      return null;
    }
    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }

    let body: unknown = {};
    try {
      const raw = await request.text();
      if (raw.trim().length > 0) {
        body = JSON.parse(raw);
      }
    } catch {
      return errorResponse(400, "BAD_REQUEST", "Invalid JSON body.");
    }
    if (!isObjectBody(body)) {
      return errorResponse(400, "BAD_REQUEST", "Invalid request body.");
    }

    const payload = body as Partial<
      Pick<IngestRequest, "notion_api_token" | "notion_api_version" | "notion_api_base_url">
    >;
    const runtime = resolveNotionRuntimeFromRequest(env, payload);
    const notionApiVersion = (runtime.apiVersion ?? "2025-09-03").trim() || "2025-09-03";
    let notionApiBaseUrl = normalizeApiBaseUrl(runtime.apiBaseUrl);
    let notionApiToken = runtime.apiToken;
    let tokenSource: "request" | "stored" = "request";

    return withStore(env, async (store) => {
      const settings = await store.getSettings(auth.auth.userId);
      if (!settings.target_page_id) {
        return errorResponse(400, "NOTION_TARGET_MISSING", "Notion target page id is not configured.");
      }

      if (!notionApiToken) {
        const credential = await store.getUserNotionCredentialSecret(auth.auth.userId);
        if (!credential) {
          return errorResponse(
            400,
            "NOTION_TOKEN_MISSING",
            "notion_api_token is required or save Notion credential first."
          );
        }
        const rawKey = env.CREDENTIALS_ENCRYPTION_KEY?.trim() ?? "";
        if (!rawKey) {
          return errorResponse(500, "CONFIG_MISSING", "CREDENTIALS_ENCRYPTION_KEY is required.");
        }
        try {
          notionApiToken = (await decryptSecret(
            {
              tokenCiphertext: credential.token_ciphertext,
              tokenIv: credential.token_iv,
              tokenTag: credential.token_tag
            },
            rawKey
          )).trim();
        } catch {
          return errorResponse(500, "DECRYPT_FAILED", "Failed to decrypt saved Notion credential.");
        }
        if (!notionApiToken) {
          return errorResponse(400, "NOTION_TOKEN_MISSING", "Saved Notion credential is empty.");
        }
        const hasVersionOverride =
          typeof payload.notion_api_version === "string" && payload.notion_api_version.trim().length > 0;
        const hasBaseUrlOverride =
          typeof payload.notion_api_base_url === "string" && payload.notion_api_base_url.trim().length > 0;
        if (!hasVersionOverride && credential.api_version) {
          runtime.apiVersion = credential.api_version;
        }
        if (!hasBaseUrlOverride && credential.api_base_url) {
          notionApiBaseUrl = normalizeApiBaseUrl(credential.api_base_url);
        }
        tokenSource = "stored";
      }

      const response = await globalThis.fetch(`${notionApiBaseUrl}/pages/${settings.target_page_id}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${notionApiToken}`,
          "notion-version": runtime.apiVersion?.trim() || notionApiVersion
        }
      });
      if (response.ok) {
        return jsonResponse({
          ok: true,
          token_source: tokenSource,
          target_page_id: settings.target_page_id,
          notion_api_version: runtime.apiVersion?.trim() || notionApiVersion,
          notion_api_base_url: notionApiBaseUrl
        });
      }

      const detail = await parseNotionApiErrorMessage(response);
      if (response.status === 401 || response.status === 403) {
        return errorResponse(
          401,
          "NOTION_AUTH_FAILED",
          `Notion authentication failed.${detail ? ` ${detail}` : ""}`
        );
      }
      if (response.status === 404) {
        return errorResponse(
          404,
          "NOTION_TARGET_NOT_FOUND",
          `Notion target page not found or not shared.${detail ? ` ${detail}` : ""}`
        );
      }
      if (response.status === 429) {
        return errorResponse(
          429,
          "NOTION_RATE_LIMITED",
          `Notion API rate limit exceeded.${detail ? ` ${detail}` : ""}`
        );
      }
      if (response.status >= 500) {
        return errorResponse(
          502,
          "NOTION_UPSTREAM_ERROR",
          `Notion upstream service is unavailable.${detail ? ` ${detail}` : ""}`
        );
      }
      return errorResponse(
        400,
        "NOTION_REQUEST_FAILED",
        `Notion request failed with status ${response.status}.${detail ? ` ${detail}` : ""}`
      );
    });
  }

  async function handleMeUpdateTarget(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "PUT" || url.pathname !== "/v1/me/notion-target") {
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
    const rawPageId = typeof body.page_id === "string" ? body.page_id : null;
    if (!rawPageId || rawPageId.trim().length === 0) {
      return errorResponse(400, "BAD_REQUEST", "page_id is required.");
    }
    const pageId = rawPageId.trim();
    const pageTitle =
      typeof body.page_title === "string" && body.page_title.trim().length > 0
        ? body.page_title.trim()
        : null;

    return withStore(env, async (store) => {
      const settings = await store.upsertSettings({
        userId: auth.auth.userId,
        targetPageId: pageId,
        targetPageTitle: pageTitle
      });
      await appendAuditLog(store, {
        actor: auth.auth,
        action: "NOTION_TARGET_UPDATE",
        targetType: "user_settings",
        targetId: auth.auth.userId,
        metadata: {
          page_id: settings.target_page_id,
          page_title: settings.target_page_title
        }
      });
      return jsonResponse({
        page_id: settings.target_page_id,
        page_title: settings.target_page_title
      });
    });
  }

  async function handleAdminListUserTokens(request: Request, env: Env): Promise<Response | null> {
    if (request.method !== "GET") {
      return null;
    }
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)\/tokens$/);
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

    let targetUserId: string;
    try {
      targetUserId = decodeURIComponent(match[1]);
    } catch {
      return errorResponse(400, "BAD_REQUEST", "Invalid user id in path.");
    }

    const activeRaw = url.searchParams.get("active");
    const isActive = parseBooleanInput(activeRaw);
    if (activeRaw !== null && isActive === null) {
      return errorResponse(400, "BAD_REQUEST", "active must be true/false or 1/0.");
    }

    return withStore(env, async (store) => {
      const tokens = await store.listAccessTokens({
        userId: targetUserId,
        isActive
      });
      return jsonResponse({
        user_id: targetUserId,
        tokens: tokens.map(toPublicToken)
      });
    });
  }

  async function handleAdminCreateUserToken(request: Request, env: Env): Promise<Response | null> {
    if (request.method !== "POST") {
      return null;
    }
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)\/tokens$/);
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

    let targetUserId: string;
    try {
      targetUserId = decodeURIComponent(match[1]);
    } catch {
      return errorResponse(400, "BAD_REQUEST", "Invalid user id in path.");
    }

    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "BAD_REQUEST", "Invalid JSON body.");
    }
    if (!isObjectBody(body)) {
      return errorResponse(400, "BAD_REQUEST", "Invalid request body.");
    }

    const label = typeof body.label === "string" ? body.label : null;
    const scopesInput = parseScopesInput(body.scopes);
    const scopes = scopesInput.length > 0 ? scopesInput : ["items:read", "items:write"];
    const expiresAt = normalizeExpiresAt(body.expires_at);
    if (expiresAt === "__INVALID__") {
      return errorResponse(400, "BAD_REQUEST", "expires_at must be a valid ISO datetime.");
    }

    return withStore(env, async (store) => {
      const user = await store.getUser(targetUserId);
      if (!user) {
        return errorResponse(404, "NOT_FOUND", "User not found.");
      }
      const issued = await store.issueAccessToken({
        userId: targetUserId,
        label,
        scopes,
        expiresAt
      });
      await appendAuditLog(store, {
        actor: auth.auth,
        action: "TOKEN_CREATE_ADMIN_USER",
        targetType: "api_access_token",
        targetId: issued.token.id,
        metadata: {
          user_id: issued.token.user_id,
          scopes: issued.token.scopes,
          expires_at: issued.token.expires_at
        }
      });
      return jsonResponse(
        {
          user_id: targetUserId,
          token: issued.plainToken,
          token_record: toPublicToken(issued.token)
        },
        201
      );
    });
  }

  async function handleAdminRevokeUserToken(request: Request, env: Env): Promise<Response | null> {
    if (request.method !== "POST") {
      return null;
    }
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)\/tokens\/([^/]+)\/revoke$/);
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

    let targetUserId: string;
    let tokenId: string;
    try {
      targetUserId = decodeURIComponent(match[1]);
      tokenId = decodeURIComponent(match[2]);
    } catch {
      return errorResponse(400, "BAD_REQUEST", "Invalid path parameter.");
    }

    return withStore(env, async (store) => {
      const token = await store.getAccessTokenById(tokenId);
      if (!token || token.user_id !== targetUserId) {
        return errorResponse(404, "NOT_FOUND", "Token not found.");
      }
      await store.revokeAccessToken({ tokenId });
      await appendAuditLog(store, {
        actor: auth.auth,
        action: "TOKEN_REVOKE_ADMIN_USER",
        targetType: "api_access_token",
        targetId: tokenId,
        metadata: { user_id: targetUserId }
      });
      return jsonResponse({
        user_id: targetUserId,
        token_id: tokenId,
        status: "REVOKED"
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
      await appendAuditLog(store, {
        actor: auth.auth,
        action: "TOKEN_CREATE_ADMIN",
        targetType: "api_access_token",
        targetId: issued.token.id,
        metadata: {
          user_id: issued.token.user_id,
          scopes: issued.token.scopes,
          expires_at: issued.token.expires_at
        }
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
      await appendAuditLog(store, {
        actor: auth.auth,
        action: "TOKEN_REVOKE_ADMIN",
        targetType: "api_access_token",
        targetId: tokenId
      });
      return jsonResponse({
        token_id: tokenId,
        status: "REVOKED"
      });
    });
  }

  async function handleAdminListAuditLogs(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/v1/admin/audit-logs") {
      return null;
    }

    const auth = await requireUserId(request, env);
    if (!auth.ok) {
      return auth.response;
    }
    if (!canManageUsers(auth.auth.scopes)) {
      return errorResponse(403, "FORBIDDEN", "Admin scope is required.");
    }

    const limitRaw = url.searchParams.get("limit");
    let limit = 100;
    if (limitRaw !== null) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 500) {
        return errorResponse(400, "BAD_REQUEST", "limit should be in range 1..500.");
      }
      limit = parsed;
    }
    const pageTokenRaw = url.searchParams.get("page_token");
    let offset = 0;
    if (pageTokenRaw !== null) {
      if (pageTokenRaw.trim().length === 0) {
        return errorResponse(400, "BAD_REQUEST", "page_token should be a non-negative integer.");
      }
      const parsed = Number.parseInt(pageTokenRaw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return errorResponse(400, "BAD_REQUEST", "page_token should be a non-negative integer.");
      }
      offset = parsed;
    }
    const actorUserIdRaw = url.searchParams.get("actor_user_id");
    const actionRaw = url.searchParams.get("action");
    const targetTypeRaw = url.searchParams.get("target_type");
    const targetIdRaw = url.searchParams.get("target_id");
    const createdFromRaw = url.searchParams.get("from");
    const createdToRaw = url.searchParams.get("to");
    const formatRaw = (url.searchParams.get("format") ?? "json").trim().toLowerCase();
    if (formatRaw !== "json" && formatRaw !== "csv") {
      return errorResponse(400, "BAD_REQUEST", "format must be json or csv.");
    }
    const actorUserId = actorUserIdRaw && actorUserIdRaw.trim().length > 0 ? actorUserIdRaw.trim() : null;
    const action = actionRaw && actionRaw.trim().length > 0 ? actionRaw.trim() : null;
    const targetType = targetTypeRaw && targetTypeRaw.trim().length > 0 ? targetTypeRaw.trim() : null;
    const targetId = targetIdRaw && targetIdRaw.trim().length > 0 ? targetIdRaw.trim() : null;
    const createdFrom = normalizeOptionalIsoDatetime(createdFromRaw);
    if (createdFrom === "__INVALID__") {
      return errorResponse(400, "BAD_REQUEST", "from must be a valid ISO datetime.");
    }
    const createdTo = normalizeOptionalIsoDatetime(createdToRaw);
    if (createdTo === "__INVALID__") {
      return errorResponse(400, "BAD_REQUEST", "to must be a valid ISO datetime.");
    }
    if (createdFrom && createdTo && Date.parse(createdFrom) > Date.parse(createdTo)) {
      return errorResponse(400, "BAD_REQUEST", "from should be less than or equal to to.");
    }

    return withStore(env, async (store) => {
      const fetchLimit = formatRaw === "json" ? limit + 1 : limit;
      const logs = await store.listAuditLogs({
        limit: fetchLimit,
        pageToken: String(offset),
        actorUserId,
        action,
        targetType,
        targetId,
        createdFrom,
        createdTo
      });
      if (formatRaw === "csv") {
        const csvContent = buildAuditCsv(logs);
        return new Response(csvContent, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="audit-logs.csv"'
          }
        });
      }
      const hasNext = logs.length > limit;
      const pageLogs = hasNext ? logs.slice(0, limit) : logs;
      return jsonResponse({
        logs: pageLogs,
        next_page_token: hasNext ? String(offset + limit) : null
      });
    });
  }

  async function queue(
    batch: QueueBatchLike<unknown>,
    env: Env,
    _ctx: ExecutionContextLike
  ): Promise<void> {
    const logger = createLogger({
      service: "tonotionapi-queue-consumer",
      minLevel: env.LOG_LEVEL
    });
    const store = resolveStore(env);
    if (!store) {
      logger.error("queue.store_not_configured");
      throw new Error("STORE_NOT_CONFIGURED");
    }

    for (const message of batch.messages) {
      if (!isProcessItemTaskMessage(message.body)) {
        logger.error("queue.message.invalid_body", {
          message_id: message.id ?? null
        });
        ackQueueMessage(message);
        continue;
      }

      const payload = message.body;
      const taskLogger = logger.child({
        message_id: message.id ?? null,
        attempt: message.attempts ?? null,
        source: payload.source,
        user_id: payload.userId,
        item_id: payload.itemId
      });

      try {
        await processItem(store, {
          userId: payload.userId,
          itemId: payload.itemId,
          notion: toNotionRuntimeInputFromQueue(payload.notion),
          logger: taskLogger
        });
        taskLogger.info("queue.message.processed");
        ackQueueMessage(message);
      } catch (error) {
        taskLogger.error("queue.message.failed", {
          error: serializeError(error)
        });
        retryQueueMessage(message);
      }
    }
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
        () => handleConsole(request),
        () => handleConsoleLogin(request, env),
        () => handleConsoleLogout(request),
        () => handleConsoleRefresh(request, env),
        () => handleConsoleSession(request, env),
        () => handleOpenApiSpec(request),
        () => handleIngest(request, env, ctx, logger),
        () => handleListItems(request, env),
        () => handleGetItem(request, env),
        () => handleRetry(request, env, ctx, logger),
        () => handleAuthStart(request, env),
        () => handleAuthCallback(request, env),
        () => handleAuthRefresh(request, env),
        () => handleUpdateTarget(request, env),
        () => handleMeProfile(request, env),
        () => handleMeListTokens(request, env),
        () => handleMeCreateToken(request, env),
        () => handleMeRevokeToken(request, env),
        () => handleMeGetNotionCredentials(request, env),
        () => handleMePutNotionCredentials(request, env),
        () => handleMeDeleteNotionCredentials(request, env),
        () => handleMeTestNotionConnectivity(request, env),
        () => handleMeUpdateTarget(request, env),
        () => handleAdminCreateUser(request, env),
        () => handleAdminListUsers(request, env),
        () => handleAdminUpdateUser(request, env),
        () => handleAdminDeleteUser(request, env),
        () => handleAdminListUserTokens(request, env),
        () => handleAdminCreateUserToken(request, env),
        () => handleAdminRevokeUserToken(request, env),
        () => handleAdminCreateToken(request, env),
        () => handleAdminListTokens(request, env),
        () => handleAdminRevokeToken(request, env),
        () => handleAdminListAuditLogs(request, env)
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
    fetch,
    queue
  };
}

const app = createApp();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  async queue(batch: QueueBatchLike<unknown>, env: Env, ctx: ExecutionContextLike): Promise<void> {
    return app.queue(batch, env, ctx);
  }
};

export { InMemoryStore } from "./store";
