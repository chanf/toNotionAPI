const SUMMARY_MAX_LENGTH = 120;
const FETCH_TIMEOUT_MS = 15_000;
const WECHAT_CONTENT_ID = "js_content";

export class ParserError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retriable: boolean
  ) {
    super(message);
  }
}

export type ParsedArticle = {
  title: string;
  summary: string;
  coverUrl: string | null;
  contentPlaintext: string;
  contentMarkdown: string;
  contentHtml: string | null;
};

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength - 1).trimEnd() + "…";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function decodeJsEscapedText(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|n|r|t|'|"|\\)/g, (_all, token: string) => {
    if (token === "n") {
      return "\n";
    }
    if (token === "r") {
      return "\r";
    }
    if (token === "t") {
      return "\t";
    }
    if (token === "'" || token === "\"" || token === "\\") {
      return token;
    }
    if (token.startsWith("u")) {
      return String.fromCharCode(Number.parseInt(token.slice(1), 16));
    }
    if (token.startsWith("x")) {
      return String.fromCharCode(Number.parseInt(token.slice(1), 16));
    }
    return token;
  });
}

function stripHtmlTags(value: string): string {
  const withoutScripts = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withBreaks = withoutScripts
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6|blockquote)>/gi, "\n");
  return normalizeText(decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " ")));
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

function extractMetaContent(html: string, attr: string, value: string): string | null {
  const attrPattern = `${escapeRegExp(attr)}=["']${escapeRegExp(value)}["']`;
  const first = new RegExp(
    `<meta[^>]*${attrPattern}[^>]*content=["']([^"']+)["'][^>]*>`,
    "i"
  ).exec(html);
  if (first) {
    return decodeHtmlEntities(first[1]).trim() || null;
  }
  const second = new RegExp(
    `<meta[^>]*content=["']([^"']+)["'][^>]*${attrPattern}[^>]*>`,
    "i"
  ).exec(html);
  if (second) {
    return decodeHtmlEntities(second[1]).trim() || null;
  }
  return null;
}

function extractTitleTag(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) {
    return null;
  }
  return stripHtmlTags(match[1]) || null;
}

function extractJsVarString(html: string, varName: string): string | null {
  const htmlDecodePattern = new RegExp(
    `\\bvar\\s+${escapeRegExp(varName)}\\s*=\\s*htmlDecode\\(\\s*(['"])([\\s\\S]*?)\\1\\s*\\)`,
    "i"
  );
  const htmlDecodeMatch = htmlDecodePattern.exec(html);
  if (htmlDecodeMatch) {
    const value = decodeHtmlEntities(decodeJsEscapedText(htmlDecodeMatch[2]));
    return value.trim() || null;
  }

  const pattern = new RegExp(
    `\\bvar\\s+${escapeRegExp(varName)}\\s*=\\s*(['"])([\\s\\S]*?)\\1\\s*;`,
    "i"
  );
  const match = pattern.exec(html);
  if (!match) {
    return null;
  }
  const value = decodeHtmlEntities(decodeJsEscapedText(match[2]));
  return value.trim() || null;
}

function parseTitleFromUrl(url: URL): string | null {
  return url.searchParams.get("title");
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function shouldUseRawText(rawText: string | null, sourceUrl: string): rawText is string {
  if (!rawText) {
    return false;
  }
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed === sourceUrl.trim()) {
    return false;
  }
  return !isHttpUrl(trimmed);
}

async function fetchWeChatHtml(sourceUrl: string): Promise<string> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(sourceUrl, {
      method: "GET",
      redirect: "follow",
      signal: abortController.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        referer: "https://mp.weixin.qq.com/",
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/604.1"
      }
    });
    if (!response.ok) {
      const retriable = response.status >= 500 || response.status === 429;
      throw new ParserError(
        "PARSE_FETCH_FAILED",
        `Failed to fetch article content from source URL (status ${response.status}).`,
        retriable
      );
    }
    const html = await response.text();
    if (!html || html.trim().length < 100) {
      throw new ParserError("PARSE_CONTENT_EMPTY", "Fetched article content is empty.", true);
    }
    return html;
  } catch (error) {
    if (error instanceof ParserError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new ParserError("PARSE_TIMEOUT", "Fetching article content timed out.", true);
    }
    throw new ParserError("PARSE_FETCH_FAILED", "Failed to fetch article content from source URL.", true);
  } finally {
    clearTimeout(timeout);
  }
}

export function extractElementById(html: string, elementId: string): string | null {
  const startTagPattern = new RegExp(
    `<([a-zA-Z][\\w:-]*)[^>]*\\bid=["']${escapeRegExp(elementId)}["'][^>]*>`,
    "i"
  );
  const startMatch = startTagPattern.exec(html);
  if (!startMatch) {
    return null;
  }

  const tagName = startMatch[1].toLowerCase();
  const contentStart = startMatch.index + startMatch[0].length;
  const tagPattern = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = contentStart;

  let depth = 1;
  let match: RegExpExecArray | null = tagPattern.exec(html);
  while (match) {
    const token = match[0];
    const isClosing = token.startsWith("</");
    const isSelfClosing = /\/>$/.test(token);
    if (isClosing) {
      depth -= 1;
    } else if (!isSelfClosing) {
      depth += 1;
    }
    if (depth === 0) {
      return html.slice(contentStart, match.index);
    }
    match = tagPattern.exec(html);
  }
  return null;
}

function extractImageUrlFromTag(tag: string, baseUrl: URL): string | null {
  const srcMatch = /\b(?:data-src|src)\s*=\s*["']([^"']+)["']/i.exec(tag);
  if (!srcMatch) {
    return null;
  }
  return toAbsoluteHttpUrl(decodeHtmlEntities(srcMatch[1]), baseUrl);
}

function convertListToMarkdown(listHtml: string, ordered: boolean): string {
  const items: string[] = [];
  const itemPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let itemMatch: RegExpExecArray | null = itemPattern.exec(listHtml);
  while (itemMatch) {
    const text = stripHtmlTags(itemMatch[1]);
    if (text) {
      items.push(text);
    }
    itemMatch = itemPattern.exec(listHtml);
  }
  if (items.length === 0) {
    return "\n\n";
  }
  return (
    "\n\n" +
    items
      .map((item, index) => (ordered ? `${index + 1}. ${item}` : `- ${item}`))
      .join("\n") +
    "\n\n"
  );
}

export function convertHtmlToMarkdown(contentHtml: string, baseUrl: URL): string {
  let markdown = contentHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  markdown = markdown.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_all, inner: string) => {
    const text = stripHtmlTags(inner);
    return text ? `\n\n# ${text}\n\n` : "\n\n";
  });
  markdown = markdown.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_all, inner: string) => {
    const text = stripHtmlTags(inner);
    return text ? `\n\n## ${text}\n\n` : "\n\n";
  });
  markdown = markdown.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_all, inner: string) => {
    const text = stripHtmlTags(inner);
    return text ? `\n\n### ${text}\n\n` : "\n\n";
  });
  markdown = markdown.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_all, inner: string) => {
    const text = stripHtmlTags(inner);
    if (!text) {
      return "\n\n";
    }
    return `\n\n${text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
  });
  markdown = markdown.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_all, inner: string) => {
    const text = stripHtmlTags(inner);
    return text ? `\n\n\`\`\`\n${text}\n\`\`\`\n\n` : "\n\n";
  });
  markdown = markdown.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_all, inner: string) =>
    convertListToMarkdown(inner, false)
  );
  markdown = markdown.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_all, inner: string) =>
    convertListToMarkdown(inner, true)
  );
  markdown = markdown.replace(/<img\b[^>]*>/gi, (tag: string) => {
    const imageUrl = extractImageUrlFromTag(tag, baseUrl);
    return imageUrl ? `\n\n![](${imageUrl})\n\n` : "\n\n";
  });
  markdown = markdown.replace(
    /<(p|div|section|article)[^>]*>([\s\S]*?)<\/\1>/gi,
    (_all, _tag: string, inner: string) => {
      const text = stripHtmlTags(inner);
      return text ? `\n\n${text}\n\n` : "\n\n";
    }
  );
  markdown = markdown.replace(/<br\s*\/?>/gi, "\n");
  markdown = decodeHtmlEntities(markdown.replace(/<[^>]+>/g, " "));

  return normalizeText(markdown);
}

export function markdownToPlainText(markdown: string): string {
  const lines = markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""))
    .split("\n")
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/^[-*]\s+/, "")
        .replace(/^\d+\.\s+/, "")
        .replace(/!\[[^\]]*]\(([^)]+)\)/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
    );
  return normalizeText(lines.join("\n"));
}

export async function parseWeChatArticle(sourceUrl: string, rawText: string | null): Promise<ParsedArticle> {
  if (sourceUrl.includes("fail-parse")) {
    throw new ParserError("PARSE_FETCH_FAILED", "Failed to fetch article content from source URL.", true);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    throw new ParserError("PARSE_INVALID_URL", "Source URL is invalid.", false);
  }

  if (shouldUseRawText(rawText, sourceUrl)) {
    const content = normalizeText(rawText);
    const title = parseTitleFromUrl(parsedUrl) ?? `WeChat Article - ${parsedUrl.hostname}`;
    const summary = truncateText(content || sourceUrl, SUMMARY_MAX_LENGTH);
    return {
      title,
      summary,
      coverUrl: null,
      contentPlaintext: content,
      contentMarkdown: content,
      contentHtml: null
    };
  }

  const html = await fetchWeChatHtml(sourceUrl);
  const title =
    extractMetaContent(html, "property", "og:title") ??
    extractJsVarString(html, "msg_title") ??
    extractTitleTag(html) ??
    parseTitleFromUrl(parsedUrl) ??
    `WeChat Article - ${parsedUrl.hostname}`;
  const coverUrlRaw =
    extractJsVarString(html, "msg_cdn_url") ??
    extractMetaContent(html, "property", "og:image") ??
    null;
  const coverUrl = coverUrlRaw ? toAbsoluteHttpUrl(coverUrlRaw, parsedUrl) : null;

  const contentHtml = extractElementById(html, WECHAT_CONTENT_ID);
  let contentMarkdown = contentHtml ? convertHtmlToMarkdown(contentHtml, parsedUrl) : "";
  if (!contentMarkdown && shouldUseRawText(rawText, sourceUrl)) {
    contentMarkdown = normalizeText(rawText);
  }
  if (!contentMarkdown) {
    throw new ParserError("PARSE_CONTENT_EMPTY", "Failed to extract article body from source URL.", true);
  }

  const contentPlaintext = markdownToPlainText(contentMarkdown);
  const summary = truncateText(contentPlaintext || title, SUMMARY_MAX_LENGTH);

  return {
    title,
    summary,
    coverUrl,
    contentPlaintext,
    contentMarkdown,
    contentHtml
  };
}

export const __articleParserInternal = {
  convertHtmlToMarkdown,
  extractElementById,
  markdownToPlainText
};
