const DEFAULT_BASE_URL = "https://tonotion.iiioiii.xin";
const DEFAULT_SOURCE_URL = "https://mp.weixin.qq.com/s/_P_1E-Stfo-8-eCRUh8Ygg";
const DEFAULT_POLL_TIMEOUT_SEC = 30;
const DEFAULT_POLL_INTERVAL_MS = 2000;

function usage() {
  console.log(`Usage:
  API_BASE_URL=<base-url> API_TOKEN=<token> npm run ingest:online

Optional flags:
  --base-url <url>         API base URL (default: ${DEFAULT_BASE_URL})
  --token <token>          Bearer token (fallback: API_TOKEN env)
  --source-url <url>       WeChat article URL (default: ${DEFAULT_SOURCE_URL})
  --client-item-id <id>    Custom client item id
  --timeout-sec <n>        Poll timeout in seconds (default: ${DEFAULT_POLL_TIMEOUT_SEC})
  --interval-ms <n>        Poll interval in ms (default: ${DEFAULT_POLL_INTERVAL_MS})
  --no-poll                Submit only, no polling
  -h, --help               Show this message
`);
}

function parseArgs(argv) {
  const parsed = {
    baseUrl: null,
    token: null,
    sourceUrl: null,
    clientItemId: null,
    timeoutSec: DEFAULT_POLL_TIMEOUT_SEC,
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
    noPoll: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }
    if (arg === "--no-poll") {
      parsed.noPoll = true;
      continue;
    }
    if (arg === "--base-url") {
      parsed.baseUrl = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--token") {
      parsed.token = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--source-url") {
      parsed.sourceUrl = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--client-item-id") {
      parsed.clientItemId = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--timeout-sec") {
      parsed.timeoutSec = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
      continue;
    }
    if (arg === "--interval-ms") {
      parsed.intervalMs = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function trimTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

function isFinalStatus(status) {
  return status === "SYNCED" || status === "SYNC_FAILED" || status === "PARSE_FAILED";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const token = (args.token ?? process.env.API_TOKEN ?? "").trim();
  if (!token) {
    console.error("Missing token. Use --token <token> or set API_TOKEN.");
    usage();
    process.exit(1);
  }

  const baseUrl = trimTrailingSlash(
    (args.baseUrl ?? process.env.API_BASE_URL ?? DEFAULT_BASE_URL).trim()
  );
  const sourceUrl = (args.sourceUrl ?? DEFAULT_SOURCE_URL).trim();
  const clientItemId = (args.clientItemId ?? `online-test-${Date.now()}`).trim();

  if (!Number.isFinite(args.timeoutSec) || args.timeoutSec <= 0) {
    throw new Error("--timeout-sec must be a positive integer.");
  }
  if (!Number.isFinite(args.intervalMs) || args.intervalMs <= 0) {
    throw new Error("--interval-ms must be a positive integer.");
  }

  const ingestUrl = `${baseUrl}/v1/ingest`;
  const ingestPayload = {
    client_item_id: clientItemId,
    source_url: sourceUrl,
    raw_text: sourceUrl
  };

  console.log(`[submit] POST ${ingestUrl}`);
  console.log(`[submit] payload: ${JSON.stringify(ingestPayload)}`);
  const ingest = await requestJson(ingestUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(ingestPayload)
  });

  console.log(`[submit] status: ${ingest.response.status}`);
  console.log(`[submit] response: ${JSON.stringify(ingest.body, null, 2)}`);

  if (!ingest.response.ok) {
    process.exit(1);
  }

  if (args.noPoll) {
    return;
  }

  const itemId =
    ingest.body && typeof ingest.body === "object" && typeof ingest.body.item_id === "string"
      ? ingest.body.item_id
      : null;
  if (!itemId) {
    console.log("[poll] skip: item_id not found in response.");
    return;
  }

  const deadline = Date.now() + args.timeoutSec * 1000;
  const getItemUrl = `${baseUrl}/v1/items/${encodeURIComponent(itemId)}`;
  while (Date.now() < deadline) {
    await sleep(args.intervalMs);
    const itemResp = await requestJson(getItemUrl, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    const item =
      itemResp.body &&
      typeof itemResp.body === "object" &&
      itemResp.body.item &&
      typeof itemResp.body.item === "object"
        ? itemResp.body.item
        : null;
    const status = item && typeof item.status === "string" ? item.status : null;
    console.log(`[poll] status_code=${itemResp.response.status} item_status=${status ?? "unknown"}`);

    if (itemResp.response.ok && status && isFinalStatus(status)) {
      console.log(`[poll] final: ${JSON.stringify(item, null, 2)}`);
      return;
    }
  }

  console.log("[poll] timeout reached.");
  process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
