import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { downloadPublicReference } from "../../apps/api/src/modules/aigc/public-reference-download.js";
import {
  referencePageMedia,
  shareTextUrl,
} from "../../apps/api/src/modules/aigc/public-reference-page.js";
import { runMedia } from "../../apps/api/src/modules/workspace/agent-media.js";

function reply(
  content: string | Buffer,
  headers: Record<string, string> = {},
  statusCode = 200,
) {
  const body = Buffer.from(content);
  return Object.assign(Readable.from([body.subarray(0, 5), body.subarray(5)]), {
    statusCode,
    headers,
  }) as IncomingMessage;
}

describe("AIGC public reference import", () => {
  it("extracts a work URL from share copy and preserves the signed parameters", () => {
    expect(
      shareTextUrl("抖音分享 https://v.douyin.com/abc/?a=1&b=2，打开查看")
        .search,
    ).toBe("?a=1&b=2");
    expect(() =>
      shareTextUrl("https://username:password@example.com/movie.mp4"),
    ).toThrow("公开");
    expect(() => shareTextUrl("没有链接")).toThrow("粘贴");
  });

  it("accepts published playback URLs only for the requested Douyin or RedNote work", () => {
    const douyin = (id: string) => ({
      aweme_id: id,
      video: { play_addr: { url_list: ["https://media.example.com/" + id] } },
    });
    const note = (id: string) => ({
      note: {
        video: {
          media: {
            stream: {
              h264: [{ masterUrl: "https://media.example.com/" + id }],
            },
          },
        },
      },
    });
    const douyinHtml = `<script>window._ROUTER_DATA = ${JSON.stringify({ item_list: [douyin("111"), douyin("222")] })};</script>`;
    const redNoteHtml = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ note: { noteDetailMap: { first: note("first"), second: note("second") } } })};</script>`;

    expect(
      referencePageMedia(
        douyinHtml,
        new URL("https://www.douyin.com/video/222"),
      ).urls,
    ).toEqual(["https://media.example.com/222"]);
    expect(
      referencePageMedia(
        douyinHtml,
        new URL("https://www.douyin.com/video/333"),
      ).urls,
    ).toEqual([]);
    expect(
      referencePageMedia(
        redNoteHtml,
        new URL("https://www.rednote.com/explore/second"),
      ).urls,
    ).toEqual(["https://media.example.com/second"]);
    expect(
      referencePageMedia(
        redNoteHtml,
        new URL("https://www.rednote.com/login?redirect=/explore/second"),
      ).urls,
    ).toEqual([]);
  });

  it("rejects non-public redirects, social login pages and oversized responses before staging", async () => {
    const signal = new AbortController().signal;
    const unused = join(
      tmpdir(),
      `xuti-unreachable-reference-${crypto.randomUUID()}.part`,
    );
    const redirect = vi.fn(async () =>
      reply("", { location: "http://127.0.0.1/media" }, 302),
    );
    await expect(
      downloadPublicReference(
        "https://example.com/clip",
        unused,
        4096,
        signal,
        redirect,
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(redirect).toHaveBeenCalledTimes(1);
    const login = vi.fn(async (url: URL) =>
      url.hostname === "xhslink.com"
        ? reply(
            "",
            { location: "https://www.rednote.com/login?redirect=/explore/123" },
            302,
          )
        : reply(
            '<meta property="og:video" content="https://media.example.com/ad.mp4">',
            { "content-type": "text/html" },
          ),
    );
    await expect(
      downloadPublicReference(
        "https://xhslink.com/o/abc",
        unused,
        4096,
        signal,
        login,
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(login).toHaveBeenCalledTimes(2);
    const oversized = async () =>
      reply(
        Buffer.concat([
          Buffer.from("\0\0\0\u001cftypisom"),
          Buffer.alloc(4097),
        ]),
      );
    await expect(
      downloadPublicReference(
        "https://example.com/clip",
        unused,
        4096,
        signal,
        oversized,
      ),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it("streams a playable clip from a public work into staging and rejects an audio-only MP4", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xuti-public-reference-fixture-"));
    const video = join(dir, "video.mp4"),
      voice = join(dir, "audio.mp4"),
      temp = join(dir, "stage.part");
    const signal = new AbortController().signal;
    try {
      await runMedia([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=96x72:d=0.5",
        "-c:v",
        "libx264",
        video,
      ]);
      await runMedia([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.5",
        "-c:a",
        "aac",
        voice,
      ]);
      const videoBytes = await readFile(video),
        voiceBytes = await readFile(voice);
      const request = vi.fn(async (url: URL) => {
        if (url.pathname === "/short/")
          return reply(
            "",
            { location: "https://www.iesdouyin.com/share/video/222/" },
            302,
          );
        if (url.pathname === "/share/video/222/")
          return reply(
            [
              '<meta property="og:title" content="外套展示">',
              '<meta property="og:url" content="/share/video/222/">',
              '<meta property="og:video" content="https://media.example.com/expired">',
              '<meta property="og:video:secure_url" content="https://media.example.com/video">',
            ].join(""),
          );
        if (url.pathname === "/expired") return reply("", {}, 403);
        return reply(url.pathname === "/audio" ? voiceBytes : videoBytes, {
          "content-type": "application/octet-stream",
        });
      });
      await expect(
        downloadPublicReference(
          "去抖音看 https://v.douyin.com/short/",
          temp,
          1024 * 1024,
          signal,
          request,
        ),
      ).resolves.toEqual({ name: "外套展示.mp4", mime: "video/mp4" });
      expect(request).toHaveBeenCalledTimes(4);
      expect(await readFile(temp)).toEqual(videoBytes);
      await unlink(temp);
      await expect(
        downloadPublicReference(
          "https://media.example.com/audio",
          temp,
          1024 * 1024,
          signal,
          request,
        ),
      ).rejects.toMatchObject({ statusCode: 422 });
    } finally {
      await Promise.all(
        [temp, video, voice].map((file) => unlink(file).catch(() => undefined)),
      );
    }
  });
});
