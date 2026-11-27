import type { DirectorAsset, DirectorProject, DirectorShot } from "../../../packages/contracts/src/director";
import { directorRoleNames } from "../../../packages/contracts/src/director-import-roles";

function labeledLines(fields: ReadonlyArray<readonly [string, string | undefined]>) {
  return fields.flatMap(([label, value]) => value?.trim() ? [`${label}：${value.trim()}`] : []);
}

function paragraph(value: string) {
  const content = value.split(/\r?\n/).flatMap((line, index) => [
    ...(index > 0 ? [{ type: "hardBreak" }] : []),
    ...(line ? [{ type: "text", text: line }] : []),
  ]);
  return { type: "paragraph", content };
}

function describeShot(shot: DirectorShot, assets: Map<string, DirectorAsset>, index: number) {
  const assetName = (id?: string) => id ? assets.get(id)?.name : undefined;
  const title = shot.title.trim() || `分镜 ${index}`;
  const fields = labeledLines([
    ["用途", shot.purpose],
    ["景别", shot.framing],
    ["画面与运镜", shot.direction],
    ["口播", shot.script],
    ["字幕", shot.caption],
    ["画面素材", assetName(shot.visualId)],
    ["正式配音", assetName(shot.audioId)],
    ["授权肖像", assetName(shot.portraitId)],
    ["授权音色", assetName(shot.voiceSampleId)],
    ["画面文字", shot.effectText],
  ]);
  return { title, fields };
}

export async function exportNomiProject(project: DirectorProject): Promise<{ blob: Blob; fileName: string }> {
  const { default: JSZip } = await import("jszip");
  const now = Date.now();
  const projectUuid = crypto.randomUUID();
  const documentId = `doc-${crypto.randomUUID()}`;
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const shots = project.shots.map((shot, offset) => ({
    index: offset + 1,
    durationSec: shot.durationMs / 1000,
    ...describeShot(shot, assets, offset + 1),
  }));
  const documentLines = [
    `画幅：${project.aspect} · 目标时长：${project.durationMs / 1000} 秒`,
    ...labeledLines([["创作要求", project.brief]]),
    ...shots.flatMap((shot) => [
      `${shot.index}. ${shot.title}（${shot.durationSec} 秒）`,
      ...shot.fields,
    ]),
    ...(project.assets.length ? [
      "素材清单（请在 Nomi 中添加所需原件）",
      ...project.assets.map((asset) => `${directorRoleNames[asset.role]}：${asset.name}`),
    ] : []),
  ];

  // Nomi reads a version 2 manifest from .nomi/project.json when opening a folder.
  // The exported documents and storyboard are drafts with fresh identities.
  const manifest = {
    id: `workspace-${projectUuid}`,
    name: project.title.trim() || "未命名项目",
    version: 2,
    createdAt: now,
    updatedAt: now,
    savedAt: now,
    revision: 1,
    immutableProjectUuid: projectUuid,
    projectGeneration: 1,
    payload: {
      workbenchDocuments: [{
        id: documentId,
        version: 1,
        title: "XUTI 导演台创作稿",
        contentJson: { type: "doc", content: documentLines.map(paragraph) },
        updatedAt: now,
      }],
      activeDocumentId: documentId,
      generationCanvas: { nodes: [], edges: [], selectedNodeIds: [] },
      ...(shots.length ? {
        storyboardDesignsByDocumentId: {
          [documentId]: [{
            id: `storyboard-${crypto.randomUUID()}`,
            documentId,
            title: "XUTI 导演台分镜",
            plan: {
              title: "XUTI 导演台分镜",
              anchors: [],
              aspectRatio: project.aspect,
              shots: shots.map(({ index, title, fields, durationSec }) => ({
                index,
                shotId: `shot-${crypto.randomUUID()}`,
                shotKind: "video",
                durationSec,
                anchorIds: [],
                prompt: [title, ...fields].join("\n"),
                params: { aspect_ratio: project.aspect },
              })),
            },
            committed: false,
            status: "draft",
            sourceDocumentUpdatedAt: now,
            createdAt: now,
            updatedAt: now,
          }],
        },
      } : {}),
    },
  };

  // Keep the archive path portable across Windows and macOS, including very long titles.
  const folderTitle = Array.from(manifest.name.replace(/[^\p{L}\p{N} _-]/gu, "_").trim())
    .slice(0, 50).join("");
  const folder = `XUTI-${folderTitle}-Nomi-${projectUuid.slice(0, 8)}`;
  const zip = new JSZip();
  zip.file(`${folder}/.nomi/project.json`, JSON.stringify(manifest, null, 2));
  return { blob: await zip.generateAsync({ type: "blob" }), fileName: `${folder}.zip` };
}
