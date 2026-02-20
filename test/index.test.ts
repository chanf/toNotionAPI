import { describe, expect, it } from "vitest";

import { createApp, type Env, type ExecutionContextLike } from "../src/index";
import { InMemoryStore } from "../src/store";

const DEV_ENV: Env = { WX2NOTION_DEV_TOKEN: "dev-token", NOTION_MOCK: "true" };
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

  const callback = await send(app, ctx, `/v1/auth/notion/callback?code=demo&state=${state}`, {
    method: "GET"
  }, env);
  expect(callback.status).toBe(200);
}

async function setTargetDatabase(
  app: ReturnType<typeof createApp>,
  ctx: TestContext,
  env: Env = DEV_ENV
): Promise<void> {
  const response = await sendJson(
    app,
    ctx,
    "/v1/settings/notion-target",
    "PUT",
    { database_id: "db_demo_123", database_title: "WeChat Inbox" },
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
  });

  it("ingest -> synced happy path", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    await connectNotion(app, ctx);
    await setTargetDatabase(app, ctx);

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

  it("fails sync when notion target database is missing", async () => {
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
    const realModeEnv: Env = { WX2NOTION_DEV_TOKEN: "dev-token", NOTION_MOCK: "false" };

    await connectNotion(app, ctx, realModeEnv);
    await setTargetDatabase(app, ctx, realModeEnv);

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
    expect(ingest.status).toBe(202);

    const itemId = (await ingest.json() as { item_id: string }).item_id;
    const failed = await waitForStatus(app, ctx, itemId, "SYNC_FAILED", realModeEnv);
    const failedError = failed.error as { code: string };
    expect(failedError.code).toBe("NOTION_TOKEN_MISSING");
  });

  it("deduplicates by normalized url", async () => {
    const app = createApp({ store: new InMemoryStore() });
    const ctx = new TestContext();

    await connectNotion(app, ctx);
    await setTargetDatabase(app, ctx);

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
    await setTargetDatabase(app, ctx);

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
