import { isDesktopClient } from "./desktop-client";

export type DirectorLocalAsset = {
  id: string;
  name: string;
  kind: "image" | "video" | "audio";
  bytes: number;
  durationMs?: number;
};

export type DirectorLocalPlan = {
  aspect: "9:16" | "16:9" | "1:1";
  shots: Array<{
    id: string;
    visualId: string;
    audioId?: string;
    startMs?: number;
    audioStartMs?: number;
    durationMs: number;
    caption: string;
    title?: string;
    script?: string;
    purpose?: string;
    framing?: string;
    direction?: string;
    evidence?: string;
    effect: "none" | "fade" | "push-in" | "callout" | "size-card";
    effectText?: string;
    voice?: {
      sampleId: string;
      text: string;
      referenceText?: string;
      authorized: true;
    };
    presenter?: { portraitId: string };
    template?: {
      kind: "ae_template" | "lottie" | "pag";
      templateId: string;
      fields: { title?: string; subtitle?: string; product?: string };
      imageId?: string;
    };
  }>;
};

export type DirectorLocalJob = {
  jobId?: string;
  state: "idle" | "running" | "paused" | "completed" | "failed";
  stage: string;
  progress: number;
  completedShots: number;
  totalShots: number;
  reusedShots: number;
  error?: string;
};

export type DirectorLocalArtifact =
  "video" | "storyboard" | "subtitles" | "plan";

type LocalRevision = { projectId: string; version: number };
type LocalAssets = { assets: DirectorLocalAsset[] };
type PickResult = LocalAssets & {
  skippedFiles?: number;
  skippedFolders?: number;
  duplicates?: number;
  cancelled?: boolean;
  overLimit?: boolean;
  problems?: string[];
};
type LocalOperations = {
  capabilities: [
    Record<string, never>,
    {
      ffmpeg: boolean;
      installation: string;
      localReferenceImport?: boolean;
      voice_clone?: boolean;
      talking_head?: boolean;
      templates?: { id: string; kind: "ae_template" | "lottie" | "pag" }[];
    },
  ];
  pick: [
    { projectId: string; kind: "files" | "folder"; remaining?: number; knownIds?: string[] },
    PickResult,
  ];
  import: [{ projectId: string; fileId: string; name: string }, LocalAssets];
  preview: [{ projectId: string; assetId: string }, { opened: true }];
  "read-frame": [
    { projectId: string; assetId: string; atMs?: number },
    { mime: "image/jpeg"; base64: string },
  ];
  start: [LocalRevision & { plan: DirectorLocalPlan }, DirectorLocalJob];
  status: [LocalRevision, DirectorLocalJob];
  pause: [LocalRevision, DirectorLocalJob];
  resume: [LocalRevision, DirectorLocalJob];
  open: [
    LocalRevision & { artifact: DirectorLocalArtifact | "folder" },
    { opened: true },
  ];
};

export function supportsLocalDirector() {
  return isDesktopClient() && window.xutiDesktop?.director === true;
}

export function localDirectorRequest<Operation extends keyof LocalOperations>(
  operation: Operation,
  payload: LocalOperations[Operation][0],
  signal?: AbortSignal,
  onPickProgress?: (processed: number) => void,
): Promise<LocalOperations[Operation][1]> {
  const bridge = supportsLocalDirector() ? window.chrome?.webview : undefined;
  if (!bridge)
    return Promise.reject(
      new Error("请在支持 AI 导演台的小序 Windows 桌面端使用本机剪辑。"),
    );
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const clean = () => {
      clearTimeout(timeout);
      bridge.removeEventListener("message", receive);
      window.removeEventListener("pagehide", leave);
      signal?.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      clean();
      reject(signal?.reason);
    };
    const leave = () => {
      clean();
      reject(new Error("页面已切换，可返回原项目查看进度。"));
    };
    const receive = (event: MessageEvent) => {
      const response = event.data;
      if (response?.id !== id) return;
      if (operation === "pick" && response.channel === "xuti-director-progress") {
        if (Number.isSafeInteger(response.processed) && response.processed >= 0)
          onPickProgress?.(response.processed);
        return;
      }
      if (response.channel !== "xuti-desktop") return;
      clean();
      if (!response.ok) {
        reject(
          new Error(
            typeof response.error === "string"
              ? response.error
              : "本机操作未完成，请重试。",
          ),
        );
        return;
      }
      resolve(response.data);
    };
    const timeoutMs =
      operation === "pick" || operation === "import"
        ? 120_000
        : operation === "capabilities"
          ? 65_000
          : operation === "read-frame"
            // The native client verifies the device/project grant (9s) before extracting a frame (15s).
            ? 30_000
            : 20_000;
    // The native picker can stay open while the user chooses a folder. Linked
    // imports report progress while indexing it and finish with one receipt.
    const timeout = operation === "pick" && "remaining" in payload
      ? undefined
      : setTimeout(() => {
          clean();
          reject(new Error("本机响应超时，请查看项目进度后重试。"));
        }, timeoutMs);
    if (signal?.aborted) return cancel();
    bridge.addEventListener("message", receive);
    window.addEventListener("pagehide", leave, { once: true });
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      bridge.postMessage({
        channel: "xuti-desktop",
        id,
        action: `director-${operation}`,
        payload,
      });
    } catch {
      clean();
      reject(new Error("无法连接本机剪辑，请重新打开小序桌面端。"));
    }
  });
}
