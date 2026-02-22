import { describe, expect, it, vi } from "vitest";

import { buildNotionImageAppendBlocksFromHtml, __imagePipelineInternal } from "../src/image-pipeline";

describe("image pipeline", () => {
  it("extracts wechat image urls from html with data-src precedence and host allowlist", () => {
    const html = `
      <div id="js_content">
        <p>text</p>
        <img src="https://evil.example.com/a.jpg" data-src="https://mmbiz.qpic.cn/mmbiz_jpg/abc/0?wx_fmt=jpeg" alt="A" />
        <img src="https://mmbiz.qlogo.cn/mmhead/xyz/0" />
        <img src="https://evil.example.com/b.jpg" />
        <img data-src="https://mmbiz.qpic.cn/mmbiz_jpg/abc/0?wx_fmt=jpeg" />
      </div>
    `;
    const images = __imagePipelineInternal.extractWeChatImagesFromHtml({
      contentHtml: html,
      baseUrl: new URL("https://mp.weixin.qq.com/s/demo"),
      maxCount: 10
    });

    expect(images.map((img) => img.sourceUrl)).toEqual([
      "https://mmbiz.qpic.cn/mmbiz_jpg/abc/0?wx_fmt=jpeg",
      "https://mmbiz.qlogo.cn/mmhead/xyz/0"
    ]);
    expect(images[0]?.alt).toBe("A");
  });

  it("builds notion image blocks via file_uploads and skips on failures", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://mmbiz.qpic.cn/")) {
        expect(init?.headers && typeof init.headers === "object" ? (init.headers as Record<string, string>).referer : null).toBe(
          "https://mp.weixin.qq.com/s/demo"
        );
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": "4"
          }
        });
      }
      if (url === "https://api.notion.com/v1/file_uploads") {
        return new Response(JSON.stringify({ id: "fu_123" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url === "https://api.notion.com/v1/file_uploads/fu_123/send") {
        return new Response(JSON.stringify({ id: "fu_123", status: "uploaded" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("not found", { status: 404 });
    });

    const blocks = await buildNotionImageAppendBlocksFromHtml({
      contentHtml: `<div><img data-src="https://mmbiz.qpic.cn/mmbiz_jpg/abc/0?wx_fmt=jpeg" /></div>`,
      baseUrl: new URL("https://mp.weixin.qq.com/s/demo"),
      articleUrl: "https://mp.weixin.qq.com/s/demo",
      runtime: {
        apiToken: "test-token",
        apiVersion: "2025-09-03",
        apiBaseUrl: "https://api.notion.com/v1"
      }
    });

    expect(blocks.length).toBe(2);
    expect((blocks[0] as { type?: string }).type).toBe("heading_2");
    expect((blocks[1] as { type?: string }).type).toBe("image");
    expect(
      (blocks[1] as { image?: { type?: string; file_upload?: { id?: string } } }).image?.file_upload?.id
    ).toBe("fu_123");

    fetchSpy.mockRestore();
  });
});
