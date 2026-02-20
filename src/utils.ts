const TRACKING_QUERY_KEYS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "from",
  "scene",
  "isappinstalled"
]);

export function nowIso(): string {
  return new Date().toISOString();
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  traceId: string | null = null
): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
        trace_id: traceId
      }
    },
    status
  );
}

export function normalizeUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl.trim());
  const keep = new URLSearchParams();
  for (const [key, value] of parsed.searchParams.entries()) {
    if (!TRACKING_QUERY_KEYS.has(key)) {
      keep.append(key, value);
    }
  }
  parsed.search = keep.toString();
  parsed.hash = "";
  return parsed.toString();
}

export function parseBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authorizationHeader.slice("Bearer ".length).trim();
  return token || null;
}

export function randomId(): string {
  return crypto.randomUUID();
}

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
