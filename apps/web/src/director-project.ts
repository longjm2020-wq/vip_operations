import type { AgentFile } from "../../../packages/contracts/src/assistant-agent";
import type {
  DirectorAsset,
  DirectorProject,
  DirectorRender,
  DirectorShot,
} from "../../../packages/contracts/src/director";
import { inferDirectorRole } from "../../../packages/contracts/src/director-intent";
export { directorRoleNames as roleNames } from "../../../packages/contracts/src/director-import-roles";
import { api } from "./api";
import {
  localDirectorRequest,
  type DirectorLocalAsset,
  type DirectorLocalJob,
  type DirectorLocalPlan,
} from "./director-native";

export const directorPath = "/my-workspace/director/projects";
const libraryPath = "/my-workspace/assistant/files";
export const directorFileUrl = (id: string) =>
  `/api/v1${libraryPath}/${encodeURIComponent(id)}/content`;
export const effectNames = {
  none: "无",
  fade: "淡入淡出",
  "push-in": "推近",
  callout: "标注",
  "size-card": "尺码卡",
  "ae-template": "本机动效模板",
} satisfies Record<DirectorShot["effect"], string>;
export const artifactNames = {
  video: "视频成片（MP4）",
  storyboard: "分镜脚本",
  srt: "字幕（SRT）",
  plan: "剪辑方案",
} satisfies Record<DirectorRender["outputs"][number], string>;

export function isVisual(mime: string) {
  return mime.startsWith("image/") || mime.startsWith("video/");
}

export function directorMediaTypeLabel(mime: string) {
  if (mime.startsWith("video/")) return "视频";
  if (mime.startsWith("image/")) return "图片";
  if (mime.startsWith("audio/")) return "音频";
  return "文档";
}

export function canUseDirectorVisual(asset: Pick<DirectorAsset, "role" | "mime">) {
  return (
    (asset.role === "product" && isVisual(asset.mime)) ||
    (asset.role === "portrait" && asset.mime.startsWith("image/"))
  );
}

export function canContainAudio(mime: string) {
  return mime.startsWith("audio/") || mime.startsWith("video/");
}

export function acceptsDirectorRole(role: DirectorAsset["role"], mime: string) {
  if (role === "product") return isVisual(mime);
  if (role === "portrait") return mime.startsWith("image/");
  if (role === "reference") return mime.startsWith("video/");
  if (role === "voiceSample" || role === "narration")
    return canContainAudio(mime);
  return true;
}

export function libraryDirectorAsset(
  file: AgentFile,
  brief?: string,
  onlyOfKind = false,
): DirectorAsset {
  return {
    id: crypto.randomUUID(),
    source: "library",
    fileId: file.id,
    name: file.name,
    mime: file.mime,
    durationMs:
      file.duration === undefined
        ? undefined
        : Math.round(file.duration * 1000),
    role: inferDirectorRole(file.name, file.mime, brief, onlyOfKind),
  };
}

export function localDirectorAsset(
  asset: DirectorLocalAsset,
  deviceId: string,
  brief?: string,
  onlyOfKind = false,
): DirectorAsset {
  const ext = asset.name.split(".").at(-1)?.toLowerCase() || "";
  const mime = asset.kind === "document" ? (localDocumentMimes[ext] ?? "application/octet-stream") : `${asset.kind}/${ext || "unknown"}`;
  return {
    id: crypto.randomUUID(),
    source: "local",
    localId: asset.id,
    deviceId,
    name: asset.name,
    mime,
    durationMs: asset.durationMs,
    role: asset.folderRole ?? inferDirectorRole(asset.name, mime, brief, onlyOfKind),
  };
}

const localDocumentMimes: Record<string, string> = {
  txt: "text/plain", srt: "text/plain", md: "text/markdown", pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};


export function libraryDirectorFiles(signal: AbortSignal) {
  return api(libraryPath, "GET", undefined, undefined, { signal }).then(
    (result) => result.data as AgentFile[],
  );
}

export function projectDirectorFields(project: DirectorProject) {
  const { title, brief, mode, output, aspect, durationMs, assets, shots } =
    project;
  return { title, brief, mode, output, aspect, durationMs, assets, shots };
}

export function nativeDirectorPlan(
  project: Pick<DirectorProject, "title" | "aspect" | "shots" | "assets">,
  deviceId: string,
  capabilities: Awaited<ReturnType<typeof getDirectorCapabilities>>,
  shotId?: string,
) {
  const library = new Map<string, DirectorAsset>();
  const shots = shotId
    ? project.shots.filter((shot) => shot.id === shotId)
    : project.shots;
  if (!shots.length) throw Error("请先添加至少一条分镜。");
  const plan: DirectorLocalPlan = {
    aspect: project.aspect,
    shots: shots.map((shot, index) => {
      const label = shot.title || `分镜 ${index + 1}`;
      const asset = (
        id: string | undefined,
        purpose: "visual" | "audio" | "voiceSample" | "portrait",
      ) => {
        if (!id) return undefined;
        const found = project.assets.find((item) => item.id === id);
        if (!found) throw Error(`${label} 的素材已移除，请重新选择。`);
        if (found.source === "browser")
          throw Error(`请在桌面端导入「${found.name}」的本机原文件，再为「${label}」选择导入的素材。`);
        if (purpose === "visual" && !isVisual(found.mime))
          throw Error(`${label} 需要图片或视频画面素材。`);
        if (
          (purpose === "audio" || purpose === "voiceSample") &&
          !canContainAudio(found.mime)
        )
          throw Error(`${label} 需要含音轨的素材。`);
        if (purpose === "portrait" && !found.mime.startsWith("image/"))
          throw Error(`${label} 需要单张肖像图片。`);
        if (
          (found.role === "voiceSample" || found.role === "portrait") &&
          !found.authorized
        )
          throw Error(`请先确认 ${found.name} 在此项目中的使用授权。`);
        if (found.source === "local") {
          if (!found.localId || found.deviceId !== deviceId)
            throw Error(
              `${found.name} 位于另一台电脑。请切换到原电脑或重新导入该素材。`,
            );
          return { id: found.localId, asset: found };
        }
        if (!found.fileId) throw Error(`需要重新添加 ${found.name}。`);
        library.set(found.fileId, found);
        return { id: found.fileId, asset: found };
      };
      const portrait = asset(shot.portraitId, "portrait");
      const visual = asset(shot.visualId, "visual") || portrait;
      if (!visual)
        throw Error(`${label} 缺少图片或视频画面。请在分镜里选片后再剪辑。`);
      const audio = asset(shot.audioId, "audio");
      const sample = asset(shot.voiceSampleId, "voiceSample");
      if (sample && audio)
        throw Error(`${label} 请在正式配音和合成音色中选择一项。`);
      if (sample && !capabilities.voice_clone)
        throw Error("这台电脑的合成音色工具当前不可用。可以改用已录制的配音。");
      if (sample && !shot.script.trim())
        throw Error(`${label} 的配音台词为空。`);
      if (portrait && !capabilities.talking_head)
        throw Error("这台电脑的口播肖像工具当前不可用。");
      if (portrait && !audio && !sample)
        throw Error(`${label} 使用口播肖像，需要配音素材或已授权音色。`);
      const registeredTemplate = capabilities.templates?.find(
        (template) => template.id === shot.templateId,
      );
      if (!registeredTemplate && shot.effect === "ae-template")
        throw Error(`${label} 需要选择本机已安装的动效模板。`);
      const effect = shot.effect === "ae-template" ? "none" : shot.effect;
      const template =
        shot.effect === "ae-template" && registeredTemplate
          ? {
              kind: registeredTemplate.kind,
              templateId: registeredTemplate.id,
              fields: {
                title: shot.title,
                subtitle: shot.effectText || shot.caption,
                product: project.title,
              },
              imageId: visual.asset.role === "product" && visual.asset.mime.startsWith("image/") ? visual.id : undefined,
            }
          : undefined;
      return {
        id: shot.id,
        visualId: visual.id,
        startMs: shot.startMs,
        audioId: audio?.id,
        audioStartMs: shot.audioStartMs,
        durationMs: shot.durationMs,
        caption: shot.caption,
        title: shot.title,
        script: shot.script,
        purpose: shot.purpose,
        framing: shot.framing,
        direction: shot.direction,
        evidence: shot.evidence,
        effect,
        effectText: shot.effectText,
        voice: sample
          ? {
              sampleId: sample.id,
              text: shot.script,
              referenceText: sample.asset.note,
              authorized: true,
            }
          : undefined,
        presenter: portrait ? { portraitId: portrait.id } : undefined,
        template,
      };
    }),
  };
  return { library: [...library.values()], plan };
}

export function getDirectorCapabilities() {
  return localDirectorRequest("capabilities", {});
}

export function renderReceipt(render: DirectorRender, job: DirectorLocalJob) {
  if (!job.jobId || job.state === "idle") return;
  const status = job.state === "completed" ? "done" : job.state;
  const progress =
    status === "done"
      ? 100
      : Math.round(Math.max(0, Math.min(99, job.progress)));
  const stage = (job.error || job.stage).slice(0, 500);
  if (
    render.status === status &&
    render.progress === progress &&
    render.stage === stage &&
    render.jobId === job.jobId
  )
    return;
  const outputs =
    status === "done"
      ? ([
          "video",
          "storyboard",
          "srt",
          "plan",
        ] satisfies DirectorRender["outputs"])
      : undefined;
  return { jobId: job.jobId, status, progress, stage, outputs };
}
