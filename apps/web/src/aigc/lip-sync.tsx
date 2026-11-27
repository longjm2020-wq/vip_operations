import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Button, Checkbox, Tag } from "antd";
import {
  AudioOutlined,
  DownloadOutlined,
  LoadingOutlined,
  PictureOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { assetUrl, studioApi } from "./api";

const path = "/digital-human/lip-sync";
const imageFiles = ".jpg,.jpeg,.png,.webp";
const audioFiles = ".mp3,.wav,.m4a,.ogg";

const jobLabels = {
  queued: "排队中",
  submitting: "正在提交",
  generating: "正在对口型",
  saving: "正在保存成片",
  completed: "已完成",
  failed: "生成失败",
  uncertain: "结果待核实",
};

type LipSyncJob = {
  id: string;
  status: keyof typeof jobLabels;
  duration?: number;
  output?: string;
  message?: string;
  createdAt: string;
};

type LipSyncConnection = {
  configured: boolean;
  minSeconds: number;
  maxSeconds: number;
  maxImageBytes: number;
  maxAudioBytes: number;
  resolution: string;
  priceUsdPerSecond: number;
  jobs: LipSyncJob[];
};

type SelectedFile = { file: File; url: string };

export type LipSyncQuery = UseQueryResult<LipSyncConnection, Error>;

function queryKey(account: string) {
  return ["digital-human", account, "lip-sync"];
}

function isActive(job: LipSyncJob) {
  return ["queued", "submitting", "generating", "saving"].includes(job.status);
}

export function useLipSync(account: string): LipSyncQuery {
  return useQuery<LipSyncConnection>({
    queryKey: queryKey(account),
    queryFn: ({ signal }) => studioApi(path, "GET", undefined, { signal }),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.jobs.some(isActive) ? 4000 : false,
  });
}

export function LipSync({
  account,
  connection,
}: {
  account: string;
  connection: LipSyncQuery;
}) {
  const client = useQueryClient();
  const [portrait, setPortrait] = useState<SelectedFile>();
  const [audio, setAudio] = useState<SelectedFile>();
  const [duration, setDuration] = useState<number>();
  const [authorized, setAuthorized] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string>();
  const [accepted, setAccepted] = useState(false);
  const request = useRef<{ image: File; audio: File; id: string }>(null);
  const postingNow = useRef(false);

  useEffect(
    () => () => {
      if (portrait) URL.revokeObjectURL(portrait.url);
    },
    [portrait],
  );
  useEffect(
    () => () => {
      if (audio) URL.revokeObjectURL(audio.url);
    },
    [audio],
  );

  const data = connection.data;
  const ready = Boolean(data?.configured);
  const validDuration =
    data &&
    duration != null &&
    duration >= data.minSeconds &&
    duration <= data.maxSeconds;
  const estimate =
    validDuration && data && duration != null
      ? (Math.ceil(duration * data.priceUsdPerSecond * 100) / 100).toFixed(2)
      : undefined;
  const jobs = data?.jobs || [];
  const result = jobs.find((job) => job.id === selected) || jobs[0];
  const pending = jobs.some(isActive);
  const needsReview = jobs.some((job) => job.status === "uncertain");

  function chooseFile(file: File | undefined, kind: "image" | "audio") {
    if (!file || !data) return;
    const image = kind === "image";
    const extension = `.${file.name.split(".").pop()?.toLowerCase() || ""}`;
    const formats = (image ? imageFiles : audioFiles).split(",");
    const maxBytes = image ? data.maxImageBytes : data.maxAudioBytes;
    setAccepted(false);
    setAuthorized(false);
    if (!image) setDuration(undefined);
    const setFile = image ? setPortrait : setAudio;
    if (!formats.includes(extension) || !file.size || file.size > maxBytes) {
      setFile(undefined);
      setError(
        image
          ? `请选择 ${maxBytes / 1024 / 1024} MB 以内的 JPG、PNG 或 WebP 照片。`
          : `请选择 ${maxBytes / 1024 / 1024} MB 以内的 MP3、WAV、M4A 或 OGG 录音。`,
      );
      return;
    }
    setError("");
    setFile({ file, url: URL.createObjectURL(file) });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !ready ||
      !portrait ||
      !audio ||
      !authorized ||
      !validDuration ||
      accepted ||
      pending ||
      needsReview ||
      postingNow.current
    )
      return;
    const image = portrait.file;
    const recording = audio.file;
    if (
      request.current?.image !== image ||
      request.current?.audio !== recording
    )
      request.current = { image, audio: recording, id: crypto.randomUUID() };
    const form = new FormData();
    form.set("image", image);
    form.set("audio", recording);
    form.set("requestId", request.current.id);
    form.set("authorized", "true");
    const key = queryKey(account);
    postingNow.current = true;
    setPosting(true);
    setError("");
    try {
      const created: LipSyncJob = await studioApi(path, "POST", form);
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<LipSyncConnection>(
        key,
        (previous) =>
          previous && {
            ...previous,
            jobs: [
              created,
              ...previous.jobs.filter((job) => job.id !== created.id),
            ],
          },
      );
      setSelected(created.id);
      setAccepted(true);
    } catch (failure) {
      setError(
        failure instanceof Error &&
          (failure as Error & { status?: number }).status
          ? failure.message
          : "提交未收到确认。请先查看最近任务，再用原素材重试核对。",
      );
    } finally {
      postingNow.current = false;
      setPosting(false);
      void client.invalidateQueries({ queryKey: key });
    }
  }

  return (
    <>
      {connection.isPending && (
        <p className="talk-video-state" role="status">
          正在读取口播服务
        </p>
      )}
      {connection.isError && (
        <Alert
          className="talk-video-notice"
          type="error"
          showIcon
          title={connection.error.message}
          action={
            <Button size="small" onClick={() => void connection.refetch()}>
              重试
            </Button>
          }
        />
      )}
      {data && !ready && (
        <Alert
          className="talk-video-notice"
          type="info"
          showIcon
          title="请管理员在 AIGC 服务设置中配置「原声对口型」。"
          action={
            <Button size="small" onClick={() => void connection.refetch()}>
              重新检查
            </Button>
          }
        />
      )}
      {data && (
        <form
          className="talk-video-composer talk-video-lip-sync"
          onSubmit={submit}
        >
          <div className="talk-video-lip-sync-files">
            <div className="talk-video-lip-sync-file">
              <label htmlFor="talk-video-portrait">
                <PictureOutlined aria-hidden="true" /> 人物照片
              </label>
              <input
                type="file"
                id="talk-video-portrait"
                accept={imageFiles}
                disabled={posting || !ready}
                onChange={(event) =>
                  chooseFile(event.target.files?.[0], "image")
                }
              />
              {portrait && (
                <img
                  className="talk-video-lip-sync-photo"
                  src={portrait.url}
                  alt="所选人物照片"
                />
              )}
            </div>
            <div className="talk-video-lip-sync-file">
              <label htmlFor="talk-video-audio">
                <AudioOutlined aria-hidden="true" /> 原声录音
              </label>
              <input
                type="file"
                id="talk-video-audio"
                accept={audioFiles}
                disabled={posting || !ready}
                onChange={(event) =>
                  chooseFile(event.target.files?.[0], "audio")
                }
              />
              {audio && (
                <audio
                  key={audio.url}
                  aria-label="试听原声"
                  src={audio.url}
                  controls
                  preload="metadata"
                  onLoadedMetadata={(event) =>
                    setDuration(event.currentTarget.duration)
                  }
                  onError={() => setDuration(Number.NaN)}
                />
              )}
            </div>
          </div>
          <p className="talk-video-state talk-video-fee" role="status">
            {data.resolution} · 录音 {data.minSeconds}–{data.maxSeconds} 秒 ·
            每秒 US${data.priceUsdPerSecond.toFixed(2)}
            {estimate ? ` · 预估 US$${estimate}` : ""} · 以 fal 账单为准
          </p>
          {duration != null && !validDuration && (
            <p className="talk-video-error" role="alert">
              {Number.isFinite(duration)
                ? `录音时长 ${duration.toFixed(2)} 秒，请选择 ${data.minSeconds}–${data.maxSeconds} 秒的录音。`
                : "无法读取录音时长，请换用可播放的录音文件。"}
            </p>
          )}
          <div className="talk-video-fields">
            <Checkbox
              checked={authorized}
              disabled={posting || !ready}
              onChange={(event) => setAuthorized(event.target.checked)}
            >
              我已获肖像和声音授权，同意将照片和录音发送到 fal 生成视频。
            </Checkbox>
            <Button
              className="talk-video-submit"
              htmlType="submit"
              type="primary"
              icon={<VideoCameraOutlined />}
              loading={posting}
              disabled={
                !ready ||
                !portrait ||
                !audio ||
                !authorized ||
                !validDuration ||
                accepted ||
                pending ||
                needsReview
              }
            >
              {needsReview
                ? "有结果待核实"
                : accepted
                  ? "已提交"
                  : pending
                    ? "有任务在生成"
                    : "生成视频"}
            </Button>
          </div>
          {error && (
            <p className="talk-video-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
      {result && <LipSyncResult job={result} />}
      {jobs.length > 0 && (
        <details className="talk-video-details talk-video-recent">
          <summary>最近任务</summary>
          <ul className="talk-video-history">
            {jobs.map((job) => (
              <li key={job.id}>
                <Button type="link" onClick={() => setSelected(job.id)}>
                  {new Date(job.createdAt).toLocaleString("zh-CN", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </Button>
                <span>{jobLabels[job.status]}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function LipSyncResult({ job }: { job: LipSyncJob }) {
  const active = isActive(job);
  return (
    <section className="talk-video-result" aria-label="数字人口播任务">
      <div className="talk-video-result-heading">
        <h2>口播视频</h2>
        <div className="talk-video-result-actions">
          <Tag
            color={
              active
                ? "processing"
                : job.status === "failed"
                  ? "error"
                  : job.status === "uncertain"
                    ? "warning"
                    : "success"
            }
          >
            {active && <LoadingOutlined />} {jobLabels[job.status]}
          </Tag>
          {job.output && (
            <Button
              href={assetUrl(job.output, true)}
              icon={<DownloadOutlined />}
            >
              下载 MP4
            </Button>
          )}
        </div>
      </div>
      {(job.message || active) && (
        <p className="talk-video-state" role="status">
          {job.message || "可以离开页面，生成将在后台继续。"}
        </p>
      )}
      {job.output && (
        <div className="talk-video-player talk-video-lip-sync-player">
          <video
            key={job.output}
            aria-label="数字人口播成片"
            controls
            playsInline
            preload="metadata"
            src={assetUrl(job.output)}
          />
        </div>
      )}
    </section>
  );
}
