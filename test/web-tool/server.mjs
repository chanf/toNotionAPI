import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FINAL_STATUSES = new Set(["SYNCED", "SYNC_FAILED", "PARSE_FAILED"]);
const DEFAULT_BASE_URL = normalizeBaseUrl(
  process.env.WEB_TOOL_API_BASE_URL ?? "https://your-worker.example.com"
);
const API_TOKEN = (process.env.WEB_TOOL_API_TOKEN ?? "").trim();
const PORT = parsePositiveInt(process.env.WEB_TOOL_PORT, 4173);
const POLL_TIMEOUT_MS = parsePositiveInt(process.env.WEB_TOOL_POLL_TIMEOUT_MS, 60000);
const POLL_INTERVAL_MS = parsePositiveInt(process.env.WEB_TOOL_POLL_INTERVAL_MS, 2000);

const currentDir = dirname(fileURLToPath(import.meta.url));
const indexHtml = await readFile(join(currentDir, "index.html"), "utf8");

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(value) {
  return String(value).trim().replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(payload);
}

function extractItemId(value) {
  return value && typeof value === "object" && typeof value.item_id === "string" ? value.item_id : null;
}

function summarizeItem(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    id: value.id ?? null,
    status: value.status ?? null,
    source_url: value.source_url ?? null,
    title: value.title ?? null,
    notion_page_id: value.notion_page_id ?? null,
    notion_page_url: value.notion_page_url ?? null,
    error: value.error ?? null,
    created_at: value.created_at ?? null,
    updated_at: value.updated_at ?? null
  };
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!text) {
    return { response, body: null };
  }
  try {
    return { response, body: JSON.parse(text) };
  } catch {
    return { response, body: text };
  }
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

async function submitToNotion(sourceUrl, notionApiToken) {
  if (!API_TOKEN) {
    throw new Error("WEB_TOOL_API_TOKEN is required.");
  }
  if (!notionApiToken) {
    throw new Error("notion_api_token is required.");
  }

  const clientItemId = `web-tool-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const ingestPayload = {
    client_item_id: clientItemId,
    source_url: sourceUrl,
    raw_text: sourceUrl,
    notion_api_token: notionApiToken
  };

  const ingestUrl = `${DEFAULT_BASE_URL}/v1/ingest`;
  const ingestResult = await requestJson(ingestUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(ingestPayload)
  });

  const ingestSummary = {
    status_code: ingestResult.response.status,
    body: ingestResult.body
  };

  const itemId = extractItemId(ingestResult.body);
  if (!itemId || !ingestResult.response.ok) {
    return {
      base_url: DEFAULT_BASE_URL,
      item_id: itemId,
      ingest: ingestSummary,
      final: null
    };
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let pollCount = 0;
  let lastStatusCode = null;
  let lastItem = null;

  while (Date.now() < deadline) {
    pollCount += 1;
    await sleep(POLL_INTERVAL_MS);

    const itemResult = await requestJson(`${DEFAULT_BASE_URL}/v1/items/${encodeURIComponent(itemId)}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${API_TOKEN}`
      }
    });
    lastStatusCode = itemResult.response.status;
    const item =
      itemResult.body &&
      typeof itemResult.body === "object" &&
      itemResult.body.item &&
      typeof itemResult.body.item === "object"
        ? itemResult.body.item
        : null;

    lastItem = summarizeItem(item);
    const itemStatus = lastItem?.status ?? null;
    if (itemResult.response.ok && itemStatus && FINAL_STATUSES.has(itemStatus)) {
      return {
        base_url: DEFAULT_BASE_URL,
        item_id: itemId,
        ingest: ingestSummary,
        final: {
          timeout: false,
          poll_count: pollCount,
          status_code: lastStatusCode,
          item: lastItem
        }
      };
    }
  }

  return {
    base_url: DEFAULT_BASE_URL,
    item_id: itemId,
    ingest: ingestSummary,
    final: {
      timeout: true,
      poll_count: pollCount,
      status_code: lastStatusCode,
      item: lastItem
    }
  };
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  if (method === "GET" && url.pathname === "/") {
    sendHtml(res, 200, indexHtml);
    return;
  }

  if (method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      base_url: DEFAULT_BASE_URL,
      has_token: Boolean(API_TOKEN),
      poll_timeout_ms: POLL_TIMEOUT_MS,
      poll_interval_ms: POLL_INTERVAL_MS
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/submit") {
    try {
      const body = await parseRequestBody(req);
      const sourceUrl =
        body && typeof body === "object" && typeof body.source_url === "string"
          ? body.source_url.trim()
          : "";
      const notionApiToken =
        body && typeof body === "object" && typeof body.notion_api_token === "string"
          ? body.notion_api_token.trim()
          : "";

      if (!sourceUrl) {
        sendJson(res, 400, { error: "source_url is required." });
        return;
      }
      if (!notionApiToken) {
        sendJson(res, 400, { error: "notion_api_token is required." });
        return;
      }

      const result = await submitToNotion(sourceUrl, notionApiToken);
      const finalStatus = result.final?.item?.status ?? null;
      sendJson(res, 200, {
        ok: finalStatus === "SYNCED",
        ...result
      });
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
  }

  sendJson(res, 404, { error: "Not found." });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[web-tool] running at http://127.0.0.1:${PORT}`);
  console.log(`[web-tool] API base URL: ${DEFAULT_BASE_URL}`);
  console.log(`[web-tool] API token configured: ${API_TOKEN ? "yes" : "no"}`);
  console.log("[web-tool] Notion token mode: request body per submit");
});
