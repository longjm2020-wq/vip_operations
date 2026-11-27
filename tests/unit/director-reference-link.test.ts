import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { downloadDirectorReference, sampleDirectorLink } from "../../apps/api/src/modules/workspace/director-reference-link.js";
import { runMedia } from "../../apps/api/src/modules/workspace/agent-media.js";
import {
  referencePageMedia,
  shareTextUrl,
} from "../../apps/api/src/modules/workspace/director-reference-page.js";

function reply(
  content: string | Buffer,
  headers: Record<string, string> = {},
  statusCode = 200,
) {
  return Object.assign(Readable.from([Buffer.from(content)]), {
    statusCode,
    headers,
  }) as IncomingMessage;
}

describe("公开作品链接导入", () => {
  it("临时抽取真实画面，只返回关键帧与元数据，拒收仅音频的 MP4 容器", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-link-media-"));
    try {
      for (const [name, source, codec] of [
        ["voice", "sine=frequency=440:duration=0.5", "aac"],
        ["movie", "color=c=blue:s=96x72:d=0.5", "libx264"],
      ]) {
        const path = join(dir, name + ".mp4");
        await runMedia(["-y", "-f", "lavfi", "-i", source, "-c", codec, path]);
        const video = await readFile(path);
        const checked = sampleDirectorLink("https://example.com/" + name + ".mp4", async () => reply(video));
        if (name === "voice") await expect(checked).rejects.toMatchObject({ status: 422 });
        else {
          const media = await checked;
          expect(media).not.toHaveProperty("content");
          expect(media).toMatchObject({ name: "movie.mp4", mime: "video/mp4" });
          expect(media.durationMs).toBeGreaterThanOrEqual(500);
          expect(media.durationMs).toBeLessThan(600);
          expect(media.frames[0]).toEqual({ timeMs: 0, url: expect.stringMatching(/^data:image\/jpeg;base64,/) });
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("从分享文本提取网址，保存签名参数", () => {
    expect(
      shareTextUrl("分享作品 https://v.douyin.com/share/?a=1&b=2，复制打开抖音")
        .search,
    ).toBe("?a=1&b=2");
    expect(() => shareTextUrl("没有网址")).toThrow("请粘贴");
    expect(() => shareTextUrl("http://user:pass@example.com")).toThrow("公开");
  });

  it("读取 HTML 视频、Open Graph 和 JSON-LD；只接受可获取的公开媒体地址", () => {
    const jsonLd =
      '<script type="application/ld+json">{"@graph":[{"@type":"VideoObject","contentUrl":"/b.mp4"}]}</script>';
    const html = [
      "<meta content='春装 &amp; 夏装' property='og:title'>",
      "<meta content='https://cdn.example.com/a.mp4?a=1&amp;b=2' property='og:video'>",
      jsonLd,
      '<video><source src="movie.webm"><source src="blob:opaque"></video>',
      '<video src="http://127.0.0.1/video"></video>',
    ].join("");
    expect(
      referencePageMedia(html, new URL("https://example.com/share/post")),
    ).toEqual({
      title: "春装 & 夏装",
      urls: ["https://cdn.example.com/a.mp4?a=1&b=2"],
    });
    const page = new URL("https://example.com/share/post");
    expect(referencePageMedia(jsonLd, page).urls).toEqual([
      "https://example.com/b.mp4",
    ]);
    expect(
      referencePageMedia(
        '<video><source src="movie.webm"><source src="http://127.0.0.1/video"></video>',
        page,
      ).urls,
    ).toEqual(["https://example.com/share/movie.webm"]);
  });

  it("作品编号不匹配、导航页和多个未标注视频时不会误取推荐或广告", () => {
    const unrelated = {
      aweme_detail: {
        aweme_id: "456",
        video: {
          play_addr: { url_list: ["https://cdn.example.com/recommended"] },
        },
      },
    };
    const sources =
      '<video src="/advert"></video><video src="/recommended"></video>';
    const html =
      "<script>window._ROUTER_DATA=" +
      JSON.stringify(unrelated) +
      ";</script>" +
      sources;
    for (const url of [
      "https://www.douyin.com/jingxuan",
      "https://www.douyin.com/video/123",
      "https://www.xiaohongshu.com/explore/123",
      "https://example.com/collection",
    ])
      expect(referencePageMedia(html, new URL(url)).urls).toEqual([]);
    expect(
      referencePageMedia(
        '<meta property="og:url" content="/video/123"><meta property="og:video" content="/same-work.mp4">' +
          sources,
        new URL("https://www.douyin.com/video/123"),
      ).urls,
    ).toEqual(["https://www.douyin.com/same-work.mp4"]);
  });

  it("读取抖音公开作品的播放字段并匹配当前作品编号", () => {
    const video = (id: string) => ({
      aweme_id: id,
      video: { play_addr: { url_list: ["https://cdn.example.com/" + id] } },
    });
    const data = {
      loaderData: {
        "video-page": {
          videoInfoRes: { item_list: [video("999"), video("123")] },
        },
      },
    };
    const page = referencePageMedia(
      "<script>window._ROUTER_DATA = " + JSON.stringify(data) + ";</script>",
      new URL("https://www.iesdouyin.com/share/video/123/"),
    );
    expect(page.urls).toEqual(["https://cdn.example.com/123"]);
    const render = encodeURIComponent(
      JSON.stringify({ part: { aweme: { detail: video("123") } } }),
    );
    expect(
      referencePageMedia(
        '<script id="RENDER_DATA">' + render + "</script>",
        new URL("https://www.douyin.com/video/123"),
      ).urls,
    ).toEqual(page.urls);
  });

  it("读取小红书当前笔记的主、备用播放地址，忽略推荐笔记", () => {
    const note = (name: string) => ({
      note: {
        video: {
          media: {
            stream: {
              h264: [
                {
                  masterUrl: "https://cdn.example.com/" + name,
                  backupUrls: ["https://cdn2.example.com/" + name],
                },
              ],
            },
          },
        },
      },
    });
    const state =
      JSON.stringify({
        note: { noteDetailMap: { a1: note("other"), b2: note("selected") } },
      }).slice(0, -1) + ',"additional":undefined}';
    const page = referencePageMedia(
      "<script>window.__INITIAL_STATE__=" + state + ";</script>",
      new URL("https://www.xiaohongshu.com/explore/b2"),
    );
    expect(page.urls).toEqual([
      "https://cdn.example.com/selected",
      "https://cdn2.example.com/selected",
    ]);
  });

  it("跟随短链和公开媒体重定向，跳过失效媒体并按实际容器命名", async () => {
    const content = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 1]);
    const request = vi.fn(async (url: URL) => {
      switch (url.pathname) {
        case "/short":
          return reply("", { location: "/share" }, 302);
        case "/share":
          return reply(
            '<title>口播</title><video><source src="/expired"><source src="/cdn"></video>',
            { "content-type": "text/html" },
          );
        case "/expired":
          return reply("", {}, 403);
        case "/cdn":
          return reply(
            "",
            { location: "https://media.example.com/material" },
            307,
          );
        default:
          return reply(content, { "content-type": "application/octet-stream" });
      }
    });
    expect(
      await downloadDirectorReference("https://example.com/short", request),
    ).toEqual({ name: "口播.webm", content });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("拒绝无法获取视频的页面、登录页、超限内容和非公开重定向", async () => {
    await expect(
      downloadDirectorReference("https://example.com/login", async () =>
        reply("<html>请登录</html>"),
      ),
    ).rejects.toThrow("本机导入");
    const redirect = vi.fn(async () =>
      reply("", { location: "http://127.0.0.1/" }, 302),
    );
    await expect(
      downloadDirectorReference("https://example.com/redirect", redirect),
    ).rejects.toThrow();
    expect(redirect).toHaveBeenCalledTimes(1);
    await expect(
      downloadDirectorReference("https://example.com/large", async () =>
        reply("", { "content-length": String(201 * 1024 * 1024) }),
      ),
    ).rejects.toThrow("上限");
    await expect(
      downloadDirectorReference(
        "https://example.com/oversized-page",
        async () =>
          reply(Buffer.alloc(2 * 1024 * 1024 + 1), {
            "content-type": "text/html",
          }),
      ),
    ).rejects.toThrow("上限");
  });
});
