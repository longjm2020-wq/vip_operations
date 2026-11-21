import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Spin } from "antd";
import {
  CloseOutlined,
  DownloadOutlined,
  FileOutlined,
  PauseOutlined,
  PlayCircleOutlined,
} from "@ant-design/icons";
import type { AgentFile } from "../../../packages/contracts/src/assistant-agent";
import { agentContentUrl } from "./assistant-agent-panel";
import {
  agentArtifactFrameHtml,
  analyzeAgentArtifact,
  maxAgentArtifactPreviewBytes,
} from "./assistant-artifact-document";
import "./assistant-artifact-preview.css";

const sizeError = "文件超过在线预览大小限制，可下载原文件。";
const requestTimeoutMs = 20_000;

async function loadArtifact(url: string, mime: string, signal: AbortSignal) {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  if (!response.ok || !response.body) throw Error("无法读取文件，请重试。");
  if (
    Number(response.headers.get("content-length")) >
    maxAgentArtifactPreviewBytes
  ) {
    await response.body.cancel().catch(() => undefined);
    throw Error(sizeError);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let source = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxAgentArtifactPreviewBytes) throw Error(sizeError);
      source += decoder.decode(value, { stream: true });
    }
    return analyzeAgentArtifact(source + decoder.decode(), mime);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function animatedSvgRoots(document: Document) {
  return Array.from(
    Document.prototype.querySelectorAll.call(document, "svg:not(svg svg)"),
  ).filter(
    (svg): svg is SVGSVGElement =>
      svg.namespaceURI === "http://www.w3.org/2000/svg" &&
      Boolean(
        svg.querySelector("animate, animateMotion, animateTransform, set"),
      ),
  );
}

function ArtifactFrame({ name, source }: { name: string; source: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const suspended = useRef<{
    css: Animation[];
    svg: SVGSVGElement[];
  } | null>(null);
  const [hasAnimation, setHasAnimation] = useState(false);
  const [paused, setPaused] = useState(false);

  function toggleMotion() {
    if (suspended.current) {
      suspended.current.css.forEach((animation) => animation.play());
      suspended.current.svg.forEach((svg) => svg.unpauseAnimations());
      suspended.current = null;
      setPaused(false);
      return;
    }

    const document = frame.current?.contentDocument;
    if (!document) return;
    const css = Document.prototype.getAnimations
      .call(document)
      .filter((animation) => animation.playState === "running");
    const svg = animatedSvgRoots(document).filter(
      (element) => !element.animationsPaused(),
    );
    css.forEach((animation) => animation.pause());
    svg.forEach((element) => element.pauseAnimations());
    suspended.current = { css, svg };
    setPaused(true);
  }

  return (
    <>
      <iframe
        ref={frame}
        className="assistant-artifact-frame"
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        title={`${name} 的预览`}
        srcDoc={source}
        onLoad={() => {
          const document = frame.current?.contentDocument;
          setHasAnimation(
            Boolean(
              document &&
              (Document.prototype.getAnimations.call(document).length ||
                animatedSvgRoots(document).length),
            ),
          );
        }}
      />
      <div className="assistant-artifact-footer">
        <small>预览已停用页面脚本和外部资源。</small>
        {hasAnimation && (
          <Button
            size="small"
            type="text"
            icon={paused ? <PlayCircleOutlined /> : <PauseOutlined />}
            onClick={toggleMotion}
          >
            {paused ? "继续动画" : "暂停动画"}
          </Button>
        )}
      </div>
    </>
  );
}

type PreviewProps = { file: AgentFile; onClose: () => void };
type ArtifactState =
  | { status: "ready"; artifact: ReturnType<typeof analyzeAgentArtifact> }
  | { status: "error"; message: string };

export function AssistantArtifactPreview({ file, onClose }: PreviewProps) {
  const url = agentContentUrl(file.id);
  const mime = file.mime;
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<ArtifactState>();

  useEffect(() => {
    const request = new AbortController();
    const timer = window.setTimeout(() => {
      request.abort();
      setResult({ status: "error", message: "读取文件超时，请重试。" });
    }, requestTimeoutMs);
    void loadArtifact(url, mime, request.signal)
      .then(
        (artifact) => {
          if (!request.signal.aborted) setResult({ status: "ready", artifact });
        },
        (error: unknown) => {
          if (!request.signal.aborted)
            setResult({
              status: "error",
              message:
                error instanceof Error && error.message === sizeError
                  ? sizeError
                  : "无法读取文件，请重试。",
            });
        },
      )
      .finally(() => window.clearTimeout(timer));
    return () => {
      window.clearTimeout(timer);
      request.abort();
    };
  }, [url, mime, attempt]);

  const artifact = result?.status === "ready" ? result.artifact : undefined;
  const hasInlinePreview = artifact && artifact.kind !== "text";
  const frameSource = useMemo(
    () => (artifact ? agentArtifactFrameHtml(artifact) : ""),
    [artifact],
  );
  return (
    <section className="assistant-artifact-preview" aria-label="文件预览">
      <header className="assistant-artifact-toolbar">
        <div className="assistant-artifact-file-title">
          <FileOutlined aria-hidden />
          <h3 title={file.name}>{file.name}</h3>
        </div>
        <div className="assistant-artifact-actions">
          <Button
            size="small"
            type="text"
            href={url}
            download={file.name}
            icon={<DownloadOutlined />}
            aria-label="下载原文件"
            title="下载原文件"
          />
          <Button
            size="small"
            type="text"
            icon={<CloseOutlined />}
            aria-label="关闭文件预览"
            title="关闭文件预览"
            onClick={onClose}
          />
        </div>
      </header>

      {hasInlinePreview && (
        <div
          className="assistant-artifact-modes"
          role="group"
          aria-label="文件查看方式"
        >
          <Button
            size="small"
            type={mode === "preview" ? "default" : "text"}
            aria-pressed={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            预览
          </Button>
          <Button
            size="small"
            type={mode === "source" ? "default" : "text"}
            aria-pressed={mode === "source"}
            onClick={() => setMode("source")}
          >
            源码
          </Button>
        </div>
      )}

      {!result && (
        <div className="assistant-artifact-status" role="status">
          <Spin size="small" /> 正在读取文件…
        </div>
      )}
      {result?.status === "error" && (
        <div className="assistant-artifact-status">
          <span role="alert">{result.message}</span>
          {result.message !== sizeError && (
            <Button
              size="small"
              onClick={() => {
                setResult(undefined);
                setAttempt((current) => current + 1);
              }}
            >
              重试
            </Button>
          )}
        </div>
      )}
      {artifact &&
        (hasInlinePreview && mode === "preview" ? (
          <ArtifactFrame name={file.name} source={frameSource} />
        ) : (
          <pre
            className="assistant-artifact-code"
            tabIndex={0}
            aria-label="文件源码"
          >
            {artifact.code || "文件为空。"}
          </pre>
        ))}
    </section>
  );
}
