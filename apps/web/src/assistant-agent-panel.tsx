import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  App,
  Button,
  Checkbox,
  Empty,
  Image,
  Popconfirm,
  Popover,
  Progress,
  Select,
  Space,
  Tag,
  Tooltip,
  Alert,
} from "antd";
import {
  PaperClipOutlined,
  SettingOutlined,
  DownloadOutlined,
  FileOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { api, csrf } from "./api";
import { useUser } from "./shared";
import type {
  AgentCatalog,
  AgentFile,
  AgentJob,
} from "../../../packages/contracts/src/assistant-agent";
import type { AssistantMessage } from "../../../packages/contracts/src/personal-assistant";
import { assistantPublicText } from "../../../packages/contracts/src/ai-presentation";
import { assistantPurposeMenu } from "./assistant-purpose-options";
import { showWorkspaceHologram } from "./workspace-hologram";
import "./assistant-agent.css";

export type AgentOptions = {
  model?: string;
  imageModel?: string;
  webSearch: boolean;
  attachments: AgentFile[];
};
export const agentContentUrl = (id: string) =>
  `/api/v1/my-workspace/assistant/files/${encodeURIComponent(id)}/content`;
const sizeLabel = (size: number) =>
  size < 1048576
    ? `${Math.ceil(size / 1024)} KB`
    : `${(size / 1048576).toFixed(1)} MB`;
export function AgentComposer({
  value,
  change,
  disabled,
  onUploading,
  settingsContent,
  active = true,
}: {
  value: AgentOptions;
  change: (v: AgentOptions) => void;
  disabled: boolean;
  onUploading: (v: boolean) => void;
  settingsContent?: ReactNode;
  active?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null),
    { message } = App.useApp();
  const [uploading, setUploading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (!active) setSettingsOpen(false);
  }, [active]);
  const [preferredPurpose, setPreferredPurpose] = useState<string>();
  const catalog = useQuery({
    queryKey: ["assistant-capabilities"],
    queryFn: async () =>
      (await api("/my-workspace/assistant/capabilities")).data as AgentCatalog,
    staleTime: 600000,
  });
  const purposeMenu = assistantPurposeMenu(
    catalog.data,
    value.model,
    preferredPurpose,
  );
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const chosen = Array.from(files);
    if (chosen.length + value.attachments.length > 6) {
      message.warning("每次最多附加6个文件");
      return;
    }
    setUploading(true);
    onUploading(true);
    const uploaded = [...value.attachments];
    try {
      for (const file of chosen) {
        if (
          file.size >
          (file.type.startsWith("video/") ? 64 : 20) * 1024 * 1024
        )
          throw Error("文档/图片最大20MB，视频最大64MB");
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
        const data = await res.json();
        if (!res.ok) throw Error(data.error?.message || "上传失败");
        uploaded.push(data.data);
        change({ ...value, attachments: [...uploaded] });
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setUploading(false);
      onUploading(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div className="agent-composer">
      <div className="agent-composer-tools">
        <input
          ref={input}
          type="file"
          hidden
          multiple
          accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.csv,.json,.docx,.xlsx,.pptx,.mp4,.mov,.webm"
          onChange={(e) => void upload(e.target.files)}
          aria-label="上传助理附件"
        />
        <Button
          size="small"
          type="text"
          icon={<PaperClipOutlined />}
          aria-label="附件"
          loading={uploading}
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          附件
        </Button>
        <Select
          size="small"
          aria-label="助理能力"
          value={purposeMenu.value}
          placeholder="日常问答"
          disabled={disabled || uploading}
          loading={catalog.isLoading}
          popupMatchSelectWidth={false}
          options={purposeMenu.options}
          onChange={(purpose) => {
            const option = purposeMenu.options.find((o) => o.value === purpose);
            if (!option) return;
            setPreferredPurpose(purpose);
            change({ ...value, model: option.model });
          }}
        />
        <Checkbox
          checked={value.webSearch}
          disabled={disabled || uploading}
          onChange={(e) => change({ ...value, webSearch: e.target.checked })}
        >
          联网
        </Checkbox>
        <Popover
          trigger="click"
          title={settingsContent ? "助理设置" : "创作设置"}
          open={settingsOpen && active}
          onOpenChange={setSettingsOpen}
          content={
            <div
              className={`agent-settings${settingsContent ? " assistant-settings" : ""}`}
              onClick={(event) => {
                if (
                  (event.target as HTMLElement).closest(
                    "[data-settings-action]",
                  )
                )
                  setSettingsOpen(false);
              }}
            >
              {settingsContent}
              <p>图像创作能力</p>
              <Select
                style={{ width: 230 }}
                aria-label="图像创作能力"
                placeholder="使用首个可用图像能力"
                value={value.imageModel}
                disabled={disabled || uploading}
                allowClear
                options={catalog.data?.imageModels?.map((m) => ({
                  value: m.id,
                  label: m.name + (m.reference ? " · 参考图" : ""),
                }))}
                onChange={(imageModel) => change({ ...value, imageModel })}
              />
              <p>仅在提出创作要求时运行。智能服务按实际用量计费。</p>
              <p>附件仅本人可访问；发送时，所附内容会交给智能服务处理。</p>
              {catalog.data?.notice && <p>{catalog.data.notice}</p>}
              <Button
                size="small"
                loading={catalog.isFetching}
                onClick={() => void catalog.refetch()}
              >
                刷新能力列表
              </Button>
            </div>
          }
        >
          <Button
            size="small"
            type="text"
            icon={<SettingOutlined />}
            aria-label={settingsContent ? "助理设置" : "创作设置"}
            disabled={!active || (disabled && !settingsContent)}
          />
        </Popover>
      </div>
      {catalog.error && <small>能力列表加载失败，当前选择保持不变。</small>}
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
