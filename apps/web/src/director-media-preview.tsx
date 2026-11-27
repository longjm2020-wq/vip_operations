import { useEffect, useState, type ReactNode } from "react";
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

function LibraryPreview({
  asset,
  atMs,
}: {
  asset: DirectorAsset;
  atMs: number;
}) {
  const [failed, setFailed] = useState(false);
  if (!asset.fileId)
    return (
      <PreviewMessage
        icon={<FileTextOutlined />}
        label="此素材缺少工作台文件，请重新选择。"
      />
    );
  const url = directorFileUrl(asset.fileId);
  const openFile = (
    <a href={url} target="_blank" rel="noreferrer">
      打开 {asset.name}
    </a>
  );
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
  if (asset.source === "library")
    return (
      <LibraryPreview
        key={`${asset.fileId}/${frameMs}`}
        asset={asset}
        atMs={frameMs}
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
