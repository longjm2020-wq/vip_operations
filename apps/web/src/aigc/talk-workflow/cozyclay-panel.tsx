import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Modal,
  Select,
  Space,
  Tag,
} from "antd";
import {
  DownloadOutlined,
  ExpandOutlined,
  SendOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { studioApi } from "../api";
import type { WorkflowView } from "./types";

const basePath = "/commerce-video/workflows";

/**
 * CozyClay 三维预演联动面板：
 * - 一键导出标准 v5 .cclayproject 工程草稿
 * - 内嵌独立部署的 CozyClay Web 地址（支持弹窗全屏 + postMessage 推送工程草稿）
 * - 导入回传的 .cclayproject 工程、灰模视频及首尾帧并绑定至对应分镜
 */
export function CozyClayPrevisPanel({
  workflow,
  cozyclayBaseUrl,
  disabled,
  onUpdated,
  onSkip,
  onStartProduce,
}: {
  workflow: WorkflowView;
  cozyclayBaseUrl: string;
  disabled: boolean;
  onUpdated: (wf: WorkflowView) => void;
  onSkip: () => void;
  onStartProduce: () => void;
}) {
  const { message } = App.useApp();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [uploading, setUploading] = useState("");
  const [authorized, setAuthorized] = useState(
    Boolean(workflow.cozyclayState?.authorized),
  );

  const safeOrigin = (() => {
    try {
      return cozyclayBaseUrl ? new URL(cozyclayBaseUrl).origin : "";
    } catch {
      return "";
    }
  })();

  // 监听来自内嵌 CozyClay iframe 的工程导出回传消息
  useEffect(() => {
    if (!safeOrigin) return;
    const onMessage = async (event: MessageEvent) => {
      if (event.origin !== safeOrigin) return;
      const data = event.data as Record<string, any> | undefined;
      if (!data || data.type !== "COZYCLAY_EXPORT_PROJECT" || !data.project) return;
      try {
        const blob = new Blob([JSON.stringify(data.project, null, 2)], {
          type: "application/json",
        });
        const form = new FormData();
        form.set("slot", "cozyclayProject");
        form.set("file", blob, "cozyclay-previs.cclayproject");
        const res = await studioApi(
          `${basePath}/${encodeURIComponent(workflow.id)}/assets`,
          "POST",
          form,
        );
        onUpdated(res.workflow);
        message.success("已接收 CozyClay 回传的预演工程");
      } catch (err) {
        message.error((err as Error).message || "接收 CozyClay 工程失败");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [safeOrigin, workflow.id, onUpdated, message]);

  const exportProject = async (pushToIframe: boolean) => {
    setExporting(true);
    try {
      const project = await studioApi(
        `${basePath}/${encodeURIComponent(workflow.id)}/cozyclay/export`,
        "GET",
      );
      if (pushToIframe && iframeRef.current?.contentWindow && safeOrigin) {
        iframeRef.current.contentWindow.postMessage(
          { type: "XUTI_LOAD_COZYCLAY_PROJECT", project },
          safeOrigin,
        );
        message.success("已将分镜预演工程推送至内嵌 CozyClay");
      } else {
        const blob = new Blob([JSON.stringify(project, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `xuti-previs-${workflow.id.slice(0, 8)}.cclayproject`;
        a.click();
        URL.revokeObjectURL(url);
        message.success("已导出 CozyClay v5 工程文件");
      }
    } catch (err) {
      message.error((err as Error).message || "导出 CozyClay 工程失败");
    } finally {
      setExporting(false);
    }
  };

  const uploadFile = async (
    slot: "cozyclayProject" | "greybox" | "firstFrame" | "lastFrame",
    file: File,
    shotId?: string,
  ) => {
    setUploading(`${slot}:${shotId || ""}`);
    try {
      const form = new FormData();
      form.set("slot", slot);
      if (shotId) form.set("shotId", shotId);
      form.set("file", file);
      const res = await studioApi(
        `${basePath}/${encodeURIComponent(workflow.id)}/assets`,
        "POST",
        form,
        { readTimeoutMs: 90_000 },
      );
      onUpdated(res.workflow);
      message.success("预演素材已导入并绑定");
    } catch (err) {
      message.error((err as Error).message || "上传预演素材失败");
    } finally {
      setUploading("");
    }
  };

  const bindCozyClayShot = async (shotId: string, cozyclayShotId: string) => {
    try {
      const nextShots = workflow.shots.map((s) =>
        s.id === shotId ? { ...s, cozyclayShotId } : s,
      );
      const updated = await studioApi(
        `${basePath}/${encodeURIComponent(workflow.id)}`,
        "PATCH",
        { shots: nextShots },
      );
      onUpdated(updated);
    } catch (err) {
      message.error((err as Error).message || "绑定镜头失败");
    }
  };

  const importedShots = workflow.cozyclayState?.importedShots || [];

  const renderIframe = (height: string) =>
    cozyclayBaseUrl ? (
      <div className="wf-cozyclay-frame-wrap">
        <iframe
          ref={iframeRef}
          title="CozyClay 三维预演工作台"
          src={cozyclayBaseUrl}
          style={{ width: "100%", height, border: "1px solid var(--app-border)", borderRadius: 8 }}
          allow="clipboard-read; clipboard-write"
        />
      </div>
    ) : (
      <Alert
        type="info"
        showIcon
        title="尚未配置独立部署的 CozyClay Web 地址"
        description="管理员可在「AIGC 创作空间 → 服务设置 → CozyClay 三维预演」填写独立部署地址（支持 HTTPS 或本机 npx cozyclay 地址）；未配置时仍可一键导出 .cclayproject 在本地预演后回传灰模视频。"
      />
    );

  return (
    <div className="wf-panel">
      <div className="wf-panel-head">
        <div>
          <h3>CozyClay 三维预演（AI 视频生成前机位与走位控制）</h3>
          <p className="wf-muted">
            先将当前分镜脚本导出为 CozyClay v5 工程，在三维舞台调整人物走位、机位与道具交接，再回传灰模视频与首尾帧绑定至对应分镜。
          </p>
        </div>
        <Space wrap>
          <Button
            icon={<DownloadOutlined />}
            loading={exporting}
            disabled={disabled}
            onClick={() => void exportProject(false)}
          >
            导出 .cclayproject 工程
          </Button>
          {cozyclayBaseUrl && (
            <>
              <Button
                icon={<SendOutlined />}
                loading={exporting}
                disabled={disabled}
                onClick={() => void exportProject(true)}
              >
                推送工程到内嵌 CozyClay
              </Button>
              <Button
                icon={<ExpandOutlined />}
                onClick={() => setFullscreen(true)}
              >
                全屏预演
              </Button>
            </>
          )}
        </Space>
      </div>

      {renderIframe("460px")}

      <div className="wf-cozyclay-upload-bar">
        <label className="wf-file-btn">
          <UploadOutlined /> 导入预演后的 .cclayproject
          <input
            type="file"
            accept=".cclayproject,.json"
            disabled={disabled || Boolean(uploading)}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void uploadFile("cozyclayProject", f);
            }}
          />
        </label>
        {workflow.cozyclayState?.importedProjectName && (
          <Tag color="success">
            已导入工程：{workflow.cozyclayState.importedProjectName}（
            {importedShots.length} 镜）
          </Tag>
        )}
      </div>

      <div className="wf-shot-binding-list">
        {workflow.shots.map((shot) => (
          <div key={shot.id} className="wf-shot-binding-row">
            <div className="wf-shot-binding-meta">
              <strong>
                {shot.id} · {shot.title || "未命名分镜"}
              </strong>
              <span className="wf-muted">{shot.camera || shot.action}</span>
            </div>
            <Space wrap>
              {importedShots.length > 0 && (
                <Select
                  size="small"
                  style={{ width: 200 }}
                  placeholder="绑定 CozyClay 镜头"
                  value={shot.cozyclayShotId}
                  disabled={disabled}
                  options={importedShots.map((item) => ({
                    value: item.id,
                    label: `${item.name} (${item.startFrame}-${item.endFrame}帧)`,
                  }))}
                  onChange={(val) => void bindCozyClayShot(shot.id, val)}
                />
              )}
              <label className="wf-file-btn wf-file-btn-sm">
                上传灰模视频
                <input
                  type="file"
                  accept=".mp4,.mov"
                  disabled={disabled || Boolean(uploading)}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void uploadFile("greybox", f, shot.id);
                  }}
                />
              </label>
              {shot.greyboxAssetId && <Tag color="blue">已绑灰模</Tag>}
              <label className="wf-file-btn wf-file-btn-sm">
                首帧
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={disabled || Boolean(uploading)}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void uploadFile("firstFrame", f, shot.id);
                  }}
                />
              </label>
              {shot.firstFrameAssetId && <Tag color="cyan">已绑首帧</Tag>}
            </Space>
          </div>
        ))}
      </div>

      <div className="wf-footer-bar">
        <Checkbox
          checked={authorized}
          onChange={async (e) => {
            const val = e.target.checked;
            setAuthorized(val);
            try {
              const updated = await studioApi(
                `${basePath}/${encodeURIComponent(workflow.id)}`,
                "PATCH",
                { cozyclayState: { authorized: val } },
              );
              onUpdated(updated);
            } catch {
              // 忽略授权状态保存失败
            }
          }}
        >
          我已确认预演灰模与角色/商品素材的合法使用授权
        </Checkbox>
        <Space>
          <Button disabled={disabled} onClick={onSkip}>
            跳过预演，直接生成
          </Button>
          <Button type="primary" disabled={disabled} onClick={onStartProduce}>
            确认预演并开始生产分镜
          </Button>
        </Space>
      </div>

      <Modal
        open={fullscreen}
        title="CozyClay 三维预演全屏工作台"
        width="94vw"
        footer={null}
        onCancel={() => setFullscreen(false)}
      >
        {renderIframe("76vh")}
      </Modal>
    </div>
  );
}
