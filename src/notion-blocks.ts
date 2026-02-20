import type { ParsedArticle } from "./article-parser";

const NOTION_RICH_TEXT_MAX_LENGTH = 1900;

type NotionBlock = Record<string, unknown>;

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength - 1).trimEnd() + "…";
}

function splitTextChunks(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < trimmed.length) {
    chunks.push(trimmed.slice(cursor, cursor + NOTION_RICH_TEXT_MAX_LENGTH));
    cursor += NOTION_RICH_TEXT_MAX_LENGTH;
  }
  return chunks;
}

function buildRichText(text: string): Array<Record<string, unknown>> {
  return splitTextChunks(text).map((chunk) => ({
    type: "text",
    text: {
      content: chunk
    }
  }));
}

function createParagraphBlock(text: string): NotionBlock | null {
  const richText = buildRichText(text);
  if (richText.length === 0) {
    return null;
  }
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: richText
    }
  };
}

function createHeadingBlock(level: 1 | 2 | 3, text: string): NotionBlock | null {
  const richText = buildRichText(text);
  if (richText.length === 0) {
    return null;
  }
  const blockType = level === 1 ? "heading_1" : level === 2 ? "heading_2" : "heading_3";
  return {
    object: "block",
    type: blockType,
    [blockType]: {
      rich_text: richText
    }
  };
}

function createListItemBlock(ordered: boolean, text: string): NotionBlock | null {
  const richText = buildRichText(text);
  if (richText.length === 0) {
    return null;
  }
  const blockType = ordered ? "numbered_list_item" : "bulleted_list_item";
  return {
    object: "block",
    type: blockType,
    [blockType]: {
      rich_text: richText
    }
  };
}

function createQuoteBlock(text: string): NotionBlock | null {
  const richText = buildRichText(text);
  if (richText.length === 0) {
    return null;
  }
  return {
    object: "block",
    type: "quote",
    quote: {
      rich_text: richText
    }
  };
}

function createCodeBlock(text: string): NotionBlock | null {
  const richText = buildRichText(text);
  if (richText.length === 0) {
    return null;
  }
  return {
    object: "block",
    type: "code",
    code: {
      language: "plain text",
      rich_text: richText
    }
  };
}

function isSpecialMarkdownLine(line: string): boolean {
  return (
    /^#{1,3}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^[-*]\s+/.test(line) ||
    /^\d+\.\s+/.test(line) ||
    /^!\[[^\]]*]\(([^)]+)\)$/.test(line) ||
    /^```/.test(line)
  );
}

export function markdownToNotionBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const lines = markdown.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      const codeBlock = createCodeBlock(codeLines.join("\n").trim());
      if (codeBlock) {
        blocks.push(codeBlock);
      }
      continue;
    }

    if (/^!\[[^\]]*]\(([^)]+)\)$/.test(line)) {
      // 当前阶段先跳过图片块，避免外链 URL 校验导致整篇同步失败。
      index += 1;
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3;
      const headingBlock = createHeadingBlock(level, headingMatch[2].trim());
      if (headingBlock) {
        blocks.push(headingBlock);
      }
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      const quoteBlock = createQuoteBlock(quoteLines.join("\n").trim());
      if (quoteBlock) {
        blocks.push(quoteBlock);
      }
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        const listBlock = createListItemBlock(false, lines[index].trim().replace(/^[-*]\s+/, ""));
        if (listBlock) {
          blocks.push(listBlock);
        }
        index += 1;
      }
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
        const listBlock = createListItemBlock(true, lines[index].trim().replace(/^\d+\.\s+/, ""));
        if (listBlock) {
          blocks.push(listBlock);
        }
        index += 1;
      }
      continue;
    }

    const paragraphLines: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (!next || isSpecialMarkdownLine(next)) {
        break;
      }
      paragraphLines.push(next);
      index += 1;
    }
    const paragraphBlock = createParagraphBlock(paragraphLines.join("\n").trim());
    if (paragraphBlock) {
      blocks.push(paragraphBlock);
    }
  }

  return blocks;
}

function createSourceUrlBlock(sourceUrl: string): NotionBlock {
  return {
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
            content: truncateText(sourceUrl, NOTION_RICH_TEXT_MAX_LENGTH),
            link: { url: sourceUrl }
          }
        }
      ]
    }
  };
}

export function buildNotionChildrenBlocks(input: {
  normalizedUrl: string;
  article: ParsedArticle;
}): NotionBlock[] {
  const blocks: NotionBlock[] = [createSourceUrlBlock(input.normalizedUrl)];
  const markdownBlocks = markdownToNotionBlocks(input.article.contentMarkdown);
  if (markdownBlocks.length > 0) {
    blocks.push(...markdownBlocks);
    return blocks;
  }

  const summaryBlock = createParagraphBlock(input.article.summary);
  if (summaryBlock) {
    blocks.push(summaryBlock);
  }
  const contentBlock = createParagraphBlock(input.article.contentPlaintext);
  if (contentBlock && input.article.contentPlaintext !== input.article.summary) {
    blocks.push(contentBlock);
  }
  return blocks;
}
