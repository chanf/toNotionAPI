import { describe, expect, it, vi } from "vitest";

import { createApp, type Env, type ExecutionContextLike } from "../src/index";
import { InMemoryStore } from "../src/store";

const DEV_ENV: Env = {
  WX2NOTION_DEV_TOKEN: "dev-token",
  CONSOLE_SESSION_SECRET: "console-session-secret",
  NOTION_MOCK: "true",
  NOTION_API_VERSION: "2025-09-03",
  NOTION_API_BASE_URL: "https://api.notion.com/v1",
  NOTION_OAUTH_CLIENT_ID: "oauth_client_id_test",
  NOTION_OAUTH_CLIENT_SECRET: "oauth_client_secret_test",
  NOTION_OAUTH_REDIRECT_URI: "https://example.com/v1/auth/notion/callback",
  CREDENTIALS_ENCRYPTION_KEY: "test-encryption-key",
  LOG_LEVEL: "error"
};
const AUTH_HEADER = { Authorization: "Bearer dev-token" };

class TestContext implements ExecutionContextLike {
  private pending: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) {
      return;
    }
    const running = [...this.pending];
    this.pending = [];
    await Promise.allSettled(running);
  }
}

function makeRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://example.com${path}`, init);
}

async function send(
  app: ReturnType<typeof createApp>,
  ctx: TestContext,
  path: string,
  init?: RequestInit,
  env: Env = DEV_ENV
): Promise<Response> {
  return app.fetch(makeRequest(path, init), env, ctx);
}

async function sendJson(
  app: ReturnType<typeof createApp>,
  ctx: TestContext,
  path: string,
  method: string,
  body: Record<string, unknown>,
  auth = true,
  env: Env = DEV_ENV
): Promise<Response> {
  return send(app, ctx, path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(auth ? AUTH_HEADER : {})
    },
    body: JSON.stringify(body)
  }, env);
}

async function connectNotion(
  app: ReturnType<typeof createApp>,
  ctx: TestContext,
  env: Env = DEV_ENV
): Promise<void> {
  const start = await send(app, ctx, "/v1/auth/notion/start", {
    method: "GET",
    headers: AUTH_HEADER
  }, env);
  expect(start.status).toBe(200);
  const state = (await start.json() as { state: string }).state;

  const oauthFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/v1/oauth/token") {
      return new Response(
        JSON.stringify({
          access_token: "ntn_access_token_from_oauth",
          refresh_token: "nrt_refresh_token_from_oauth",
          workspace_name: "OAuth Workspace",
          workspace_id: "workspace-oauth-id",
          workspace_icon: "https://example.com/icon.png",
          bot_id: "bot-oauth-id"
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    return new Response("not found", { status: 404 });
  });

  vi.stubGlobal("fetch", oauthFetch as typeof fetch);
  try {
    const callback = await send(app, ctx, `/v1/auth/notion/callback?code=oauth-code&state=${state}`, {
      method: "GET"
    }, env);
    expect(callback.status).toBe(200);
  } finally {
    vi.unstubAllGlobals();
  }
}

async function setTargetPage(
  app: ReturnType<typeof createApp>,
  ctx: TestContext,
  env: Env = DEV_ENV
): Promise<void> {
  const response = await sendJson(
    app,
    ctx,
    "/v1/settings/notion-target",
    "PUT",
    { page_id: "30db8736e20380c2bcb2f33e5c776c36", page_title: "WeChat Inbox" },
    true,
    env
  );
  expect(response.status).toBe(200);
}

async function waitForStatus(
  app: ReturnType<typeof createApp>,
  ctx: TestContext,
  itemId: string,
  status: string,
  env: Env = DEV_ENV
): Promise<Record<string, unknown>> {
  const end = Date.now() + 3000;
  let lastItem: Record<string, unknown> | null = null;
  while (Date.now() < end) {
    await ctx.flush();
    const response = await send(app, ctx, `/v1/items/${itemId}`, {
      method: "GET",
      headers: AUTH_HEADER
    }, env);
    expect(response.status).toBe(200);
    const payload = await response.json() as { item: Record<string, unknown> };
    lastItem = payload.item;
    if (payload.item.status === status) {
      return payload.item;
    }
  }
  throw new Error(`Item did not reach ${status}. last=${JSON.stringify(lastItem)}`);
}

describe("workers backend api", () => {
  it("serves openapi yaml for external api consumers", async () => {
    const app = createApp();
    const ctx = new TestContext();

    const response = await send(app, ctx, "/openapi.yaml", { method: "GET" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/yaml");
    const content = await response.text();
    expect(content).toContain("openapi: 3.0.3");
    expect(content).toContain("/v1/ingest:");
  });

  it("serves interactive api docs page", async () => {
    const app = createApp();
    const ctx = new TestContext();

    const response = await send(app, ctx, "/docs", { method: "GET" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("SwaggerUIBundle");
    expect(html).toContain("/openapi.yaml");
  });

  it("serves console management page", async () => {
    const app = createApp();
    const ctx = new TestContext();

    const response = await send(app, ctx, "/console", { method: "GET" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("toNotion 管理后台（MVP）");
    expect(html).toContain("/v1/me");
    expect(html).toContain("同步测试工具");
    expect(html).toContain("submitIngestTestBtn");
    expect(html).toContain("sessionStatus");
  });

  it("returns 500 when DB binding is missing", async () => {
    const app = createApp();
    const ctx = new TestContext();
    const response = await send(app, ctx, "/v1/items", {
      method: "GET",
      headers: AUTH_HEADER
    });
    expect(response.status).toBe(500);
    const payload = await response.json() as { error: { code: string } };
    expect(payload.error.code).toBe("STORE_NOT_CONFIGURED");
  });

  it("requires bearer token", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();
    const response = await send(app, ctx, "/v1/items", { method: "GET" });
    expect(response.status).toBe(401);
  });

  it("rejects invalid bearer token", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();
    const response = await send(app, ctx, "/v1/items", {
      method: "GET",
      headers: { Authorization: "Bearer invalid-token" }
    });
    expect(response.status).toBe(401);
  });

  it("supports console session login and cookie-based auth", async () => {
    const store = new InMemoryStore();
    await store.ensureUser({ userId: "console-user", role: "USER" });
    const issued = await store.issueAccessToken({
      userId: "console-user",
      label: "console-login",
      scopes: ["items:read", "items:write"],
      expiresAt: null
    });
    const app = createApp({ store });
    const ctx = new TestContext();

    const login = await send(app, ctx, "/v1/console/login", {
      method: "POST",
      headers: { Authorization: `Bearer ${issued.plainToken}` }
    });
    expect(login.status).toBe(200);
    const loginPayload = await login.json() as { expires_at: string };
    expect(typeof loginPayload.expires_at).toBe("string");
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("tonotion_console_session=");
    const cookieHeader = setCookie.split(";")[0];
    expect(cookieHeader).toContain("tonotion_console_session=");

    const session = await send(app, ctx, "/v1/console/session", {
      method: "GET",
      headers: { cookie: cookieHeader }
    });
    expect(session.status).toBe(200);
    const sessionPayload = await session.json() as {
      user: { id: string };
      is_admin: boolean;
      session_expires_at?: string | null;
    };
    expect(sessionPayload.user.id).toBe("console-user");
    expect(sessionPayload.is_admin).toBe(false);
    expect(typeof sessionPayload.session_expires_at).toBe("string");

    const refresh = await send(app, ctx, "/v1/console/refresh", {
      method: "POST",
      headers: { cookie: cookieHeader }
    });
    expect(refresh.status).toBe(200);
    const refreshPayload = await refresh.json() as { refreshed: boolean; expires_at: string };
    expect(refreshPayload.refreshed).toBe(true);
    expect(typeof refreshPayload.expires_at).toBe("string");
    expect(Number.isFinite(Date.parse(refreshPayload.expires_at))).toBe(true);
    expect(refresh.headers.get("set-cookie") ?? "").toContain("tonotion_console_session=");

    const me = await send(app, ctx, "/v1/me", {
      method: "GET",
      headers: { cookie: cookieHeader }
    });
    expect(me.status).toBe(200);

    const logout = await send(app, ctx, "/v1/console/logout", {
      method: "POST",
      headers: { cookie: cookieHeader }
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("requires console session cookie for refresh", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const response = await send(app, ctx, "/v1/console/refresh", {
      method: "POST"
    });
    expect(response.status).toBe(401);
    const payload = await response.json() as { error: { code: string } };
    expect(payload.error.code).toBe("UNAUTHORIZED");
  });

  it("returns CONFIG_MISSING when console session secret is absent", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();
    const envWithoutSessionSecret: Env = {
      ...DEV_ENV,
      CONSOLE_SESSION_SECRET: undefined
    };

    const response = await send(
      app,
      ctx,
      "/v1/console/login",
      {
        method: "POST",
        headers: AUTH_HEADER
      },
      envWithoutSessionSecret
    );
    expect(response.status).toBe(500);
    const payload = await response.json() as { error: { code: string } };
    expect(payload.error.code).toBe("CONFIG_MISSING");
  });

  it("supports page target settings with page_id", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();
    const response = await sendJson(
      app,
      ctx,
      "/v1/settings/notion-target",
      "PUT",
      {
        page_id: "30db8736e20380c2bcb2f33e5c776c36",
        page_title: "Notion Parent Page"
      }
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      page_id: string;
      page_title: string | null;
    };
    expect(payload.page_id).toBe("30db8736e20380c2bcb2f33e5c776c36");
    expect(payload.page_title).toBe("Notion Parent Page");
  });

  it("rejects missing page_id in settings", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();
    const response = await sendJson(
      app,
      ctx,
      "/v1/settings/notion-target",
      "PUT",
      {
        page_title: "No Page ID"
      }
    );
    expect(response.status).toBe(400);
  });

  it("admin can issue/list/revoke tokens", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const issue = await sendJson(app, ctx, "/v1/admin/tokens", "POST", {
      user_id: "user-a",
      label: "android-app",
      scopes: ["items:read"],
      expires_at: null
    });
    expect(issue.status).toBe(201);
    const issuePayload = await issue.json() as {
      token: string;
      token_record: { id: string; user_id: string; is_active: boolean };
    };
    expect(issuePayload.token).toBeTruthy();
    expect(issuePayload.token_record.user_id).toBe("user-a");
    expect(issuePayload.token_record.is_active).toBe(true);

    const list = await send(app, ctx, "/v1/admin/tokens", {
      method: "GET",
      headers: AUTH_HEADER
    });
    expect(list.status).toBe(200);
    const listPayload = await list.json() as { tokens: Array<{ id: string }> };
    expect(listPayload.tokens.length).toBe(1);
    expect(listPayload.tokens[0].id).toBe(issuePayload.token_record.id);

    const revoke = await send(app, ctx, `/v1/admin/tokens/${issuePayload.token_record.id}/revoke`, {
      method: "POST",
      headers: AUTH_HEADER
    });
    expect(revoke.status).toBe(200);

    const afterRevoke = await send(app, ctx, "/v1/items", {
      method: "GET",
      headers: { Authorization: `Bearer ${issuePayload.token}` }
    });
    expect(afterRevoke.status).toBe(401);
  });

  it("admin can manage user tokens via /v1/admin/users/{userId}/tokens", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const createUser = await sendJson(app, ctx, "/v1/admin/users", "POST", {
      user_id: "user-token-c",
      display_name: "User Token C",
      role: "USER"
    });
    expect(createUser.status).toBe(201);

    const createToken = await sendJson(
      app,
      ctx,
      "/v1/admin/users/user-token-c/tokens",
      "POST",
      {
        label: "user-token-c-device",
        scopes: ["items:read", "items:write"],
        expires_at: null
      }
    );
    expect(createToken.status).toBe(201);
    const createTokenPayload = await createToken.json() as {
      user_id: string;
      token: string;
      token_record: { id: string; user_id: string };
    };
    expect(createTokenPayload.user_id).toBe("user-token-c");
    expect(createTokenPayload.token_record.user_id).toBe("user-token-c");
    expect(createTokenPayload.token).toBeTruthy();

    const listTokens = await send(app, ctx, "/v1/admin/users/user-token-c/tokens?active=true", {
      method: "GET",
      headers: AUTH_HEADER
    });
    expect(listTokens.status).toBe(200);
    const listTokensPayload = await listTokens.json() as {
      user_id: string;
      tokens: Array<{ id: string }>;
    };
    expect(listTokensPayload.user_id).toBe("user-token-c");
    expect(listTokensPayload.tokens.some((token) => token.id === createTokenPayload.token_record.id)).toBe(true);

    const revokeToken = await send(
      app,
      ctx,
      `/v1/admin/users/user-token-c/tokens/${createTokenPayload.token_record.id}/revoke`,
      {
        method: "POST",
        headers: AUTH_HEADER
      }
    );
    expect(revokeToken.status).toBe(200);

    const blocked = await send(app, ctx, "/v1/items", {
      method: "GET",
      headers: { Authorization: `Bearer ${createTokenPayload.token}` }
    });
    expect(blocked.status).toBe(401);
  });

  it("non-admin token cannot manage tokens", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const issue = await sendJson(app, ctx, "/v1/admin/tokens", "POST", {
      user_id: "user-b",
      label: "limited-client",
      scopes: ["items:read"]
    });
    expect(issue.status).toBe(201);
    const issuePayload = await issue.json() as { token: string };
    const limitedToken = issuePayload.token;

    const forbidden = await send(app, ctx, "/v1/admin/tokens", {
      method: "GET",
      headers: { Authorization: `Bearer ${limitedToken}` }
    });
    expect(forbidden.status).toBe(403);

    const forbiddenUserPath = await send(app, ctx, "/v1/admin/users/user-b/tokens", {
      method: "GET",
      headers: { Authorization: `Bearer ${limitedToken}` }
    });
    expect(forbiddenUserPath.status).toBe(403);
  });

  it("admin can create/list/update/delete users", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const createUser = await sendJson(app, ctx, "/v1/admin/users", "POST", {
      user_id: "user-c",
      display_name: "User C",
      role: "USER"
    });
    expect(createUser.status).toBe(201);
    const createdPayload = await createUser.json() as {
      user: { id: string; role: string; status: string };
    };
    expect(createdPayload.user.id).toBe("user-c");
    expect(createdPayload.user.role).toBe("USER");
    expect(createdPayload.user.status).toBe("ACTIVE");

    const list = await send(app, ctx, "/v1/admin/users?status=ACTIVE", {
      method: "GET",
      headers: AUTH_HEADER
    });
    expect(list.status).toBe(200);
    const listPayload = await list.json() as { users: Array<{ id: string }> };
    expect(listPayload.users.some((user) => user.id === "user-c")).toBe(true);

    const disable = await sendJson(app, ctx, "/v1/admin/users/user-c", "PATCH", {
      status: "DISABLED"
    });
    expect(disable.status).toBe(200);
    const disablePayload = await disable.json() as { user: { status: string } };
    expect(disablePayload.user.status).toBe("DISABLED");

    const remove = await send(app, ctx, "/v1/admin/users/user-c", {
      method: "DELETE",
      headers: AUTH_HEADER
    });
    expect(remove.status).toBe(200);
    const removePayload = await remove.json() as { status: string };
    expect(removePayload.status).toBe("DELETED");
  });

  it("admin can list audit logs", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const createUser = await sendJson(app, ctx, "/v1/admin/users", "POST", {
      user_id: "audit-user",
      display_name: "Audit User",
      role: "USER"
    });
    expect(createUser.status).toBe(201);

    const listLogs = await send(app, ctx, "/v1/admin/audit-logs?limit=20", {
      method: "GET",
      headers: AUTH_HEADER
    });
    expect(listLogs.status).toBe(200);
    const listPayload = await listLogs.json() as {
      logs: Array<{ action: string; target_type: string | null; target_id: string | null }>;
    };
    expect(listPayload.logs.length).toBeGreaterThan(0);
    expect(
      listPayload.logs.some((log) => log.action === "USER_CREATE" && log.target_id === "audit-user")
    ).toBe(true);

    const issueLimited = await sendJson(app, ctx, "/v1/admin/tokens", "POST", {
      user_id: "limited-audit-view",
      label: "limited-audit-view-token",
      scopes: ["items:read"]
    });
    expect(issueLimited.status).toBe(201);
    const issueLimitedPayload = await issueLimited.json() as { token: string };

    const forbidden = await send(app, ctx, "/v1/admin/audit-logs", {
      method: "GET",
      headers: { Authorization: `Bearer ${issueLimitedPayload.token}` }
    });
    expect(forbidden.status).toBe(403);
  });

  it("supports /v1/me profile, token and notion settings endpoints", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();
    const envWithKey: Env = {
      ...DEV_ENV,
      CREDENTIALS_ENCRYPTION_KEY: "test-encryption-key"
    };

    const me = await send(app, ctx, "/v1/me", {
      method: "GET",
      headers: AUTH_HEADER
    }, envWithKey);
    expect(me.status).toBe(200);
    const mePayload = await me.json() as { user: { id: string; role: string } };
    expect(mePayload.user.id).toBe("demo-user");
    expect(mePayload.user.role).toBe("SUPER_ADMIN");

    const createToken = await sendJson(
      app,
      ctx,
      "/v1/me/tokens",
      "POST",
      {
        label: "self-test",
        scopes: ["items:read"]
      },
      true,
      envWithKey
    );
    expect(createToken.status).toBe(201);
    const createTokenPayload = await createToken.json() as {
      token: string;
      token_record: { id: string; user_id: string };
    };
    expect(createTokenPayload.token).toBeTruthy();
    expect(createTokenPayload.token_record.user_id).toBe("demo-user");

    const listTokens = await send(app, ctx, "/v1/me/tokens", {
      method: "GET",
      headers: AUTH_HEADER
    }, envWithKey);
    expect(listTokens.status).toBe(200);
    const listTokensPayload = await listTokens.json() as { tokens: Array<{ id: string }> };
    expect(listTokensPayload.tokens.length).toBe(1);

    const revokeToken = await send(
      app,
      ctx,
      `/v1/me/tokens/${createTokenPayload.token_record.id}/revoke`,
      {
        method: "POST",
        headers: AUTH_HEADER
      },
      envWithKey
    );
    expect(revokeToken.status).toBe(200);

    const putCredential = await sendJson(
      app,
      ctx,
      "/v1/me/notion-credentials",
      "PUT",
      {
        notion_api_token: "ntn_test_token_123456",
        notion_api_version: "2025-09-03",
        notion_api_base_url: "https://api.notion.com/v1"
      },
      true,
      envWithKey
    );
    expect(putCredential.status).toBe(200);
    const putCredentialPayload = await putCredential.json() as {
      configured: boolean;
      credential: { token_hint: string | null };
    };
    expect(putCredentialPayload.configured).toBe(true);
    expect(putCredentialPayload.credential.token_hint).toBe("123456");

    const getCredential = await send(app, ctx, "/v1/me/notion-credentials", {
      method: "GET",
      headers: AUTH_HEADER
    }, envWithKey);
    expect(getCredential.status).toBe(200);
    const getCredentialPayload = await getCredential.json() as { configured: boolean };
    expect(getCredentialPayload.configured).toBe(true);

    const setTarget = await sendJson(
      app,
      ctx,
      "/v1/me/notion-target",
      "PUT",
      {
        page_id: "30db8736e20380c2bcb2f33e5c776c36",
        page_title: "Me Target"
      },
      true,
      envWithKey
    );
    expect(setTarget.status).toBe(200);
  });

  it("tests notion connectivity with request token and saved credential", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();
    const envWithKey: Env = {
      ...DEV_ENV,
      CREDENTIALS_ENCRYPTION_KEY: "test-encryption-key"
    };

    const setTarget = await sendJson(
      app,
      ctx,
      "/v1/me/notion-target",
      "PUT",
      {
        page_id: "30db8736e20380c2bcb2f33e5c776c36",
        page_title: "Connectivity Target"
      },
      true,
      envWithKey
    );
    expect(setTarget.status).toBe(200);

    const calledAuthHeaders: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const authHeader = new Headers(init?.headers).get("authorization");
      if (authHeader) {
        calledAuthHeaders.push(authHeader);
      }
      if (url.pathname.startsWith("/v1/pages/")) {
        return new Response(JSON.stringify({ id: "target-page" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    try {
      const byRequestToken = await sendJson(
        app,
        ctx,
        "/v1/me/notion-connectivity-test",
        "POST",
        {
          notion_api_token: "ntn_request_connectivity_123456",
          notion_api_version: "2025-09-03",
          notion_api_base_url: "https://api.notion.com/v1"
        },
        true,
        envWithKey
      );
      expect(byRequestToken.status).toBe(200);
      const requestPayload = await byRequestToken.json() as {
        ok: boolean;
        token_source: string;
      };
      expect(requestPayload.ok).toBe(true);
      expect(requestPayload.token_source).toBe("request");

      const putCredential = await sendJson(
        app,
        ctx,
        "/v1/me/notion-credentials",
        "PUT",
        {
          notion_api_token: "ntn_saved_connectivity_654321",
          notion_api_version: "2025-09-03",
          notion_api_base_url: "https://api.notion.com/v1"
        },
        true,
        envWithKey
      );
      expect(putCredential.status).toBe(200);

      const byStoredToken = await sendJson(
        app,
        ctx,
        "/v1/me/notion-connectivity-test",
        "POST",
        {},
        true,
        envWithKey
      );
      expect(byStoredToken.status).toBe(200);
      const storedPayload = await byStoredToken.json() as {
        ok: boolean;
        token_source: string;
      };
      expect(storedPayload.ok).toBe(true);
      expect(storedPayload.token_source).toBe("stored");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(calledAuthHeaders.some((header) => header === "Bearer ntn_request_connectivity_123456")).toBe(true);
    expect(calledAuthHeaders.some((header) => header === "Bearer ntn_saved_connectivity_654321")).toBe(true);
  });

  it("uses notion_api_token from ingest request in real mode", async () => {
    const store = new InMemoryStore();
    const app = createApp({ store });
    const ctx = new TestContext();
    const env: Env = {
      ...DEV_ENV,
      NOTION_MOCK: "false"
    };

    await connectNotion(app, ctx, env);
    await setTargetPage(app, ctx, env);

    const putCredential = await sendJson(
      app,
      ctx,
      "/v1/me/notion-credentials",
      "PUT",
      {
        notion_api_token: "ntn_user_token_123456",
        notion_api_version: "2025-09-03",
        notion_api_base_url: "https://api.notion.com/v1"
      },
      true,
      env
    );
    expect(putCredential.status).toBe(200);

    const calledAuthHeaders: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const authHeader = new Headers(init?.headers).get("authorization");
      if (authHeader) {
        calledAuthHeaders.push(authHeader);
      }

      if (url.pathname.startsWith("/v1/pages/")) {
        return new Response(JSON.stringify({ id: "target-page" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.pathname === "/v1/pages") {
        return new Response(
          JSON.stringify({
            id: "page-user-1",
            url: "https://www.notion.so/pageuser1"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      if (url.pathname.includes("/v1/blocks/") && url.pathname.endsWith("/children")) {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("Not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    try {
      const ingest = await sendJson(
        app,
        ctx,
        "/v1/ingest",
        "POST",
        {
          client_item_id: "real-request-token-1",
          source_url: "https://mp.weixin.qq.com/s/request-token",
          raw_text: "request token test content",
          notion_api_token: "ntn_request_token_123456"
        },
        true,
        env
      );
      expect(ingest.status).toBe(202);

      const itemId = (await ingest.json() as { item_id: string }).item_id;
      const synced = await waitForStatus(app, ctx, itemId, "SYNCED", env);
      expect(synced.notion_page_id).toBe("page-user-1");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(calledAuthHeaders.some((header) => header === "Bearer ntn_request_token_123456")).toBe(true);

    const auditLogs = await store.listAuditLogs({ limit: 50 });
    expect(auditLogs.some((entry) => entry.action === "NOTION_CREDENTIAL_UPSERT")).toBe(true);
    expect(auditLogs.some((entry) => entry.action === "NOTION_TARGET_UPDATE")).toBe(true);
  });

  it("rejects disabled users even when token is active", async () => {
    const store = new InMemoryStore();
    const app = createApp({ store });
    const ctx = new TestContext();

    const issue = await sendJson(app, ctx, "/v1/admin/tokens", "POST", {
      user_id: "disabled-user",
      label: "disabled-user-token",
      scopes: ["items:read", "items:write"]
    });
    expect(issue.status).toBe(201);
    const issuePayload = await issue.json() as { token: string };

    const disable = await sendJson(app, ctx, "/v1/admin/users/disabled-user", "PATCH", {
      status: "DISABLED"
    });
    expect(disable.status).toBe(200);

    const blocked = await send(app, ctx, "/v1/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${issuePayload.token}` }
    });
    expect(blocked.status).toBe(403);
    const blockedPayload = await blocked.json() as { error: { code: string } };
    expect(blockedPayload.error.code).toBe("USER_INACTIVE");
  });

  it("returns 404 for unknown route", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const response = await send(app, ctx, "/v1/unknown-route", {
      method: "GET",
      headers: AUTH_HEADER
    });
    expect(response.status).toBe(404);
    const payload = await response.json() as { error: { code: string } };
    expect(payload.error.code).toBe("NOT_FOUND");
  });

  it("validates list item query parameters", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const invalidStatus = await send(app, ctx, "/v1/items?status=NOT_EXISTS", {
      method: "GET",
      headers: AUTH_HEADER
    });
    expect(invalidStatus.status).toBe(400);

    const invalidPageSizeLow = await send(app, ctx, "/v1/items?page_size=0", {
      method: "GET",
      headers: AUTH_HEADER
    });
    expect(invalidPageSizeLow.status).toBe(400);

    const invalidPageSizeHigh = await send(app, ctx, "/v1/items?page_size=101", {
      method: "GET",
      headers: AUTH_HEADER
    });
    expect(invalidPageSizeHigh.status).toBe(400);
  });

  it("validates notion auth callback parameters and oauth state", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const missingCode = await send(app, ctx, "/v1/auth/notion/callback?state=state-only", {
      method: "GET"
    });
    expect(missingCode.status).toBe(400);

    const invalidState = await send(app, ctx, "/v1/auth/notion/callback?code=demo&state=not-found", {
      method: "GET"
    });
    expect(invalidState.status).toBe(400);
  });

  it("refreshes notion oauth token for current user", async () => {
    const store = new InMemoryStore();
    const app = createApp({ store });
    const ctx = new TestContext();

    await connectNotion(app, ctx, DEV_ENV);

    const refreshFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/v1/oauth/token") {
        return new Response(
          JSON.stringify({
            access_token: "ntn_access_token_after_refresh",
            refresh_token: "nrt_refresh_token_after_refresh",
            workspace_name: "OAuth Workspace Refreshed",
            workspace_id: "workspace-refreshed",
            workspace_icon: "https://example.com/icon-refreshed.png",
            bot_id: "bot-refreshed"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", refreshFetch as typeof fetch);
    try {
      const refresh = await send(app, ctx, "/v1/auth/notion/refresh", {
        method: "POST",
        headers: AUTH_HEADER
      }, DEV_ENV);
      expect(refresh.status).toBe(200);
      const refreshPayload = await refresh.json() as {
        refreshed: boolean;
        has_refresh_token: boolean;
        workspace_name: string | null;
      };
      expect(refreshPayload.refreshed).toBe(true);
      expect(refreshPayload.has_refresh_token).toBe(true);
      expect(refreshPayload.workspace_name).toBe("OAuth Workspace Refreshed");
    } finally {
      vi.unstubAllGlobals();
    }

    const getCredential = await send(app, ctx, "/v1/me/notion-credentials", {
      method: "GET",
      headers: AUTH_HEADER
    }, DEV_ENV);
    expect(getCredential.status).toBe(200);
    const credentialPayload = await getCredential.json() as {
      configured: boolean;
      credential: { has_refresh_token: boolean } | null;
    };
    expect(credentialPayload.configured).toBe(true);
    expect(credentialPayload.credential?.has_refresh_token).toBe(true);

    const auditLogs = await store.listAuditLogs({ limit: 50 });
    expect(auditLogs.some((entry) => entry.action === "NOTION_OAUTH_CALLBACK")).toBe(true);
    expect(auditLogs.some((entry) => entry.action === "NOTION_OAUTH_REFRESH")).toBe(true);
  });

  it("returns 400 when oauth refresh token is not configured", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const putCredential = await sendJson(
      app,
      ctx,
      "/v1/me/notion-credentials",
      "PUT",
      {
        notion_api_token: "ntn_no_refresh_token",
        notion_api_version: "2025-09-03",
        notion_api_base_url: "https://api.notion.com/v1"
      },
      true,
      DEV_ENV
    );
    expect(putCredential.status).toBe(200);

    const refresh = await send(app, ctx, "/v1/auth/notion/refresh", {
      method: "POST",
      headers: AUTH_HEADER
    }, DEV_ENV);
    expect(refresh.status).toBe(400);
    const payload = await refresh.json() as { error: { code: string } };
    expect(payload.error.code).toBe("BAD_REQUEST");
  });

  it("validates admin user create/update/delete edge cases", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const invalidRole = await sendJson(app, ctx, "/v1/admin/users", "POST", {
      user_id: "edge-user",
      role: "ROOT"
    });
    expect(invalidRole.status).toBe(400);

    const create = await sendJson(app, ctx, "/v1/admin/users", "POST", {
      user_id: "edge-user",
      role: "USER"
    });
    expect(create.status).toBe(201);

    const duplicate = await sendJson(app, ctx, "/v1/admin/users", "POST", {
      user_id: "edge-user",
      role: "USER"
    });
    expect(duplicate.status).toBe(409);

    const emptyPatch = await sendJson(app, ctx, "/v1/admin/users/edge-user", "PATCH", {});
    expect(emptyPatch.status).toBe(400);

    const invalidDisplayNamePatch = await sendJson(app, ctx, "/v1/admin/users/edge-user", "PATCH", {
      display_name: 123
    });
    expect(invalidDisplayNamePatch.status).toBe(400);

    const notFoundPatch = await sendJson(app, ctx, "/v1/admin/users/not-found", "PATCH", {
      status: "DISABLED"
    });
    expect(notFoundPatch.status).toBe(404);

    const selfDelete = await send(app, ctx, "/v1/admin/users/demo-user", {
      method: "DELETE",
      headers: AUTH_HEADER
    });
    expect(selfDelete.status).toBe(400);
  });

  it("validates me token constraints for non-admin users", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const issueLimited = await sendJson(app, ctx, "/v1/admin/tokens", "POST", {
      user_id: "limited-user",
      label: "limited-user-token",
      scopes: ["items:read"]
    });
    expect(issueLimited.status).toBe(201);
    const limitedToken = (await issueLimited.json() as { token: string }).token;

    const forbiddenPrivileged = await sendJson(
      app,
      ctx,
      "/v1/me/tokens",
      "POST",
      {
        label: "forbidden-admin-scope",
        scopes: ["admin:tokens"]
      },
      false,
      DEV_ENV
    );
    expect(forbiddenPrivileged.status).toBe(401);

    const forbiddenWithUserToken = await send(
      app,
      ctx,
      "/v1/me/tokens",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${limitedToken}`
        },
        body: JSON.stringify({
          label: "forbidden-admin-scope",
          scopes: ["admin:tokens"]
        })
      }
    );
    expect(forbiddenWithUserToken.status).toBe(403);

    const invalidExpiresAt = await send(
      app,
      ctx,
      "/v1/me/tokens",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${limitedToken}`
        },
        body: JSON.stringify({
          label: "invalid-expire",
          scopes: ["items:read"],
          expires_at: "not-a-date"
        })
      }
    );
    expect(invalidExpiresAt.status).toBe(400);
  });

  it("rejects expired tokens", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const issueExpired = await sendJson(app, ctx, "/v1/admin/tokens", "POST", {
      user_id: "expired-user",
      label: "expired-token",
      scopes: ["items:read"],
      expires_at: "2000-01-01T00:00:00.000Z"
    });
    expect(issueExpired.status).toBe(201);
    const token = (await issueExpired.json() as { token: string }).token;

    const me = await send(app, ctx, "/v1/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(me.status).toBe(401);
    const payload = await me.json() as { error: { code: string } };
    expect(payload.error.code).toBe("TOKEN_EXPIRED");
  });

  it("validates notion credential and target endpoints", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const missingKeyEnv: Env = {
      ...DEV_ENV,
      CREDENTIALS_ENCRYPTION_KEY: undefined
    };
    const missingKey = await sendJson(
      app,
      ctx,
      "/v1/me/notion-credentials",
      "PUT",
      {
        notion_api_token: "ntn_missing_key"
      },
      true,
      missingKeyEnv
    );
    expect(missingKey.status).toBe(500);

    const envWithKey: Env = {
      ...DEV_ENV,
      CREDENTIALS_ENCRYPTION_KEY: "test-encryption-key"
    };
    const missingToken = await sendJson(
      app,
      ctx,
      "/v1/me/notion-credentials",
      "PUT",
      {
        notion_api_version: "2025-09-03"
      },
      true,
      envWithKey
    );
    expect(missingToken.status).toBe(400);

    const missingPageId = await sendJson(
      app,
      ctx,
      "/v1/me/notion-target",
      "PUT",
      { page_title: "missing-page-id" },
      true,
      envWithKey
    );
    expect(missingPageId.status).toBe(400);
  });

  it("validates admin token and audit query boundaries", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const invalidActive = await send(app, ctx, "/v1/admin/users/demo-user/tokens?active=maybe", {
      method: "GET",
      headers: AUTH_HEADER
    });
    expect(invalidActive.status).toBe(400);

    const invalidLimit = await send(app, ctx, "/v1/admin/audit-logs?limit=0", {
      method: "GET",
      headers: AUTH_HEADER
    });
    expect(invalidLimit.status).toBe(400);

    const invalidExpiresAt = await sendJson(
      app,
      ctx,
      "/v1/admin/users/demo-user/tokens",
      "POST",
      {
        label: "invalid-date",
        expires_at: "bad-date"
      }
    );
    expect(invalidExpiresAt.status).toBe(400);

    const createForMissingUser = await sendJson(
      app,
      ctx,
      "/v1/admin/users/not-found/tokens",
      "POST",
      {
        label: "missing-user",
        scopes: ["items:read"]
      }
    );
    expect(createForMissingUser.status).toBe(404);
  });

  it("returns 404 when revoking token through mismatched user path", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const createUserA = await sendJson(app, ctx, "/v1/admin/users", "POST", {
      user_id: "user-a-revoke",
      role: "USER"
    });
    expect(createUserA.status).toBe(201);
    const createUserB = await sendJson(app, ctx, "/v1/admin/users", "POST", {
      user_id: "user-b-revoke",
      role: "USER"
    });
    expect(createUserB.status).toBe(201);

    const createTokenA = await sendJson(
      app,
      ctx,
      "/v1/admin/users/user-a-revoke/tokens",
      "POST",
      {
        label: "token-a",
        scopes: ["items:read"]
      }
    );
    expect(createTokenA.status).toBe(201);
    const tokenId = (await createTokenA.json() as { token_record: { id: string } }).token_record.id;

    const revokeWithWrongUser = await send(
      app,
      ctx,
      `/v1/admin/users/user-b-revoke/tokens/${tokenId}/revoke`,
      {
        method: "POST",
        headers: AUTH_HEADER
      }
    );
    expect(revokeWithWrongUser.status).toBe(404);
  });

  it("returns not found for missing item detail and retry", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const getMissing = await send(app, ctx, "/v1/items/missing-item", {
      method: "GET",
      headers: AUTH_HEADER
    });
    expect(getMissing.status).toBe(404);

    const retryMissing = await send(app, ctx, "/v1/items/missing-item/retry", {
      method: "POST",
      headers: AUTH_HEADER
    });
    expect(retryMissing.status).toBe(404);
  });

  it("ingest -> synced happy path", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    await connectNotion(app, ctx);
    await setTargetPage(app, ctx);

    const ingest = await sendJson(app, ctx, "/v1/ingest", "POST", {
      client_item_id: "happy-1",
      source_url: "https://mp.weixin.qq.com/s/demo-1",
      raw_text: "demo content"
    });
    expect(ingest.status).toBe(202);

    const itemId = (await ingest.json() as { item_id: string }).item_id;
    const item = await waitForStatus(app, ctx, itemId, "SYNCED");
    expect(item.notion_page_id).toBeTruthy();
    expect(item.notion_page_url).toBeTruthy();
  });

  it("fails sync when notion target page is missing", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    await connectNotion(app, ctx);

    const ingest = await sendJson(app, ctx, "/v1/ingest", "POST", {
      client_item_id: "missing-target-1",
      source_url: "https://mp.weixin.qq.com/s/missing-target",
      raw_text: "target missing"
    });
    expect(ingest.status).toBe(202);

    const itemId = (await ingest.json() as { item_id: string }).item_id;
    const failed = await waitForStatus(app, ctx, itemId, "SYNC_FAILED");
    const failedError = failed.error as { code: string };
    expect(failedError.code).toBe("NOTION_TARGET_MISSING");
  });

  it("fails sync when notion token is missing in real mode", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();
    const realModeEnv: Env = {
      ...DEV_ENV,
      NOTION_MOCK: "false"
    };

    await connectNotion(app, ctx, realModeEnv);
    await setTargetPage(app, ctx, realModeEnv);

    const ingest = await sendJson(
      app,
      ctx,
      "/v1/ingest",
      "POST",
      {
        client_item_id: "missing-token-1",
        source_url: "https://mp.weixin.qq.com/s/missing-token",
        raw_text: "token missing"
      },
      true,
      realModeEnv
    );
    expect(ingest.status).toBe(400);
    const payload = await ingest.json() as { error: { code: string } };
    expect(payload.error.code).toBe("BAD_REQUEST");
  });

  it("requires notion_api_token when retrying in real mode", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();
    const realModeEnv: Env = {
      ...DEV_ENV,
      NOTION_MOCK: "false"
    };

    const retryWithoutToken = await send(
      app,
      ctx,
      "/v1/items/non-existing/retry",
      {
        method: "POST",
        headers: AUTH_HEADER
      },
      realModeEnv
    );
    expect(retryWithoutToken.status).toBe(400);

    const retryWithToken = await send(
      app,
      ctx,
      "/v1/items/non-existing/retry",
      {
        method: "POST",
        headers: {
          ...AUTH_HEADER,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          notion_api_token: "ntn_retry_token_123456"
        })
      },
      realModeEnv
    );
    expect(retryWithToken.status).toBe(404);
  });

  it("deduplicates by normalized url", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    await connectNotion(app, ctx);
    await setTargetPage(app, ctx);

    const first = await sendJson(app, ctx, "/v1/ingest", "POST", {
      client_item_id: "dup-1",
      source_url: "https://mp.weixin.qq.com/s/demo-dup?utm_source=timeline",
      raw_text: "text1"
    });
    expect(first.status).toBe(202);
    const firstId = (await first.json() as { item_id: string }).item_id;

    const second = await sendJson(app, ctx, "/v1/ingest", "POST", {
      client_item_id: "dup-2",
      source_url: "https://mp.weixin.qq.com/s/demo-dup",
      raw_text: "text2"
    });
    expect(second.status).toBe(202);
    const secondPayload = await second.json() as { duplicated_from_item_id: string | null };
    expect(secondPayload.duplicated_from_item_id).toBe(firstId);
  });

  it("retry succeeds after notion setup", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    const ingest = await sendJson(app, ctx, "/v1/ingest", "POST", {
      client_item_id: "retry-1",
      source_url: "https://mp.weixin.qq.com/s/demo-retry",
      raw_text: "retry content"
    });
    expect(ingest.status).toBe(202);
    const itemId = (await ingest.json() as { item_id: string }).item_id;

    const failed = await waitForStatus(app, ctx, itemId, "SYNC_FAILED");
    const failedError = failed.error as { code: string };
    expect(failedError.code).toBe("NOTION_NOT_CONNECTED");

    await connectNotion(app, ctx);
    await setTargetPage(app, ctx);

    const retry = await send(app, ctx, `/v1/items/${itemId}/retry`, {
      method: "POST",
      headers: AUTH_HEADER
    });
    expect(retry.status).toBe(202);
    const retryPayload = await retry.json() as { status: string };
    expect(retryPayload.status).toBe("RECEIVED");

    const synced = await waitForStatus(app, ctx, itemId, "SYNCED");
    expect(synced.error).toBeNull();
  });
});
