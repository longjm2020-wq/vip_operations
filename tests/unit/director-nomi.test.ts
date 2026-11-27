import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { exportNomiProject } from "../../apps/web/src/director-nomi.js";
import { emptyDirectorLocks, type DirectorProject } from "../../packages/contracts/src/director.js";

const project: DirectorProject = {
  id: "xuti-project-id",
  title: "../通勤衬衫:竖版",
  mode: "manual",
  output: "video",
  createdAt: "2026-11-27T01:00:00Z",
  updatedAt: "2026-11-27T01:00:00Z",
  brief: "展示袖口细节\n保持自然走动",
  aspect: "9:16",
  durationMs: 7500,
  revision: 3,
  referenceAnalysis: null,
  renders: [],
  assets: [
    { id: "source-asset-id", source: "local", role: "product", name: "袖口.mp4", mime: "video/mp4",
      deviceId: "private-device-id", localId: "private-file-id", note: "should-not-include-asset-note" },
    { id: "reference-asset-id", source: "link", role: "reference", name: "节奏参考", mime: "video/mp4",
      url: "https://example.test/video?token=private-token" },
  ],
  shots: [{
    id: "source-shot-id",
    title: "袖口近景",
    direction: "从正面缓慢推近",
    framing: "特写",
    script: "领口挺括\n走线平整",
    caption: "版型利落",
    durationMs: 3200,
    visualId: "source-asset-id",
    effect: "none",
    locks: emptyDirectorLocks,
    startMs: 2000,
    audioStartMs: 0,
  }, {
    id: "source-shot-2",
    title: "",
    script: "",
    caption: "",
    durationMs: 4300,
    effect: "none",
    locks: emptyDirectorLocks,
    startMs: 0,
    audioStartMs: 0,
  }],
};

async function unpackNomiProject(source: DirectorProject) {
  const { blob, fileName } = await exportNomiProject(source);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const files = Object.values(zip.files).filter((file) => !file.dir);
  expect(files.map((file) => file.name)).toEqual([
    `${fileName.slice(0, -4)}/.nomi/project.json`,
  ]);
  const json = await files[0].async("string");
  return { fileName, json, manifest: JSON.parse(json) };
}

describe("导演台导出 Nomi 项目", () => {
  it("导出可编辑的创作稿和分镜，并将 XUTI 素材保留为名称", async () => {
    const { fileName, json, manifest } = await unpackNomiProject(project);
    expect(fileName).toMatch(/^XUTI-_+通勤衬衫_竖版-Nomi-[0-9a-f]{8}\.zip$/);
    expect(manifest).toMatchObject({
      name: project.title,
      version: 2,
      projectGeneration: 1,
      revision: 1,
      payload: { generationCanvas: { nodes: [], edges: [], selectedNodeIds: [] } },
    });
    expect(manifest.immutableProjectUuid).toMatch(/^[a-f0-9-]{36}$/);
    const documentId = manifest.payload.activeDocumentId;
    const [document] = manifest.payload.workbenchDocuments;
    expect(document.id).toBe(documentId);
    expect(document.contentJson.type).toBe("doc");
    expect(document.contentJson.content).toEqual(expect.arrayContaining([
      { type: "paragraph", content: [
        { type: "text", text: "创作要求：展示袖口细节" },
        { type: "hardBreak" },
        { type: "text", text: "保持自然走动" },
      ] },
      { type: "paragraph", content: [{ type: "text", text: "商品素材：袖口.mp4" }] },
      { type: "paragraph", content: [{ type: "text", text: "参考片：节奏参考" }] },
    ]));
    const [design] = manifest.payload.storyboardDesignsByDocumentId[documentId];
    expect(design).toMatchObject({ documentId, status: "draft", committed: false });
    expect(design.sourceDocumentUpdatedAt).toBe(document.updatedAt);
    expect(design.plan.aspectRatio).toBe("9:16");
    expect(design.plan.shots.map(({ index, durationSec, prompt }: { index: number; durationSec: number; prompt: string }) =>
      [index, durationSec, prompt.split("\n")[0]],
    )).toEqual([[1, 3.2, "袖口近景"], [2, 4.3, "分镜 2"]]);
    expect(design.plan.shots[0].prompt).toContain("口播：领口挺括\n走线平整");
    expect(design.plan.shots[0].prompt).toContain("字幕：版型利落");
    expect(design.plan.shots[0].prompt).toContain("画面与运镜：从正面缓慢推近");
    expect(design.plan.shots[0].prompt).toContain("画面素材：袖口.mp4");
    expect(json).not.toMatch(/project-id|asset-id|source-shot|private-|should-not-include|https:/);
  });

  it("重复导出使用新的项目身份，只写入已有创作内容", async () => {
    const emptyProject = { ...project, shots: [], assets: [] };
    const first = await unpackNomiProject(emptyProject);
    const second = await unpackNomiProject(emptyProject);
    expect(first.fileName).not.toBe(second.fileName);
    expect(first.manifest.id).not.toBe(second.manifest.id);
    expect(first.manifest.payload.storyboardDesignsByDocumentId).toBeUndefined();
    expect(first.json).toContain("展示袖口细节");
  });
});
