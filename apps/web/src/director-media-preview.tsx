import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, Spin } from "antd";
import {
  AudioOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  PictureOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import type { DirectorAsset } from "../../../packages/contracts/src/director";
import { localDirectorRequest } from "./director-native";
import { directorFileUrl, isVisual } from "./director-project";
import { getBrowserFile, reconnectBrowserFile, subscribeBrowserFiles } from "./director-browser-files";
import "./director-media-preview.css";

type PreviewProps = {
  asset?: DirectorAsset;
  projectId: string;
  canOpenLocal: boolean;
  canReadFrame?: boolean;
  atMs?: number;
  emptyDescription?: string;
  onOpen: (id: string) => void;
};

function PreviewMessage({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children?: ReactNode;
}) {
  return (
    <div className="director-media-message">
      <span className="director-media-symbol" aria-hidden="true">
        {icon}
      </span>
      <p>{label}</p>
      {children}
    </div>
  );
}

function FramePreview({
  projectId,
  localId,
  name,
  atMs,
  openButton,
  video,
}: {
  projectId: string;
  localId: string;
  name: string;
  atMs: number;
  openButton: ReactNode;
  video: boolean;
}) {
  const [frame, setFrame] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    // Browsing through the asset list should only start FFmpeg for the settled selection.
    const timer = window.setTimeout(async () => {
      try {
        const result = await localDirectorRequest(
          "read-frame",
          { projectId, assetId: localId, atMs },
          controller.signal,
        );
        if (!result.base64 || result.mime !== "image/jpeg")
          throw Error("本机未返回预览画面。");
        if (!controller.signal.aborted)
          setFrame(`data:image/jpeg;base64,${result.base64}`);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : "无法读取本机画面。",
          );
      }
    }, 140);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, localId, atMs, attempt]);

  if (error)
    return (
      <PreviewMessage icon={<PictureOutlined />} label={error}>
        <div className="director-media-actions">
          <Button
            size="small"
            onClick={() => {
              setError("");
              setFrame("");
              setAttempt(attempt + 1);
            }}
          >
            重新读取画面
          </Button>
          {openButton}
        </div>
      </PreviewMessage>
    );
  if (!frame)
    return (
      <div className="director-media-message">
        <div className="director-media-loading" role="status">
          <Spin size="small" />
          正在读取本机画面…
        </div>
        {openButton}
      </div>
    );
  return (
    <figure className="director-media-frame">
      <img
        src={frame}
        alt={`${name}的预览画面`}
        onError={() => setError("本机返回的画面无法显示。")}
      />
      <figcaption>
        <span>
          {video
            ? `视频画面 · ${Number((atMs / 1000).toFixed(2))} 秒`
            : "本机图片"}
        </span>
        {openButton}
      </figcaption>
    </figure>
  );
}

function MediaFilePreview({
  asset,
  atMs,
  url,
  openFile,
}: {
  asset: DirectorAsset;
  atMs: number;
  url: string;
  openFile?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <PreviewMessage
        icon={<FolderOpenOutlined />}
        label="此文件无法在页面中预览。"
      >
        {openFile}
      </PreviewMessage>
    );
  if (asset.mime.startsWith("image/"))
    return <img src={url} alt={asset.name} onError={() => setFailed(true)} />;
  if (asset.mime.startsWith("video/"))
    return (
      <video
        aria-label={asset.name}
        src={url}
        controls
        playsInline
        preload="metadata"
        onLoadedMetadata={({ currentTarget }) => {
          if (atMs > 0 && Number.isFinite(currentTarget.duration)) {
            currentTarget.currentTime = Math.min(
              atMs / 1000,
              Math.max(0, currentTarget.duration - 0.001),
            );
          }
        }}
        onError={() => setFailed(true)}
      />
    );
  if (asset.mime.startsWith("audio/"))
    return (
      <audio
        aria-label={asset.name}
        src={url}
        controls
        preload="metadata"
        onError={() => setFailed(true)}
      />
    );
  return (
    <PreviewMessage icon={<FileTextOutlined />} label="工作台文档">
      {openFile}
    </PreviewMessage>
  );
}

function ReconnectFile({ projectId, asset }: {
  projectId: string;
  asset: DirectorAsset;
}) {
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button size="small" onClick={() => picker.current?.click()}>重新关联原文件</Button>
      <input ref={picker} type="file" hidden aria-label="选择要重新关联的原文件"
        onChange={(event) => {
          const selected = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!selected) return;
          setError("");
          void reconnectBrowserFile(projectId, asset, selected)
            .catch(cause => setError(cause instanceof Error ? cause.message : "无法读取本机文件。"));
        }}
      />
      {error && <span role="alert">{error}</span>}
    </>
  );
}

function BrowserFilePreview({ projectId, asset, atMs }: {
  projectId: string;
  asset: DirectorAsset;
  atMs: number;
}) {
  const file = useSyncExternalStore(subscribeBrowserFiles, () => getBrowserFile(projectId, asset.id));
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const media = isVisual(asset.mime) || asset.mime.startsWith("audio/");
  useEffect(() => {
    setUrl("");
    setExcerpt("");
    setError("");
    if (!file) return;
    if (media) {
      const next = URL.createObjectURL(file);
      setUrl(next);
      return () => URL.revokeObjectURL(next);
    }
    if (asset.mime.startsWith("text/") || asset.mime === "application/json") {
      let active = true;
      void file.slice(0, 8192).text().then(text => {
        if (active) setExcerpt(text);
      }).catch(() => { if (active) setError("读取本机文档失败，请重新选择原件。"); });
      return () => { active = false; };
    }
  }, [file, media, asset.mime]);
  const reconnect = <ReconnectFile projectId={projectId} asset={asset} />;
  if (file && media && url)
    return <MediaFilePreview key={url} asset={asset} atMs={atMs} url={url} openFile={reconnect} />;
  if (file && !media)
    return (
      <PreviewMessage icon={<FileTextOutlined />} label={excerpt ? "本机文档预览" : error || "本机文档已关联"}>
        {error && reconnect}
        {excerpt && <pre style={{ maxHeight: 180, maxWidth: "100%", overflow: "auto", whiteSpace: "pre-wrap", textAlign: "start" }}>{excerpt}</pre>}
      </PreviewMessage>
    );
  if (file) return <Spin size="small" />;
  return (
    <PreviewMessage icon={<FolderOpenOutlined />} label="重新选择导入时的原文件，即可在当前页面预览。">
      {reconnect}
    </PreviewMessage>
  );
}

export function MediaPreview({
  asset,
  projectId,
  canOpenLocal,
  canReadFrame,
  atMs = 0,
  emptyDescription,
  onOpen,
}: PreviewProps) {
  if (!asset)
    return (
      <PreviewMessage
        icon={<PictureOutlined />}
        label={emptyDescription ?? "选择素材或为当前分镜绑定画面"}
      />
    );
  const video = asset.mime.startsWith("video/");
  const frameMs = video
    ? Math.max(
        0,
        Math.min(Math.round(atMs), (asset.durationMs ?? Infinity) - 1),
      )
    : 0;
  if (asset.source === "browser")
    return <BrowserFilePreview key={`${asset.id}/${frameMs}`} projectId={projectId} asset={asset} atMs={frameMs} />;
  if (asset.source === "link")
    return (
      <PreviewMessage icon={<VideoCameraOutlined />} label="作品链接参考片">
        {asset.url && /^https?:\/\//i.test(asset.url) && <a href={asset.url} target="_blank" rel="noreferrer">查看原作品</a>}
      </PreviewMessage>
    );
  if (asset.source === "library") {
    if (!asset.fileId) return <PreviewMessage icon={<FileTextOutlined />} label="此素材缺少工作台文件，请重新选择。" />;
    const url = directorFileUrl(asset.fileId);
    return (
      <MediaFilePreview
        key={`${asset.fileId}/${frameMs}`}
        asset={asset}
        atMs={frameMs}
        url={url}
        openFile={<a href={url} target="_blank" rel="noreferrer">打开 {asset.name}</a>}
      />
    );
  }
  if (!video && !asset.mime.startsWith("image/") && !asset.mime.startsWith("audio/"))
    return (
      <PreviewMessage
        icon={<FileTextOutlined />}
        label="这份文档已登记在本机。可在项目的创作要求中填写需要采用的商品事实或文案。"
      />
    );
  if (!canOpenLocal)
    return (
      <PreviewMessage
        icon={<FolderOpenOutlined />}
        label="请在导入此素材的 Windows 小序中连接并授权本机，即可预览。"
      />
    );
  const localId = asset.localId;
  if (!localId || !projectId)
    return (
      <PreviewMessage
        icon={<FolderOpenOutlined />}
        label="本机文件记录不完整，请重新导入素材。"
      />
    );
  const openButton = (
    <Button
      size="small"
      icon={<FolderOpenOutlined />}
      onClick={() => onOpen(localId)}
    >
      在本机预览
    </Button>
  );
  if (isVisual(asset.mime) && canReadFrame)
    return (
      <FramePreview
        key={`${projectId}/${localId}/${frameMs}`}
        projectId={projectId}
        localId={localId}
        atMs={frameMs}
        name={asset.name}
        video={video}
        openButton={openButton}
      />
    );
  const audio = asset.mime.startsWith("audio/");
  return (
    <PreviewMessage
      icon={audio ? <AudioOutlined /> : <VideoCameraOutlined />}
      label={
        audio
          ? "在本机播放器中试听音频"
          : "本机画面预览需要 FFmpeg。可先打开原文件。"
      }
    >
      {openButton}
    </PreviewMessage>
  );
}
