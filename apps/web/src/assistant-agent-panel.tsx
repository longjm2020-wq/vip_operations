import {
  useCallback,
  useContext,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
} from "react";
import {
  App,
  Button,
  Empty,
  Image,
  Popconfirm,
  Progress,
  Space,
  Tag,
  Tooltip,
  Alert,
} from "antd";
import {
  PlusOutlined,
  DownloadOutlined,
  EyeOutlined,
  FileOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { api, csrf } from "./api";
import { useUser } from "./shared";
import type {
  AgentFile,
  AgentJob,
} from "../../../packages/contracts/src/assistant-agent";
import type { AssistantMessage } from "../../../packages/contracts/src/personal-assistant";
import { assistantPublicText } from "../../../packages/contracts/src/ai-presentation";
import { AssistantHubContext } from "./assistant-hub-context";
import { canPreviewAgentArtifact } from "./assistant-artifact-document";
import { showWorkspaceHologram } from "./workspace-hologram";
import "./assistant-agent.css";

export type AgentOptions = {
  attachments: AgentFile[];
};
export const agentContentUrl = (id: string) =>
  `/api/v1/my-workspace/assistant/files/${encodeURIComponent(id)}/content`;
const MiB = 1024 * 1024;
const sizeLabel = (size: number) =>
  size < MiB
    ? `${Math.ceil(size / 1024)} KB`
    : `${(size / MiB).toFixed(1)} MB`;

/** 按素材类型计算目标存储上限与允许自动压缩的原始上传上限。 */
function uploadLimits(file: File): {
  target: number;
  raw: number;
  overflowMessage: string;
} {
  const lower = file.name.toLowerCase();
  const isVideo =
    file.type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(lower);
  if (isVideo) {
    return {
      target: 64 * MiB,
      raw: 200 * MiB,
      overflowMessage: "单个原视频最大支持200MB（超过64MB将自动压缩）",
    };
  }
  const isImage =
    file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(lower);
  if (isImage) {
    return {
      target: 20 * MiB,
      raw: 100 * MiB,
      overflowMessage: "单张原图最大支持100MB（超过20MB将自动无损优先压缩）",
    };
  }
  const isOffice = /\.(docx|xlsx|pptx)$/i.test(lower);
  if (isOffice) {
    return {
      target: 20 * MiB,
      raw: 60 * MiB,
      overflowMessage: "Office 文档原文件最大支持60MB（超过20MB将自动无损压缩）",
    };
  }
  return {
    target: 20 * MiB,
    raw: 20 * MiB,
    overflowMessage: "该类型文档最大支持20MB",
  };
}

export function useAgentAttachmentUpload(
  value: AgentOptions,
  change: (v: AgentOptions) => void,
) {
  const { message } = App.useApp();
  const inFlight = useRef(false);
  const [uploading, setUploading] = useState(false);
  const upload = async (chosen: File[]) => {
    if (!chosen.length || inFlight.current) return;
    if (chosen.length + value.attachments.length > 6) {
      message.warning("每次最多附加6个文件");
      return;
    }
    inFlight.current = true;
    setUploading(true);
    const uploaded = [...value.attachments];
    const progressKey = "agent-file-upload-compress";
    try {
      for (const file of chosen) {
        const limits = uploadLimits(file);
        if (file.size > limits.raw) throw Error(limits.overflowMessage);
        const willCompress = file.size > limits.target;
        if (willCompress) {
          message.loading({
            key: progressKey,
            content: `正在上传并无损优先压缩 ${file.name}（${sizeLabel(file.size)}）…`,
            duration: 0,
          });
        }
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/v1/my-workspace/assistant/files", {
          method: "POST",
          credentials: "include",
          headers: {
            "X-CSRF-Token": csrf,
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: form,
        });
        const text = await res.text();
        let data: { data?: AgentFile; error?: { message?: string } } = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = {};
        }
        if (willCompress) message.destroy(progressKey);
        if (!res.ok || !data.data)
          throw Error(data.error?.message || `上传失败（HTTP ${res.status}）`);
        uploaded.push(data.data);
        change({ ...value, attachments: [...uploaded] });
        if (willCompress && data.data.size < file.size) {
          message.success(
            `${data.data.name} 已自动压缩并上传（${sizeLabel(file.size)} → ${sizeLabel(data.data.size)}）`,
          );
        }
      }
    } catch (e) {
      message.destroy(progressKey);
      message.error((e as Error).message);
    } finally {
      inFlight.current = false;
      setUploading(false);
    }
  };
  const paste = (event: ClipboardEvent<HTMLElement>) => {
    const { files, items } = event.clipboardData;
    const chosen = files.length
      ? Array.from(files)
      : Array.from(items)
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
    if (!chosen.length) return;
    event.preventDefault();
    void upload(chosen);
  };
  return { uploading, upload, paste };
}

export function AgentComposer({
  value,
  change,
  disabled,
  uploads,
  targetPicker,
  actions,
}: {
  value: AgentOptions;
  change: (v: AgentOptions) => void;
  disabled: boolean;
  uploads: ReturnType<typeof useAgentAttachmentUpload>;
  targetPicker?: ReactNode;
  actions?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const { uploading, upload } = uploads;
  return (
    <div className="agent-composer">
      <div className="agent-composer-tools">
        <div className="agent-composer-leading">
          <input
            ref={input}
            type="file"
            hidden
            multiple
            accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.csv,.json,.docx,.xlsx,.pptx,.mp4,.mov,.webm"
            onChange={(e) => {
              const chosen = Array.from(e.currentTarget.files || []);
              e.currentTarget.value = "";
              if (!disabled) void upload(chosen);
            }}
            aria-label="上传助理附件"
          />
          <Button
            size="small"
            type="text"
            shape="circle"
            icon={<PlusOutlined />}
            title="添加附件"
            aria-label="附件"
            loading={uploading}
            disabled={disabled || uploading}
            onClick={() => input.current?.click()}
          />
          {targetPicker}
        </div>
        <div className="agent-composer-trailing">{actions}</div>
      </div>
      {!!value.attachments.length && (
        <div className="agent-attachments">
          {value.attachments.map((file) => (
            <Tooltip
              key={file.id}
              title={`${file.name} · ${sizeLabel(file.size)} ${file.note || ""}`}
            >
              <Tag
                closable={!disabled && !uploading}
                onClose={() =>
                  change({
                    ...value,
                    attachments: value.attachments.filter(
                      (f) => f.id !== file.id,
                    ),
                  })
                }
              >
                <FileOutlined /> {file.name}
              </Tag>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
}
export function AgentFileLink({
  file,
  preview = false,
}: {
  file: AgentFile;
  preview?: boolean;
}) {
  const navigate = useNavigate(),
    location = useLocation();
  const openPreview = useContext(AssistantHubContext)?.previewArtifact;
  const previewVideo = useRef<HTMLVideoElement | null>(null);
  const attachPreview = useCallback((element: HTMLVideoElement | null) => {
    if (previewVideo.current && previewVideo.current !== element)
      previewVideo.current.pause();
    previewVideo.current = element;
  }, []);
  const url = agentContentUrl(file.id);
  return (
    <div className="agent-file-result">
      {preview && file.mime.startsWith("image/") && (
        <Image src={url} alt={file.name} className="agent-result-image" />
      )}
      {preview && file.mime.startsWith("video/") && (
        <video
          ref={attachPreview}
          src={url}
          controls
          preload="metadata"
          playsInline
          aria-label={file.name}
        />
      )}
      <a href={url} download={file.name}>
        <DownloadOutlined /> {file.name} <small>{sizeLabel(file.size)}</small>
      </a>
      {openPreview && canPreviewAgentArtifact(file) && (
        <Button
          size="small"
          type="text"
          icon={<EyeOutlined />}
          aria-label={"预览 " + file.name}
          onClick={() => openPreview(file)}
        >
          预览
        </Button>
      )}
      {(file.mime.startsWith("image/") || file.mime.startsWith("video/")) && (
        <Button
          size="small"
          type="text"
          onClick={() => {
            previewVideo.current?.pause();
            showWorkspaceHologram(file);
            if (location.pathname !== "/my-workspace")
              navigate("/my-workspace");
          }}
        >
          在全息屏展示
        </Button>
      )}
      {file.note && <small>{file.note}</small>}
    </div>
  );
}
export function AgentJobCard({
  job,
  refresh,
}: {
  job: AgentJob;
  refresh?: () => void;
}) {
  const { message } = App.useApp();
  const active = job.status === "QUEUED" || job.status === "RUNNING";
  return (
    <section className="agent-job" aria-label={`任务：${job.title}`}>
      <div className="agent-job-heading">
        <strong>{job.title}</strong>
        <Tag
          color={
            job.status === "DONE"
              ? "success"
              : job.status === "FAILED"
                ? "error"
                : "processing"
          }
        >
          {job.stage}
        </Tag>
      </div>
      {active && (
        <Progress percent={job.progress} size="small" status="active" />
      )}
      {job.error && <Alert type="error" showIcon title={job.error} />}
      {job.status === "QUEUED" && refresh && (
        <Button
          size="small"
          type="text"
          onClick={async () => {
            try {
              await api(
                `/my-workspace/assistant/jobs/${job.id}/cancel`,
                "POST",
                {},
              );
              refresh();
            } catch (e) {
              message.error((e as Error).message);
            }
          }}
        >
          取消排队
        </Button>
      )}
      {job.files.map((file) => (
        <AgentFileLink key={file.id} file={file} preview />
      ))}
      {job.status === "DONE" && !job.files.length && (
        <small>结果文件已删除。</small>
      )}
    </section>
  );
}
export function AgentMessageResults({
  item,
  jobs,
}: {
  item: AssistantMessage;
  jobs: AgentJob[];
}) {
  return (
    <div className="agent-message-results">
      {item.attachments?.map((file) => (
        <AgentFileLink key={file.id} file={file} />
      ))}
      {jobs
        .filter((j) => item.jobIds?.includes(j.id))
        .map((job) => (
          <AgentJobCard key={job.id} job={job} />
        ))}
      {!!item.citations?.length && (
        <div className="agent-citations">
          <small>参考来源</small>
          {item.citations.map((c) => (
            <a
              key={c.url}
              href={/^https?:\/\//i.test(c.url) ? c.url : undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              {assistantPublicText(c.title)}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
export function AgentTasksPanel({
  jobs,
  refresh,
  onAttach,
}: {
  jobs: AgentJob[];
  refresh: () => void;
  onAttach: (file: AgentFile) => void;
}) {
  const { message } = App.useApp();
  const user = useUser();
  const files = useQuery({
    queryKey: ["assistant-files", user.id],
    queryFn: async () =>
      (await api("/my-workspace/assistant/files")).data as AgentFile[],
    staleTime: 0,
  });
  return (
    <div className="agent-tasks">
      <div className="agent-job-heading">
        <strong>创作任务</strong>
        <Button
          size="small"
          onClick={() => {
            refresh();
            void files.refetch();
          }}
        >
          刷新
        </Button>
      </div>
      {!jobs.length && (
        <Empty
          description="上传素材，告诉小序要做什么"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      )}
      {jobs.map((job) => (
        <AgentJobCard key={job.id} job={job} refresh={refresh} />
      ))}
      <h3>我的文件</h3>
      <small>最近100个文件，仅自己可见。删除文件不影响业务资料。</small>
      {files.error && <Alert type="error" title={files.error.message} />}
      {files.data?.map((file) => (
        <div className="agent-library-file" key={file.id}>
          <AgentFileLink file={file} />
          <Space>
            <Button size="small" onClick={() => onAttach(file)}>
              附加到对话
            </Button>
            <Popconfirm
              title="删除这个助理文件？"
              description="删除后无法再下载，业务资料不受影响。"
              onConfirm={async () => {
                try {
                  await api(
                    `/my-workspace/assistant/files/${file.id}/delete`,
                    "POST",
                    {},
                  );
                  await files.refetch();
                  refresh();
                } catch (e) {
                  message.error((e as Error).message);
                }
              }}
            >
              <Button
                size="small"
                type="text"
                icon={<DeleteOutlined />}
                aria-label={`删除文件 ${file.name}`}
              />
            </Popconfirm>
          </Space>
        </div>
      ))}
    </div>
  );
}
