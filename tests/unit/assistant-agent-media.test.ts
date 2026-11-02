import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { createAgentDocument } from "../../apps/api/src/modules/workspace/agent-documents.js";
import {
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
