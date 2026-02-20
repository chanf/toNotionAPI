import { describe, expect, it, vi } from "vitest";

import { __articleParserInternal, parseWeChatArticle } from "../src/article-parser";
import { buildNotionChildrenBlocks, markdownToNotionBlocks } from "../src/notion-blocks";

describe("article parser", () => {
  it("extracts js_content and converts html to markdown", () => {
    const html = `
      <html>
        <body>
          <div id="js_content">
            <h2>测试标题</h2>
            <p>第一段<br/>第二行</p>
            <ul><li>列表一</li><li>列表二</li></ul>
            <img src="https://img.example.com/pic.jpg" />
          </div>
        </body>
      </html>
    `;

    const content = __articleParserInternal.extractElementById(html, "js_content");
    expect(content).toBeTruthy();

    const markdown = __articleParserInternal.convertHtmlToMarkdown(
      content as string,
      new URL("https://mp.weixin.qq.com/s/demo")
    );
    expect(markdown).toContain("## 测试标题");
    expect(markdown).toContain("第一段");
    expect(markdown).toContain("- 列表一");
    expect(markdown).toContain("![](https://img.example.com/pic.jpg)");
  });

  it("uses provided raw_text as fallback without remote fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const article = await parseWeChatArticle(
      "https://mp.weixin.qq.com/s/demo-local",
      "这是一段本地文本内容"
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(article.contentMarkdown).toContain("这是一段本地文本内容");
    expect(article.contentPlaintext).toContain("这是一段本地文本内容");
    fetchSpy.mockRestore();
  });
});

describe("notion blocks transform", () => {
  it("maps markdown to multiple notion block types", () => {
    const blocks = markdownToNotionBlocks(
      [
        "## 标题二",
        "",
        "- 项目A",
        "1. 步骤1",
        "> 引用内容",
        "![封面](https://img.example.com/a.jpg)",
        "普通段落"
      ].join("\n")
    );
    const blockTypes = blocks.map((block) => String((block as { type?: string }).type));
    expect(blockTypes).toContain("heading_2");
    expect(blockTypes).toContain("bulleted_list_item");
    expect(blockTypes).toContain("numbered_list_item");
    expect(blockTypes).toContain("quote");
    expect(blockTypes).toContain("image");
    expect(blockTypes).toContain("paragraph");
  });

  it("adds source block before article blocks", () => {
    const blocks = buildNotionChildrenBlocks({
      normalizedUrl: "https://mp.weixin.qq.com/s/demo",
      article: {
        title: "标题",
        summary: "摘要",
        coverUrl: null,
        contentPlaintext: "正文",
        contentMarkdown: "正文",
        contentHtml: null
      }
    });

    expect((blocks[0] as { type?: string }).type).toBe("paragraph");
    expect(blocks.length).toBeGreaterThan(1);
  });
});
