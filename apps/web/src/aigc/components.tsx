import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Collapse,
  Empty,
  Image,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Tag,
  Upload,
} from "antd";
import {
  DeleteOutlined,
  DownloadOutlined,
  FileOutlined,
  UploadOutlined,
  PlayCircleOutlined,
} from "@ant-design/icons";
import { assetUrl, studioApi, stateText, type Item } from "./api";

export function AssetInput({
  label,
  kind,
  projectId,
  files,
  onChange,
  maximum = 20,
  single = false,
  disabled = false,
}: {
  label: string;
  kind: string;
  projectId?: string;
  files: Item[];
  onChange: (files: Item[]) => void;
  maximum?: number;
  single?: boolean;
  disabled?: boolean;
}) {
  const { message } = App.useApp();
  const [uploading, setUploading] = useState(false);
  const accept = ["video", "referenceVideo"].includes(kind)
    ? ".mp4,.webm,.mov"
    : kind === "referenceAudio"
      ? ".mp3,.wav,.m4a"
      : ["template", "text"].includes(kind)
        ? ".txt,.json,.md,.csv"
        : ".jpg,.jpeg,.png,.webp";
  return (
    <div className="aigc-asset-input">
      <div className="aigc-field-label">{label}</div>
      <div className="aigc-assets">
        {files.map((file, index) => (
          <div key={file.path} className="aigc-asset">
            <a href={assetUrl(file.path)} target="_blank" rel="noreferrer">
              {file.mime?.startsWith("image/") ? (
                <img src={`${assetUrl(file.path)}?preview=1`} alt={file.name} />
              ) : (
                <FileOutlined />
              )}
              <span>{file.name}</span>
            </a>
            <Button
              type="text"
              size="small"
              aria-label={`移除 ${file.name}`}
              disabled={disabled || uploading}
              icon={<DeleteOutlined />}
              onClick={() => onChange(files.filter((_, i) => i !== index))}
            />
          </div>
        ))}
      </div>
      <Upload
        accept={accept}
        showUploadList={false}
        disabled={disabled || uploading}
        beforeUpload={async (file) => {
          if (file.size > maximum * 1024 * 1024) {
            message.error(`文件须小于 ${maximum} MB`);
            return false;
          }
          setUploading(true);
          try {
            const form = new FormData();
            form.set("file", file);
            form.set("kind", kind);
            if (projectId) form.set("projectId", projectId);
            const uploaded = await studioApi("/assets", "POST", form);
            onChange(single ? [uploaded] : [...files, uploaded]);
          } catch (e: any) {
            message.error(e.message);
          } finally {
            setUploading(false);
          }
          return false;
        }}
      >
        <Button
          icon={<UploadOutlined />}
          loading={uploading}
          disabled={disabled}
        >
          {files.length && single ? "替换素材" : "上传素材"}
        </Button>
      </Upload>
      <small>
        支持 {accept.replaceAll(".", "")} · 单个文件最多 {maximum} MB
      </small>
    </div>
  );
}
export function Media({
  file,
  compact = false,
}: {
  file?: Item;
  compact?: boolean;
}) {
  if (!file?.path)
    return (
      <div className="aigc-media-empty">
        <PlayCircleOutlined />
      </div>
    );
  return file.mime?.startsWith("image/") ||
    /\.(png|jpg|jpeg|webp)$/i.test(file.name || "") ? (
    <Image
      src={assetUrl(file.path)}
      alt={file.name || "生成图片"}
      className={compact ? "aigc-cover" : "aigc-result-image"}
    />
  ) : /video|\.mp4|\.webm/i.test(`${file.mime} ${file.name}`) ? (
    <video
      controls={!compact}
      preload="metadata"
      src={assetUrl(file.path)}
      className={compact ? "aigc-cover" : "aigc-result-video"}
    />
  ) : (
    <a href={assetUrl(file.path, true)}>
      <DownloadOutlined /> {file.name}
    </a>
  );
}
export function TaskList({
  tasks,
  reload,
}: {
  tasks: Item[];
  reload: () => void;
}) {
  const { message, modal } = App.useApp();
  const [busy, setBusy] = useState("");
  const [review, setReview] = useState<Item>();
  const [fidelity, setFidelity] = useState<Item>();
  const action = async (id: string, name: string) => {
    setBusy(id);
    try {
      await studioApi(`/tasks/${id}/control`, "POST", {
        action: name,
        acknowledged: true,
      });
      reload();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="aigc-task-list">
      {!tasks.length ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无生成任务"
        />
      ) : (
        tasks.map((task) => (
          <section key={task.id} className="aigc-task">
            <div className="aigc-row">
              <strong>{task.title || task.name}</strong>
              <Tag
                color={
                  task.stage === "failed"
                    ? "error"
                    : task.stage === "completed"
                      ? "success"
                      : "processing"
                }
              >
                {stateText[task.stage || task.status] ||
                  task.stage ||
                  task.status}
              </Tag>
            </div>
            <p>{task.currentItem}</p>
            <Progress
              percent={Math.max(0, Math.min(100, task.progress || 0))}
              size="small"
              status={task.stage === "failed" ? "exception" : undefined}
            />
            {task.error && <Alert type="warning" showIcon title={task.error} />}
            <Space wrap>
              {!["completed", "failed", "paused", "attention"].includes(
                task.stage,
              ) && (
                <Button
                  size="small"
                  loading={busy === task.id}
                  onClick={() => action(task.id, "pause")}
                >
                  暂停
                </Button>
              )}
              {["paused", "attention"].includes(task.stage) && (
                <Button
                  size="small"
                  loading={busy === task.id}
                  onClick={() =>
                    modal.confirm({
                      title: "继续此任务？",
                      content:
                        "系统会检查原请求状态；结果不确定的请求需要先核实。",
                      onOk: () => action(task.id, "resume"),
                    })
                  }
                >
                  继续
                </Button>
              )}
              {task.type === "generate" && (
                <Button
                  size="small"
                  onClick={async () => {
                    try {
                      setFidelity({
                        ...(await studioApi(`/tasks/${task.id}/fidelity`)),
                        taskId: task.id,
                        projectId: task.projectId,
                      });
                    } catch (e: any) {
                      message.error(e.message);
                    }
                  }}
                >
                  智能核对
                </Button>
              )}
              {task.type === "generate" && (
                <Button
                  size="small"
                  onClick={async () => {
                    try {
                      const data = await studioApi(
                        `/tasks/${task.id}/keyframes`,
                      );
                      if (!data) return message.info("当前任务无需确认关键帧");
                      setReview({ ...data, taskId: task.id });
                    } catch (e: any) {
                      message.error(e.message);
                    }
                  }}
                >
                  关键帧
                </Button>
              )}
              {(task.outputFiles || []).map((file: Item) => (
                <a key={file.path} href={assetUrl(file.path, true)}>
                  <DownloadOutlined /> {file.name}
                </a>
              ))}
            </Space>
            {!!task.logs?.length && (
              <Collapse
                size="small"
                ghost
                items={[
                  {
                    key: "logs",
                    label: "查看执行记录",
                    children: (
                      <div className="aigc-task-logs">
                        {task.logs.slice(-30).map((log: Item, i: number) => (
                          <div key={i}>
                            <time>{new Date(log.at).toLocaleTimeString()}</time>{" "}
                            {log.message}
                          </div>
                        ))}
                      </div>
                    ),
                  },
                ]}
              />
            )}
          </section>
        ))
      )}
      <Modal
        title="关键帧核对"
        open={Boolean(review)}
        footer={null}
        width={880}
        onCancel={() => setReview(undefined)}
        destroyOnHidden
      >
        {review && (
          <Keyframes review={review} onUpdate={setReview} reload={reload} />
        )}
      </Modal>
      <Modal
        title="智能核对"
        open={Boolean(fidelity)}
        footer={null}
        width={880}
        onCancel={() => setFidelity(undefined)}
        destroyOnHidden
      >
        {fidelity && (
          <FidelityPanel
            value={fidelity}
            onUpdate={setFidelity}
            reload={reload}
          />
        )}
      </Modal>
    </div>
  );
}
function Keyframes({
  review,
  onUpdate,
  reload,
}: {
  review: Item;
  onUpdate: (value: Item) => void;
  reload: () => void;
}) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const [correction, setCorrection] = useState("");
  const act = async (action: string, frame?: Item, modelId?: string) => {
    setBusy(true);
    try {
      await studioApi(`/tasks/${review.taskId}/keyframes`, "POST", {
        action,
        unitId: frame?.unitId,
        revision: frame?.revision,
        truthRevision: review.truthRevision,
        correction,
        modelId,
        imageModelId: review.imageService?.model,
      });
      const next = await studioApi(`/tasks/${review.taskId}/keyframes`);
      onUpdate({ ...next, taskId: review.taskId });
      reload();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Alert
        type="info"
        title="人物、商品与关键帧须通过视觉扫描，才会继续视频生成"
      />
      <Select
        aria-label="关键帧图像模型"
        style={{ minWidth: 260 }}
        value={review.imageService?.model}
        disabled={busy || review.locked}
        onChange={(id) => void act("select-model", undefined, id)}
        options={(review.imageModels || []).map((m: Item) => ({
          value: m.id,
          label: `${m.label}${m.configured ? "" : "（未配置）"}`,
        }))}
      />
      <Button
        onClick={async () => {
          try {
            const next = await studioApi(`/tasks/${review.taskId}/keyframes`);
            onUpdate({ ...next, taskId: review.taskId });
          } catch (e: any) {
            message.error(e.message);
          }
        }}
      >
        刷新关键帧
      </Button>
      {(review.frames || []).map((frame: Item) => (
        <div key={frame.unitId} className="aigc-task">
          <strong>{frame.unitId}</strong>
          {frame.asset && <Media file={frame.asset} />}
          <p>{frame.error || frame.status}</p>
          <Space>
            <Button
              loading={busy}
              disabled={
                review.locked ||
                frame.pending ||
                !review.imageService?.configured
              }
              onClick={() =>
                act(frame.asset ? "regenerate" : "generate", frame)
              }
            >
              {frame.asset ? "重新生成" : "生成关键帧"}
            </Button>
            <Upload
              accept=".png,.jpg,.jpeg,.webp"
              showUploadList={false}
              beforeUpload={async (file) => {
                const form = new FormData();
                form.set("file", file);
                form.set("unitId", frame.unitId);
                form.set("revision", frame.revision);
                try {
                  await studioApi(
                    `/tasks/${review.taskId}/keyframes/upload`,
                    "POST",
                    form,
                  );
                  const next = await studioApi(
                    `/tasks/${review.taskId}/keyframes`,
                  );
                  onUpdate({ ...next, taskId: review.taskId });
                } catch (e: any) {
                  message.error(e.message);
                }
                return false;
              }}
            >
              <Button disabled={review.locked || frame.pending}>
                上传已有首帧
              </Button>
            </Upload>
          </Space>
        </div>
      ))}
      <Input.TextArea
        placeholder="需要修正的细节"
        value={correction}
        onChange={(e) => setCorrection(e.target.value)}
      />
      <Button
        type="primary"
        loading={busy}
        disabled={review.locked}
        onClick={() => act("release")}
      >
        扫描通过后继续
      </Button>
    </Space>
  );
}

function FidelityPanel({
  value,
  onUpdate,
  reload,
}: {
  value: Item;
  onUpdate: (value: Item) => void;
  reload: () => void;
}) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const next = await studioApi(`/tasks/${value.taskId}/fidelity`);
    onUpdate({ ...next, taskId: value.taskId, projectId: value.projectId });
    reload();
  };
  const act = async (action: string, input: Item = {}) => {
    setBusy(true);
    try {
      await studioApi(`/tasks/${value.taskId}/fidelity`, "POST", {
        action,
        ...input,
      });
      await refresh();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const choice = value.automatic?.viewChoice;
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Space>
        <Button
          loading={busy}
          disabled={!value.canStartAutomatic}
          onClick={() => act("auto")}
        >
          运行视觉核对
        </Button>
        <Button
          onClick={() => refresh().catch((e) => message.error(e.message))}
        >
          刷新结果
        </Button>
      </Space>
      {(value.references || []).map((r: Item) => (
        <div key={r.file.path}>
          <span>{r.label}</span>
          <Media compact file={r.file} />
        </div>
      ))}
      {(value.automatic?.records || []).map((r: Item, i: number) => (
        <div className="aigc-task" key={r.key || i}>
          <Tag>{stateText[r.status] || r.status}</Tag>
          <strong>
            {r.target?.kind === "source"
              ? "来源素材"
              : r.target?.unitId || "画面核对"}
          </strong>
          {r.error && <p>{r.error}</p>}
          {(r.issues || []).map((issue: Item, i: number) => (
            <p key={i}>{issue.message}</p>
          ))}
        </div>
      ))}
      {choice &&
        [
          ...new Set<string>(
            (choice.gaps || []).map((g: Item) => g.product_id),
          ),
        ].map((productId) => (
          <section className="aigc-task" key={productId}>
            <h4>补充商品背面依据</h4>
            <p>
              当前镜头需要尚未提供的视角，可补图，或将对应镜头改为轻微侧角度。
            </p>
            <Space>
              <Upload
                accept=".png,.jpg,.jpeg,.webp"
                showUploadList={false}
                beforeUpload={async (file) => {
                  const form = new FormData();
                  form.set("file", file);
                  form.set("kind", "product");
                  form.set("projectId", value.projectId);
                  try {
                    const asset = await studioApi("/assets", "POST", form);
                    await act("view-choice", {
                      key: choice.key,
                      productId,
                      choice: "supplement",
                      assetPath: asset.path,
                    });
                  } catch (e: any) {
                    message.error(e.message);
                  }
                  return false;
                }}
              >
                <Button disabled={busy}>上传补充图片</Button>
              </Upload>
              <Button
                loading={busy}
                onClick={() =>
                  act("view-choice", {
                    key: choice.key,
                    productId,
                    choice: "slight-side",
                  })
                }
              >
                改为轻微侧角度
              </Button>
            </Space>
          </section>
        ))}
      {!value.automatic?.records?.length && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无视觉核对结果"
        />
      )}
    </Space>
  );
}
