import { directorAssetLimit, type DirectorAsset } from "../../../packages/contracts/src/director";
import { inferDirectorRole, uniqueDirectorKinds } from "../../../packages/contracts/src/director-intent";
import {
  acceptsDirectorFolderRole, directorFolderRole, directorRoleNames,
} from "../../../packages/contracts/src/director-import-roles";

type Role = DirectorAsset["role"];
const mimeTypes: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".txt": "text/plain", ".md": "text/markdown", ".srt": "text/plain", ".csv": "text/csv",
  ".json": "application/json", ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export function browserFileAccept(role?: Role) {
  return Object.entries(mimeTypes)
    .filter(([, mime]) => !role || acceptsDirectorFolderRole(role, mime))
    .map(([ext]) => ext).join(",");
}

// File objects refer to OS files. Only active projects hold these references.
const projects = new Map<string, Map<string, File>>();
const listeners = new Set<() => void>();
export function subscribeBrowserFiles(notify: () => void) {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}
function changed() {
  for (const notify of listeners) notify();
}
export function getBrowserFile(projectId: string, assetId: string) {
  return projects.get(projectId)?.get(assetId);
}
export function releaseBrowserFile(projectId: string, assetId: string) {
  if (projects.get(projectId)?.delete(assetId)) changed();
}
export function releaseBrowserFiles(projectId: string) {
  if (projects.delete(projectId)) changed();
}
function projectFiles(projectId: string) {
  let files = projects.get(projectId);
  if (!files) projects.set(projectId, files = new Map());
  return files;
}

async function digest(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
// Sample a fixed number of bytes per file, even for multi-gigabyte videos. A
// separate directory fingerprint distinguishes same-named files in different styles.
const identityLength = 40;
async function sourceKey(file: File) {
  const sample = 8192;
  const metadata = JSON.stringify([file.name, file.size, file.lastModified]);
  const slices = file.size <= sample * 3 ? [file] : [
    file.slice(0, sample),
    file.slice(Math.floor((file.size - sample) / 2), Math.floor((file.size - sample) / 2) + sample),
    file.slice(-sample),
  ];
  const content = await digest(await new Blob([metadata, ...slices]).arrayBuffer());
  const folder = file.webkitRelativePath.split("/").slice(0, -1).join("/");
  const location = await digest(new TextEncoder().encode(folder).buffer);
  return content.slice(0, identityLength) + location.slice(0, 64 - identityLength);
}

export async function reconnectBrowserFile(projectId: string, asset: DirectorAsset, file: File) {
  const files = projectFiles(projectId);
  const key = await sourceKey(file);
  if (asset.source !== "browser" || key.slice(0, identityLength) !== asset.browserKey?.slice(0, identityLength))
    throw Error("所选文件与原素材不一致，请选择导入时的原文件。");
  if (projects.get(projectId) === files) {
    files.set(asset.id, file);
    changed();
  }
}

type ImportOptions = {
  projectId: string;
  files: readonly File[];
  assets: readonly DirectorAsset[];
  brief: string;
  role?: Role;
};

export async function importBrowserFiles({ projectId, files, assets, brief, role }: ImportOptions) {
  const references = projectFiles(projectId);
  const known = new Map(assets.flatMap(asset =>
    asset.source === "browser" && asset.browserKey ? [[asset.browserKey, asset] as const] : [],
  ));
  const result = {
    added: [] as DirectorAsset[], reconnected: 0, duplicates: 0,
    skipped: 0, problems: [] as string[], overLimit: false,
  };
  const mimeOf = (file: File) => mimeTypes[file.name.match(/\.[^.]+$/)?.[0].toLowerCase() ?? ""];
  const uniqueKinds = uniqueDirectorKinds([
    ...assets.map(asset => asset.mime), ...files.map(file => mimeOf(file) || ""),
  ]);
  const knownNames = new Set(assets.filter(asset => asset.source === "browser").map(asset => asset.name));
  for (const file of files) {
    if (projects.get(projectId) !== references) break;
    try {
      const mime = mimeOf(file);
      if (!mime) throw Error("不支持此文件格式");
      if (!file.size) throw Error("文件为空");
      if (file.name.length > 255 || /[\\/\u0000-\u001f]/u.test(file.name)) throw Error("文件名无效");
      const intended = role ?? directorFolderRole(file.webkitRelativePath);
      if (intended && !acceptsDirectorFolderRole(intended, mime))
        throw Error(`文件类型不适用于「${directorRoleNames[intended]}」`);
      const full = assets.length + result.added.length >= directorAssetLimit;
      if (full && !knownNames.has(file.name)) { result.overLimit = true; continue; }
      const key = await sourceKey(file);
      if (projects.get(projectId) !== references) break;
      let existing = known.get(key);
      if (!existing && !file.webkitRelativePath) {
        // A single-file selection has no directory context. Never guess between
        // two matching directory entries when restoring a previous session.
        const contentKey = key.slice(0, identityLength);
        const matches = [...known].filter(([saved]) => saved.startsWith(contentKey));
        if (matches.length > 1) throw Error("有多份同名素材，请重新选择原文件夹或在预览中逐个关联");
        existing = matches[0]?.[1];
      }
      if (existing) {
        if (references.has(existing.id)) result.duplicates++;
        else {
          references.set(existing.id, file);
          result.reconnected++;
        }
        continue;
      }
      if (full) { result.overLimit = true; continue; }
      const asset: DirectorAsset = {
        id: crypto.randomUUID(), source: "browser", browserKey: key,
        name: file.name, mime,
        role: intended ?? inferDirectorRole(file.name, mime, brief, uniqueKinds.has(mime.split("/")[0])),
      };
      references.set(asset.id, file);
      known.set(key, asset);
      knownNames.add(asset.name);
      result.added.push(asset);
    } catch (error) {
      result.skipped++;
      if (result.problems.length < 5)
        result.problems.push(`${file.name}：${error instanceof Error ? error.message : "无法读取原文件"}`);
    }
  }
  changed();
  return result;
}

function videoEvent(video: HTMLVideoElement, name: "loadeddata" | "seeked", start: () => void) {
  return new Promise<void>((resolve, reject) => {
    function finish(error?: string) {
      clearTimeout(timeout);
      video.removeEventListener(name, ready);
      video.removeEventListener("error", failed);
      if (error) reject(Error(error)); else resolve();
    }
    const ready = () => finish();
    const failed = () => finish("浏览器无法解码此视频，请在原电脑的 Windows 小序中导入并拆解。");
    const timeout = window.setTimeout(() => finish("读取本机视频画面超时，请重新选择可播放的原文件。"), 15_000);
    video.addEventListener(name, ready);
    video.addEventListener("error", failed);
    try { start(); } catch { failed(); }
  });
}

export async function browserReferenceFrames(projectId: string, asset: DirectorAsset) {
  const file = getBrowserFile(projectId, asset.id);
  if (!file) throw Error("请在素材预览中重新关联原文件，再拆解参考片。");
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    await videoEvent(video, "loadeddata", () => { video.src = url; });
    const duration = Math.floor(video.duration * 1000);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86_400_000 || !video.videoWidth || !video.videoHeight)
      throw Error("参考片须为可播放且不超过 24 小时的视频。");
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(scale * video.videoWidth));
    canvas.height = Math.max(1, Math.round(scale * video.videoHeight));
    const context = canvas.getContext("2d");
    if (!context) throw Error("浏览器无法读取视频画面。");
    const frames: { timeMs: number; jpeg: string }[] = [];
    for (const timeMs of new Set([0, 1, 2, 3].map(index => Math.floor(duration * index / 4)))) {
      if (timeMs) await videoEvent(video, "seeked", () => { video.currentTime = timeMs / 1000; });
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({ timeMs, jpeg: canvas.toDataURL("image/jpeg", 0.78).split(",")[1] });
    }
    return frames;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
    canvas.width = canvas.height = 1;
  }
}
