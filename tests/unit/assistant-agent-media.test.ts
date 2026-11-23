import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import sharp from "sharp";
import * as XLSX from "xlsx";
import { createAgentDocument } from "../../apps/api/src/modules/workspace/agent-documents.js";
import {
  compressAgentUpload,
  inspectAgentUpload,
  validateOfficeZip,
} from "../../apps/api/src/modules/workspace/agent-files.js";
import {
  editVideo,
  inspectVideo,
  runMedia,
  videoFrames,
} from "../../apps/api/src/modules/workspace/agent-media.js";
import { videoJobSchema } from "../../packages/contracts/src/assistant-agent.js";
import { publicCitations } from "../../apps/api/src/modules/workspace/agent-search.js";

describe("assistant real artifacts", () => {
  const sections = [
    {
      heading: "库存说明",
      text: "中文内容与长条码保持原样",
      rows: [
        ["条码", "库存"],
        ["001234567890123456789", 12],
        ['=HYPERLINK("https://example.com")', 0],
      ],
    },
  ];
  it("creates real Office files that can be read back, without evaluating spreadsheet strings", async () => {
    for (const format of ["docx", "xlsx", "pptx"] as const) {
      const result = await createAgentDocument({
        title: "库存报告",
        format,
        sections,
      });
      expect(result.content.subarray(0, 2).toString()).toBe("PK");
      const parsed = await inspectAgentUpload("报告." + format, result.content);
      expect(parsed.text).toContain("001234567890123456789");
      expect(parsed.text).toContain("库存");
      if (format === "xlsx") {
        const book = XLSX.read(result.content, {
          type: "buffer",
          cellFormula: true,
        });
        expect(book.Sheets[book.SheetNames[0]].A4.f).toBeUndefined();
        expect(book.Sheets[book.SheetNames[0]].A4.v).toContain("=HYPERLINK");
      }
    }
    const csv = await createAgentDocument({
      title: "安全导出",
      format: "csv",
      sections,
    });
    expect(csv.content.toString()).toContain("'=HYPERLINK");
  });
  it("rejects spoofed files and excessive expanded Office archives", async () => {
    await expect(
      inspectAgentUpload("fake.pdf", Buffer.from("not a PDF")),
    ).rejects.toThrow();
    await expect(
      inspectAgentUpload("danger.exe", Buffer.from("MZ")),
    ).rejects.toThrow();
    const zip = new JSZip();
    zip.file("word/document.xml", "normal");
    const data = await zip.generateAsync({ type: "nodebuffer" });
    const offset = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    data.writeUInt32LE(100000000, offset + 24);
    expect(() => validateOfficeZip(data)).toThrow();
  });
  it("actually trims, concatenates, resizes and mutes video with bounded typed arguments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assistant-media-test-"));
    try {
      const path = join(dir, "source.mp4");
      await runMedia([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x240:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "1",
        path,
      ]);
      const content = await readFile(path),
        info = await inspectVideo(content);
      expect(info.duration).toBeCloseTo(2, 0);
      expect(info.audio).toBe(true);
      const id = "11111111-1111-4111-8111-111111111111";
      const progress: number[] = [];
      const result = await editVideo(
        videoJobSchema.parse({
          title: "结果",
          clips: [
            { fileId: id, start: 0, end: 1, speed: 1 },
            { fileId: id, start: 1, end: 2, speed: 2 },
          ],
          aspectRatio: "9:16",
          mute: true,
        }),
        new Map([[id, { content, ...info }]]),
        async (n) => {
          progress.push(n);
        },
        AbortSignal.timeout(30000),
      );
      const output = await inspectVideo(result);
      expect(output.duration).toBeCloseTo(1.5, 0);
      expect(output.audio).toBe(false);
      expect(
        (await videoFrames(result, output.duration)).length,
      ).toBeGreaterThan(0);
      expect(progress).toContain(85);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 45000);
  it("compresses oversized PNG, Office, and video uploads lossless-first to fit target limits", async () => {
    // 1. 无压缩 PNG 通过无损重编码（PNG level 9 或无损 WebP）缩减至目标大小且像素完全一致
    const width = 320,
      height = 320;
    const rawPixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        rawPixels[i] = (x * 3) % 256;
        rawPixels[i + 1] = (y * 5) % 256;
        rawPixels[i + 2] = ((x + y) * 2) % 256;
        rawPixels[i + 3] = 255;
      }
    }
    const bloatedPng = await sharp(rawPixels, {
      raw: { width, height, channels: 4 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(bloatedPng.length).toBeGreaterThan(100_000);
    const pngLimit = Math.floor(bloatedPng.length * 0.45);
    const compressedImg = await compressAgentUpload(
      "lookbook.png",
      bloatedPng,
      pngLimit,
    );
    expect(compressedImg.compressed).toBe(true);
    expect(compressedImg.mode).toBe("lossless");
    expect(compressedImg.content.length).toBeLessThanOrEqual(pngLimit);
    const decodedPixels = await sharp(compressedImg.content)
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect(decodedPixels.equals(rawPixels)).toBe(true);

    // 2. 未压缩 STORE 的 Office docx 通过 DEFLATE 9 级严格无损压缩，正文完整可读
    const zip = new JSZip();
    const xmlPayload = `<w:document><w:body><w:p>${"服装质检标准细节说明。".repeat(4000)}</w:p></w:body></w:document>`;
    zip.file("word/document.xml", xmlPayload);
    const storedDocx = await zip.generateAsync({
      type: "nodebuffer",
      compression: "STORE",
    });
    const docxLimit = Math.floor(storedDocx.length * 0.25);
    const compressedDocx = await compressAgentUpload(
      "质检规范.docx",
      storedDocx,
      docxLimit,
    );
    expect(compressedDocx.compressed).toBe(true);
    expect(compressedDocx.mode).toBe("lossless");
    expect(compressedDocx.content.length).toBeLessThanOrEqual(docxLimit);
    const parsedDocx = await inspectAgentUpload(
      compressedDocx.name,
      compressedDocx.content,
    );
    expect(parsedDocx.text).toContain("服装质检标准细节说明");

    // 3. 超限视频压缩至目标大小且保持可播放与完整时长
    const dir = await mkdtemp(join(tmpdir(), "assistant-compress-video-"));
    try {
      const sourcePath = join(dir, "high-bitrate.mp4");
      await runMedia([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=24:duration=3",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "1",
        sourcePath,
      ]);
      const rawVideo = await readFile(sourcePath);
      const videoLimit = Math.floor(rawVideo.length * 0.45);
      const compressedVideo = await compressAgentUpload(
        "raw-shoot.mov",
        rawVideo,
        videoLimit,
      );
      expect(compressedVideo.compressed).toBe(true);
      expect(compressedVideo.content.length).toBeLessThanOrEqual(videoLimit);
      expect(compressedVideo.mime).toBe("video/mp4");
      const videoMeta = await inspectVideo(compressedVideo.content);
      expect(videoMeta.duration).toBeCloseTo(3, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 45000);
  it("accepts >100MP images and tall detail-page PNGs exceeding WebP 16383px limit", async () => {
    // 1. 超过 1 亿像素（10500x10500 = 1.1025 亿像素）的纯色 PNG 应可正常通过校验与解析
    const hugePng = await sharp({
      create: {
        width: 10500,
        height: 10500,
        channels: 3,
        background: { r: 240, g: 242, b: 245 },
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const hugeMeta = await inspectAgentUpload("studio-huge.png", hugePng);
    expect(hugeMeta.mime).toBe("image/png");

    // 2. 高度超过 WebP 16383px 限制的电商详情长图（20x17000）应自动绕过 WebP 单边限制并成功压缩
    const tallPng = await sharp({
      create: {
        width: 20,
        height: 17000,
        channels: 3,
        background: { r: 220, g: 230, b: 240 },
      },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const tallLimit = Math.floor(tallPng.length * 0.25);
    const compressedTall = await compressAgentUpload(
      "detail-long.png",
      tallPng,
      tallLimit,
    );
    expect(compressedTall.compressed).toBe(true);
    expect(compressedTall.content.length).toBeLessThanOrEqual(tallLimit);
    expect((await inspectAgentUpload(compressedTall.name, compressedTall.content)).mime).toBe(
      compressedTall.mime,
    );
  }, 30000);
  it("only renders verified public URL citations", () => {
    expect(
      publicCitations([
        {
          type: "url_citation",
          url_citation: { url: "javascript:alert(1)", title: "bad" },
        },
        {
          type: "url_citation",
          url_citation: { url: "https://example.com/report", title: "报告" },
        },
      ]),
    ).toEqual([{ url: "https://example.com/report", title: "报告" }]);
  });
});
