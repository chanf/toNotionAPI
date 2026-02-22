import type { Logger } from "./logger";
import { serializeError } from "./logger";

type NotionBlock = Record<string, unknown>;

export type NotionUploadRuntime = {
  apiToken: string;
  apiVersion: string;
  apiBaseUrl: string;
};

export type ExtractedImage = {
  index: number;
  sourceUrl: string;
  alt: string | null;
};

type DownloadedImage = {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
};

const DEFAULT_MAX_IMAGE_COUNT = 30;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const WECHAT_IMAGE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/604.1";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_all, entity: string) => {
    if (entity[0] === "#") {
      const isHex = entity[1]?.toLowerCase() === "x";
      const numText = isHex ? entity.slice(2) : entity.slice(1);
      const parsed = Number.parseInt(numText, isHex ? 16 : 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _all;
    }

    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: "\"",
      apos: "'",
      nbsp: " "
    };
    return named[entity.toLowerCase()] ?? _all;
  });
}

function extractAttribute(tag: string, name: string): string | null {
  const quoted = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, "i").exec(tag);
  if (quoted) {
    const raw = decodeHtmlEntities(quoted[2]).trim();
    return raw || null;
  }

  const unquoted = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*([^\\s>]+)`, "i").exec(tag);
  if (unquoted) {
    const raw = decodeHtmlEntities(unquoted[1]).trim();
    return raw || null;
  }

  return null;
}

function toAbsoluteHttpUrl(raw: string, baseUrl: URL): string | null {
  try {
    const normalized = new URL(raw, baseUrl);
    if (normalized.protocol !== "http:" && normalized.protocol !== "https:") {
      return null;
    }
    return normalized.toString();
  } catch {
    return null;
  }
}

function isAllowedWeChatImageHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized.endsWith(".qpic.cn") || normalized.endsWith(".qlogo.cn");
}

function isSafeImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return false;
    }
    return isAllowedWeChatImageHost(url.hostname);
  } catch {
    return false;
  }
}

export function extractWeChatImagesFromHtml(input: {
  contentHtml: string;
  baseUrl: URL;
  maxCount?: number;
}): ExtractedImage[] {
  const maxCount = input.maxCount ?? DEFAULT_MAX_IMAGE_COUNT;
  const images: ExtractedImage[] = [];
  const seen = new Set<string>();
  const tagPattern = /<img\b[^>]*>/gi;
  let match = tagPattern.exec(input.contentHtml);
  while (match) {
    const tag = match[0];
    const urlRaw =
      extractAttribute(tag, "data-src") ??
      extractAttribute(tag, "data-original") ??
      extractAttribute(tag, "data-actualsrc") ??
      extractAttribute(tag, "src");
    const alt = extractAttribute(tag, "alt");
    const absolute = urlRaw ? toAbsoluteHttpUrl(urlRaw, input.baseUrl) : null;
    if (absolute && isSafeImageUrl(absolute) && !seen.has(absolute)) {
      seen.add(absolute);
      images.push({
        index: images.length,
        sourceUrl: absolute,
        alt: alt ?? null
      });
      if (images.length >= maxCount) {
        break;
      }
    }
    match = tagPattern.exec(input.contentHtml);
  }
  return images;
}

function normalizeContentType(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const normalized = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function extensionFromContentType(contentType: string): string | null {
  if (contentType === "image/jpeg") {
    return ".jpg";
  }
  if (contentType === "image/png") {
    return ".png";
  }
  if (contentType === "image/gif") {
    return ".gif";
  }
  if (contentType === "image/webp") {
    return ".webp";
  }
  if (contentType === "image/svg+xml") {
    return ".svg";
  }
  if (contentType === "image/avif") {
    return ".avif";
  }
  return null;
}

function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const wxFmt = parsed.searchParams.get("wx_fmt");
    if (wxFmt) {
      const ext = wxFmt.trim().toLowerCase();
      if (/^(jpg|jpeg|png|gif|webp|bmp|svg|avif)$/.test(ext)) {
        return `wechat-image.${ext === "jpeg" ? "jpg" : ext}`;
      }
    }
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    if (last && last.length <= 80 && last.includes(".")) {
      return last;
    }
  } catch {
    // ignore
  }
  return "wechat-image";
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new Error(`IMAGE_TOO_LARGE content-length=${parsed}`);
    }
  }

  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(`IMAGE_TOO_LARGE bytes=${buffer.byteLength}`);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`IMAGE_TOO_LARGE bytes>${maxBytes}`);
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function downloadWeChatImage(input: {
  imageUrl: string;
  articleUrl: string;
  maxBytes: number;
  logger?: Logger;
  trace?: Record<string, unknown>;
}): Promise<DownloadedImage> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(input.imageUrl, {
      method: "GET",
      redirect: "follow",
      signal: abortController.signal,
      headers: {
        accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        referer: input.articleUrl,
        "user-agent": WECHAT_IMAGE_USER_AGENT
      }
    });
    if (!response.ok) {
      throw new Error(`IMAGE_FETCH_FAILED status=${response.status}`);
    }

    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (!contentType || !contentType.startsWith("image/")) {
      throw new Error(`IMAGE_UNSUPPORTED_CONTENT_TYPE content-type=${contentType ?? "null"}`);
    }

    const bytes = await readBodyWithLimit(response, input.maxBytes);
    const ext = extensionFromContentType(contentType);
    const baseName = filenameFromUrl(input.imageUrl).replace(/[^a-zA-Z0-9_.-]+/g, "_");
    const filename = ext && !baseName.toLowerCase().endsWith(ext) ? `${baseName}${ext}` : baseName;

    input.logger?.info("image.download.succeeded", {
      ...(input.trace ?? {}),
      image_url: input.imageUrl,
      content_type: contentType,
      bytes: bytes.byteLength
    });

    return {
      bytes,
      contentType,
      filename
    };
  } finally {
    clearTimeout(timeout);
  }
}

class NotionFileUploadError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
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

function notionAuthHeaders(runtime: NotionUploadRuntime): Record<string, string> {
  return {
    authorization: `Bearer ${runtime.apiToken}`,
    "notion-version": runtime.apiVersion
  };
}

async function createNotionFileUpload(runtime: NotionUploadRuntime, metadata: {
  filename: string;
  contentType: string;
}): Promise<{ id: string }> {
  const response = await fetch(`${runtime.apiBaseUrl}/file_uploads`, {
    method: "POST",
    headers: {
      ...notionAuthHeaders(runtime),
      "content-type": "application/json"
    },
    body: JSON.stringify({
      mode: "single_part",
      filename: metadata.filename,
      content_type: metadata.contentType
    })
  });
  if (!response.ok) {
    const detail = await parseNotionApiErrorMessage(response);
    throw new NotionFileUploadError(
      response.status,
      `NOTION_CREATE_FILE_UPLOAD_FAILED status=${response.status}${detail ? ` ${detail}` : ""}`
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const id = typeof payload.id === "string" ? payload.id : null;
  if (!id) {
    throw new Error("NOTION_CREATE_FILE_UPLOAD_BAD_RESPONSE missing id");
  }
  return { id };
}

async function sendNotionFileUpload(runtime: NotionUploadRuntime, input: {
  fileUploadId: string;
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}): Promise<void> {
  const form = new FormData();
  // Ensure underlying buffer is an ArrayBuffer (BlobPart typing is stricter than ArrayBufferLike).
  const safeBytes = new Uint8Array(input.bytes.byteLength);
  safeBytes.set(input.bytes);
  const blob = new Blob([safeBytes], { type: input.contentType });
  form.append("file", blob, input.filename);

  const response = await fetch(`${runtime.apiBaseUrl}/file_uploads/${input.fileUploadId}/send`, {
    method: "POST",
    headers: {
      ...notionAuthHeaders(runtime)
    },
    body: form
  });
  if (!response.ok) {
    const detail = await parseNotionApiErrorMessage(response);
    throw new NotionFileUploadError(
      response.status,
      `NOTION_SEND_FILE_UPLOAD_FAILED status=${response.status}${detail ? ` ${detail}` : ""}`
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const status = typeof payload.status === "string" ? payload.status : null;
  if (status && status !== "uploaded") {
    throw new Error(`NOTION_SEND_FILE_UPLOAD_UNEXPECTED_STATUS status=${status}`);
  }
}

async function uploadImageToNotion(runtime: NotionUploadRuntime, image: DownloadedImage): Promise<string> {
  const created = await createNotionFileUpload(runtime, {
    filename: image.filename,
    contentType: image.contentType
  });
  await sendNotionFileUpload(runtime, {
    fileUploadId: created.id,
    bytes: image.bytes,
    contentType: image.contentType,
    filename: image.filename
  });
  return created.id;
}

function createHeading2Block(text: string): NotionBlock {
  return {
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: [
        {
          type: "text",
          text: {
            content: text
          }
        }
      ]
    }
  };
}

function createImageBlockFromFileUpload(fileUploadId: string): NotionBlock {
  return {
    object: "block",
    type: "image",
    image: {
      type: "file_upload",
      file_upload: {
        id: fileUploadId
      }
    }
  };
}

export async function buildNotionImageAppendBlocksFromHtml(input: {
  contentHtml: string | null;
  baseUrl: URL;
  articleUrl: string;
  runtime: NotionUploadRuntime;
  logger?: Logger;
  maxCount?: number;
  maxBytes?: number;
}): Promise<NotionBlock[]> {
  if (!input.contentHtml) {
    return [];
  }

  const maxCount = input.maxCount ?? DEFAULT_MAX_IMAGE_COUNT;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const images = extractWeChatImagesFromHtml({
    contentHtml: input.contentHtml,
    baseUrl: input.baseUrl,
    maxCount
  });

  input.logger?.info("image.extract.succeeded", {
    count: images.length
  });

  if (images.length === 0) {
    return [];
  }

  const blocks: NotionBlock[] = [];
  let succeeded = 0;

  for (const image of images) {
    const trace = {
      image_index: image.index
    };
    try {
      input.logger?.info("image.download.started", {
        ...trace,
        image_url: image.sourceUrl
      });
      const downloaded = await downloadWeChatImage({
        imageUrl: image.sourceUrl,
        articleUrl: input.articleUrl,
        maxBytes,
        logger: input.logger,
        trace
      });

      input.logger?.info("image.upload.notion_create.started", {
        ...trace,
        image_url: image.sourceUrl
      });
      const fileUploadId = await uploadImageToNotion(input.runtime, downloaded);
      input.logger?.info("image.upload.notion_send.succeeded", {
        ...trace,
        image_url: image.sourceUrl,
        file_upload_id: fileUploadId
      });

      blocks.push(createImageBlockFromFileUpload(fileUploadId));
      succeeded += 1;
    } catch (error) {
      const serialized = serializeError(error);
      const status =
        error instanceof NotionFileUploadError ? error.status : typeof serialized.status === "number" ? serialized.status : null;

      input.logger?.warn("image.process.failed", {
        ...trace,
        image_url: image.sourceUrl,
        status,
        error: serialized
      });

      if (status === 429) {
        input.logger?.warn("image.process.rate_limited_stop", {
          ...trace
        });
        break;
      }
    }
  }

  if (succeeded === 0) {
    return [];
  }

  return [createHeading2Block("图片"), ...blocks];
}

export const __imagePipelineInternal = {
  extractWeChatImagesFromHtml,
  isSafeImageUrl
};
