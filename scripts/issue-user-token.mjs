import process from "node:process";

const DEFAULT_BASE_URL = "https://your-worker.example.com";

function usage() {
  console.error(`Usage:
  ADMIN_TOKEN=<token> API_BASE_URL=<base-url> node scripts/issue-user-token.mjs <user_id>

Optional flags:
  --base-url <url>     API base URL (default: ${DEFAULT_BASE_URL})
  --token <token>      Admin bearer token (fallback: ADMIN_TOKEN env)
  --label <label>      Token label (optional)
  --scopes <scopes>    Comma-separated scopes (optional, default handled by server)
  --expires-at <iso>   Expiration time in ISO format (optional)
  -h, --help           Show this message
`);
}

function trimTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

function normalizeBaseUrl(input) {
  const trimmed = trimTrailingSlash(input);
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

function parseArgs(argv) {
  const parsed = {
    userId: null,
    baseUrl: null,
    token: null,
    label: null,
    scopes: null,
    expiresAt: null,
    help: false
  };

  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
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
    if (arg === "--label") {
      parsed.label = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--scopes") {
      parsed.scopes = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--expires-at") {
      parsed.expiresAt = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    rest.push(arg);
  }

  if (rest.length > 0) {
    parsed.userId = rest[0];
  }

  return parsed;
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

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    usage();
    process.exit(0);
  }

  const userId = (parsed.userId ?? "").trim();
  if (!userId) {
    usage();
    process.exit(1);
  }

  const baseUrl = normalizeBaseUrl((parsed.baseUrl ?? process.env.API_BASE_URL ?? DEFAULT_BASE_URL).trim());
  const adminToken = (parsed.token ?? process.env.ADMIN_TOKEN ?? "").trim();
  if (!adminToken) {
    console.error("Missing admin token. Set ADMIN_TOKEN or pass --token.");
    process.exit(1);
  }

  const payload = {};
  if (parsed.label && parsed.label.trim()) {
    payload.label = parsed.label.trim();
  }
  if (parsed.scopes && parsed.scopes.trim()) {
    payload.scopes = parsed.scopes.trim();
  }
  if (parsed.expiresAt && parsed.expiresAt.trim()) {
    payload.expires_at = parsed.expiresAt.trim();
  }

  const url = `${baseUrl}/v1/admin/users/${encodeURIComponent(userId)}/tokens`;
  const result = await requestJson(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!result.response.ok) {
    const message = result.body ? JSON.stringify(result.body) : String(result.response.status);
    console.error(`Request failed (${result.response.status}): ${message}`);
    process.exit(1);
  }

  const token = result.body && typeof result.body === "object" ? result.body.token : null;
  if (typeof token !== "string" || !token.trim()) {
    console.error("Token not found in response.");
    process.exit(1);
  }

  console.log(token);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
