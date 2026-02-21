import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../src/store";

describe("in-memory store", () => {
  it("marks user deleted and revokes related resources", async () => {
    const store = new InMemoryStore();
    await store.ensureUser({ userId: "u-delete", role: "USER" });
    const issued = await store.issueAccessToken({
      userId: "u-delete",
      label: "device-a",
      scopes: ["items:read", "items:write"],
      expiresAt: null
    });
    await store.upsertUserNotionCredential({
      userId: "u-delete",
      tokenCiphertext: "cipher",
      tokenIv: "iv",
      tokenTag: "tag",
      tokenHint: "123456",
      apiVersion: "2025-09-03",
      apiBaseUrl: "https://api.notion.com/v1"
    });

    const deleted = await store.deleteUser("u-delete");
    expect(deleted).toBe(true);

    const user = await store.getUser("u-delete");
    expect(user?.status).toBe("DELETED");
    expect(user?.deleted_at).toBeTruthy();

    const token = await store.getAccessTokenById(issued.token.id);
    expect(token?.is_active).toBe(false);

    const credential = await store.getUserNotionCredential("u-delete");
    expect(credential).toBeNull();
  });

  it("deduplicates ingest by normalized url for the same user", async () => {
    const store = new InMemoryStore();
    await store.ensureUser({ userId: "u-dedup", role: "USER" });

    const first = await store.ingestItem({
      userId: "u-dedup",
      clientItemId: "item-1",
      sourceUrl: "https://mp.weixin.qq.com/s/demo-dedup?utm_source=timeline",
      rawText: "content 1",
      sourceType: "wechat_mp"
    });
    expect(first.duplicated).toBe(false);

    const second = await store.ingestItem({
      userId: "u-dedup",
      clientItemId: "item-2",
      sourceUrl: "https://mp.weixin.qq.com/s/demo-dedup",
      rawText: "content 2",
      sourceType: "wechat_mp"
    });
    expect(second.duplicated).toBe(true);
    expect(second.item.id).toBe(first.item.id);
  });

  it("supports token lifecycle: issue, query by hash, touch and revoke", async () => {
    const store = new InMemoryStore();
    const issued = await store.issueAccessToken({
      userId: "u-token",
      label: "mobile",
      scopes: ["items:read"],
      expiresAt: null
    });

    const byHash = await store.getAccessTokenByHash(issued.token.token_hash);
    expect(byHash?.id).toBe(issued.token.id);
    expect(byHash?.is_active).toBe(true);

    const now = "2026-02-20T00:00:00.000Z";
    await store.touchAccessToken(issued.token.id, now);
    const touched = await store.getAccessTokenById(issued.token.id);
    expect(touched?.last_used_at).toBe(now);

    const revoked = await store.revokeAccessToken({ tokenId: issued.token.id });
    expect(revoked).toBe(true);
    const afterRevoke = await store.getAccessTokenById(issued.token.id);
    expect(afterRevoke?.is_active).toBe(false);
  });

  it("supports user notion credential upsert/get/delete flow", async () => {
    const store = new InMemoryStore();

    const upserted = await store.upsertUserNotionCredential({
      userId: "u-credential",
      tokenCiphertext: "cipher",
      tokenIv: "iv",
      tokenTag: "tag",
      tokenHint: "654321",
      apiVersion: "2025-09-03",
      apiBaseUrl: "https://api.notion.com/v1"
    });
    expect(upserted.user_id).toBe("u-credential");
    expect(upserted.token_hint).toBe("654321");

    const masked = await store.getUserNotionCredential("u-credential");
    expect(masked?.token_hint).toBe("654321");

    const secret = await store.getUserNotionCredentialSecret("u-credential");
    expect(secret?.token_ciphertext).toBe("cipher");
    expect(secret?.token_iv).toBe("iv");
    expect(secret?.token_tag).toBe("tag");

    const deleted = await store.deleteUserNotionCredential("u-credential");
    expect(deleted).toBe(true);
    const afterDelete = await store.getUserNotionCredential("u-credential");
    expect(afterDelete).toBeNull();
  });
});
