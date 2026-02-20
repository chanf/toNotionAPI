import { createLogger, serializeError, type Logger } from "./logger";
import type { Store } from "./store";
import { nowIso, randomId } from "./utils";

const DEFAULT_NOTION_API_BASE_URL = "https://api.notion.com/v1";
const DEFAULT_NOTION_API_VERSION = "2022-06-28";
const NOTION_TITLE_MAX_LENGTH = 200;
const NOTION_RICH_TEXT_MAX_LENGTH = 1900;

class ParserError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retriable: boolean
  ) {
    super(message);
  }
}

class NotionSyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retriable: boolean
  ) {
    super(message);
  }
}

type ParsedArticle = {
  title: string;
  summary: string;
  coverUrl: string | null;
  contentPlaintext: string;
};

export type NotionRuntimeInput = {
  mock?: boolean;
  apiToken?: string | null;
  apiVersion?: string | null;
  apiBaseUrl?: string | null;
};

type ResolvedNotionRuntime = {
  mock: boolean;
  apiToken: string | null;
  apiVersion: string;
  apiBaseUrl: string;
};

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength - 1).trimEnd() + "…";
}

function normalizeNotionRuntime(input: NotionRuntimeInput | undefined): ResolvedNotionRuntime {
  const apiToken = input?.apiToken?.trim() || null;
  const apiVersion = input?.apiVersion?.trim() || DEFAULT_NOTION_API_VERSION;
  const apiBaseUrl = (input?.apiBaseUrl?.trim() || DEFAULT_NOTION_API_BASE_URL).replace(/\/+$/, "");
  return {
    mock: Boolean(input?.mock),
    apiToken,
    apiVersion,
    apiBaseUrl
  };
}

function parseTitleFromUrl(url: URL): string | null {
  return url.searchParams.get("title");
}

async function parseWeChatArticle(url: string, rawText: string | null): Promise<ParsedArticle> {
  await sleep(80);
  if (url.includes("fail-parse")) {
    throw new ParserError(
      "PARSE_FETCH_FAILED",
      "Failed to fetch article content from source URL.",
      true
    );
  }
  const parsed = new URL(url);
  const title = parseTitleFromUrl(parsed) ?? `WeChat Article - ${parsed.hostname}`;
  const content = rawText ?? `Captured URL: ${url}`;
  return {
    title,
    summary: content.slice(0, 120),
    coverUrl: null,
    contentPlaintext: content
  };
}

function buildNotionChildrenBlocks(input: {
  normalizedUrl: string;
  summary: string;
  contentPlaintext: string;
}): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const sourceUrl = truncateText(input.normalizedUrl, NOTION_RICH_TEXT_MAX_LENGTH);
  blocks.push({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: {
            content: "Source: "
          }
        },
        {
          type: "text",
          text: {
            content: sourceUrl,
            link: { url: input.normalizedUrl }
          }
        }
      ]
    }
  });

  const summary = input.summary.trim();
  if (summary.length > 0) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: truncateText(summary, NOTION_RICH_TEXT_MAX_LENGTH)
            }
          }
        ]
      }
    });
  }

  const content = input.contentPlaintext.trim();
  if (content.length > 0 && content !== summary) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: truncateText(content, NOTION_RICH_TEXT_MAX_LENGTH)
            }
          }
        ]
      }
    });
  }

  return blocks;
}

function buildNotionPagePayload(input: {
  databaseId: string;
  normalizedUrl: string;
  article: ParsedArticle;
}): Record<string, unknown> {
  const title = truncateText(input.article.title || "WeChat Article", NOTION_TITLE_MAX_LENGTH);
  return {
    parent: {
      database_id: input.databaseId
    },
    properties: {
      title: {
        title: [
          {
            type: "text",
            text: {
              content: title
            }
          }
        ]
      }
    },
    children: buildNotionChildrenBlocks({
      normalizedUrl: input.normalizedUrl,
      summary: input.article.summary,
      contentPlaintext: input.article.contentPlaintext
    })
  };
}

async function parseNotionErrorMessage(response: Response): Promise<string | null> {
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

function mapNotionHttpError(status: number, detail: string | null): NotionSyncError {
  const suffix = detail ? ` ${detail}` : "";
  if (status === 429) {
    return new NotionSyncError(
      "NOTION_RATE_LIMITED",
      `Notion API rate limit exceeded.${suffix}`,
      true
    );
  }
  if (status >= 500) {
    return new NotionSyncError(
      "NOTION_UPSTREAM_ERROR",
      `Notion upstream service is unavailable.${suffix}`,
      true
    );
  }
  if (status === 401 || status === 403) {
    return new NotionSyncError("NOTION_AUTH_FAILED", `Notion authentication failed.${suffix}`, false);
  }
  if (status === 404) {
    return new NotionSyncError(
      "NOTION_TARGET_NOT_FOUND",
      `Notion target database not found or not shared.${suffix}`,
      false
    );
  }
  if (status === 400) {
    return new NotionSyncError(
      "NOTION_BAD_REQUEST",
      `Notion rejected request payload.${suffix}`,
      false
    );
  }
  return new NotionSyncError(
    "NOTION_HTTP_ERROR",
    `Notion request failed with status ${status}.${suffix}`,
    false
  );
}

async function syncToNotion(input: {
  normalizedUrl: string;
  settings: { notion_connected: boolean; target_database_id: string | null };
  article: ParsedArticle;
  runtime: NotionRuntimeInput | undefined;
}): Promise<{ notionPageId: string; notionPageUrl: string }> {
  const runtime = normalizeNotionRuntime(input.runtime);
  if (!input.settings.notion_connected) {
    throw new NotionSyncError(
      "NOTION_NOT_CONNECTED",
      "Notion is not authorized for current user.",
      false
    );
  }
  if (!input.settings.target_database_id) {
    throw new NotionSyncError(
      "NOTION_TARGET_MISSING",
      "Notion target database is not configured.",
      false
    );
  }
  if (runtime.mock) {
    await sleep(80);
    if (input.normalizedUrl.includes("fail-sync")) {
      throw new NotionSyncError(
        "NOTION_RATE_LIMITED",
        "Simulated Notion 429. Please retry later.",
        true
      );
    }
    const pageId = randomId();
    return {
      notionPageId: pageId,
      notionPageUrl: `https://www.notion.so/${pageId.replaceAll("-", "")}`
    };
  }

  if (!runtime.apiToken) {
    throw new NotionSyncError(
      "NOTION_TOKEN_MISSING",
      "NOTION_API_TOKEN is required when NOTION_MOCK is disabled.",
      false
    );
  }

  const response = await fetch(`${runtime.apiBaseUrl}/pages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.apiToken}`,
      "content-type": "application/json",
      "notion-version": runtime.apiVersion
    },
    body: JSON.stringify(
      buildNotionPagePayload({
        databaseId: input.settings.target_database_id,
        normalizedUrl: input.normalizedUrl,
        article: input.article
      })
    )
  });

  if (!response.ok) {
    const detail = await parseNotionErrorMessage(response);
    throw mapNotionHttpError(response.status, detail);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const pageId = typeof payload.id === "string" ? payload.id : null;
  const pageUrl = typeof payload.url === "string" ? payload.url : null;
  if (!pageId || !pageUrl) {
    throw new NotionSyncError(
      "NOTION_BAD_RESPONSE",
      "Notion response missing page id or url.",
      true
    );
  }

  return {
    notionPageId: pageId,
    notionPageUrl: pageUrl
  };
}

export async function processItem(
  store: Store,
  input: { userId: string; itemId: string; notion?: NotionRuntimeInput; logger?: Logger }
): Promise<void> {
  const traceId = randomId().replaceAll("-", "");
  const logger =
    input.logger?.child({ trace_id: traceId }) ??
    createLogger({
      service: "tonotionapi-pipeline",
      bindings: {
        trace_id: traceId
      }
    });

  logger.info("pipeline.started", {
    user_id: input.userId,
    item_id: input.itemId
  });

  const item = await store.patchItem({
    userId: input.userId,
    itemId: input.itemId,
    fields: { status: "PARSING", error: null }
  });
  if (!item) {
    logger.warn("pipeline.item_not_found", {
      user_id: input.userId,
      item_id: input.itemId
    });
    return;
  }

  let parsedArticle: ParsedArticle;
  try {
    parsedArticle = await parseWeChatArticle(item.normalized_url, item.raw_text);
    await store.patchItem({
      userId: input.userId,
      itemId: input.itemId,
      fields: {
        title: parsedArticle.title,
        summary: parsedArticle.summary,
        cover_url: parsedArticle.coverUrl,
        content_plaintext: parsedArticle.contentPlaintext
      }
    });
    logger.info("pipeline.parse.succeeded", {
      user_id: input.userId,
      item_id: input.itemId
    });
  } catch (error) {
    if (error instanceof ParserError) {
      await store.setError({
        userId: input.userId,
        itemId: input.itemId,
        status: "PARSE_FAILED",
        code: error.code,
        message: error.message,
        retriable: error.retriable,
        traceId
      });
      logger.warn("pipeline.parse.failed", {
        user_id: input.userId,
        item_id: input.itemId,
        code: error.code,
        retriable: error.retriable,
        error_message: error.message
      });
      return;
    }
    await store.setError({
      userId: input.userId,
      itemId: input.itemId,
      status: "PARSE_FAILED",
      code: "PARSE_UNKNOWN",
      message: "Unknown parse error.",
      retriable: true,
      traceId
    });
    logger.error("pipeline.parse.failed", {
      user_id: input.userId,
      item_id: input.itemId,
      code: "PARSE_UNKNOWN",
      retriable: true,
      error: serializeError(error)
    });
    return;
  }

  const syncingItem = await store.patchItem({
    userId: input.userId,
    itemId: input.itemId,
    fields: { status: "SYNCING", error: null }
  });
  if (!syncingItem) {
    logger.warn("pipeline.sync.skipped_item_missing", {
      user_id: input.userId,
      item_id: input.itemId
    });
    return;
  }

  try {
    const settings = await store.getSettings(input.userId);
    const notion = await syncToNotion({
      normalizedUrl: syncingItem.normalized_url,
      settings,
      article: parsedArticle,
      runtime: input.notion
    });
    await store.patchItem({
      userId: input.userId,
      itemId: input.itemId,
      fields: {
        status: "SYNCED",
        notion_page_id: notion.notionPageId,
        notion_page_url: notion.notionPageUrl,
        error: null,
        updated_at: nowIso()
      }
    });
    logger.info("pipeline.sync.succeeded", {
      user_id: input.userId,
      item_id: input.itemId,
      notion_page_id: notion.notionPageId
    });
  } catch (error) {
    if (error instanceof NotionSyncError) {
      await store.setError({
        userId: input.userId,
        itemId: input.itemId,
        status: "SYNC_FAILED",
        code: error.code,
        message: error.message,
        retriable: error.retriable,
        traceId
      });
      logger.warn("pipeline.sync.failed", {
        user_id: input.userId,
        item_id: input.itemId,
        code: error.code,
        retriable: error.retriable,
        error_message: error.message
      });
      return;
    }
    await store.setError({
      userId: input.userId,
      itemId: input.itemId,
      status: "SYNC_FAILED",
      code: "SYNC_UNKNOWN",
      message: "Unknown sync error.",
      retriable: true,
      traceId
    });
    logger.error("pipeline.sync.failed", {
      user_id: input.userId,
      item_id: input.itemId,
      code: "SYNC_UNKNOWN",
      retriable: true,
      error: serializeError(error)
    });
  }
}
