import { useRef, useState } from "react";
import { Alert, Button, Checkbox, Form, Input } from "antd";
import {
  bailianCommerceVoiceModels,
  type BailianCommerceVoiceModel,
} from "../../../../packages/contracts/src/bailian-commerce-voice";
import { studioApi, type Item } from "./api";

type Diagnostic = {
  action?: string;
  providerStatus?: number;
  providerCode?: string;
  providerRequestId?: string;
};
type ProbeSource = "configured" | "saved";
type Probe = {
  checkedAt: string;
  source: ProbeSource;
  enrollment: {
    status: "reachable" | "unauthorized" | "unavailable";
    diagnostic?: Diagnostic;
    note?: string;
  };
  models: {
    id: BailianCommerceVoiceModel;
    status: "authorized" | "denied" | "unknown";
    diagnostic?: Diagnostic;
    note?: string;
  }[];
};

const modelStatus = {
  authorized: "权限已核对",
  denied: "未授权",
  unknown: "权限待核对",
};
const connectionStatus = {
  reachable: "音色查询接口可访问",
  unauthorized: "音色查询未获授权",
  unavailable: "暂未确认音色接口可访问",
};
const workspaceFormat = /^(?:ws|llm)-[a-zA-Z0-9_-]+$/;

function DiagnosticDetails({ diagnostic }: { diagnostic?: Diagnostic }) {
  if (!diagnostic) return null;
  const values = [
    diagnostic.providerStatus && `HTTP ${diagnostic.providerStatus}`,
    diagnostic.providerCode,
    diagnostic.providerRequestId && `请求编号 ${diagnostic.providerRequestId}`,
  ].filter(Boolean);
  return values.length ? <small>{values.join(" · ")}</small> : null;
}

function ProbeResult({ data }: { data: Probe }) {
  return (
    <Alert
      type={data.enrollment.status === "reachable" ? "success" : "warning"}
      title={connectionStatus[data.enrollment.status]}
      showIcon
      description={
        <div className="aigc-voice-probe">
          <p>
            {data.source === "saved"
              ? "小序已保存的百炼语音连接"
              : "服装口播当前已保存的百炼连接"}
            {" · "}
            {new Date(data.checkedAt).toLocaleString("zh-CN")}
          </p>
          {data.enrollment.note && <p>{data.enrollment.note}</p>}
          <DiagnosticDetails diagnostic={data.enrollment.diagnostic} />
          {data.models?.length > 0 && (
            <ul aria-label="百炼音色模型权限">
              {data.models.map((model) => (
                <li key={model.id}>
                  <span>
                    {bailianCommerceVoiceModels.find(
                      ({ id }) => id === model.id,
                    )?.label || model.id}
                    {" · "}
                    {modelStatus[model.status]}
                  </span>
                  {model.note && <small>{model.note}</small>}
                  <DiagnosticDetails diagnostic={model.diagnostic} />
                </li>
              ))}
            </ul>
          )}
        </div>
      }
    />
  );
}

export function BailianVoiceConnection({
  config,
  disabled,
  onSaved,
}: {
  config: Item;
  disabled: boolean;
  onSaved: (config: Item) => void;
}) {
  const [draftWorkspace, setDraftWorkspace] = useState<string>();
  const [apiKey, setApiKey] = useState("");
  const [reuseVoice, setReuseVoice] = useState(false);
  const [working, setWorking] = useState<"saving" | ProbeSource>();
  const [probe, setProbe] = useState<Probe>();
  const [error, setError] = useState("");
  const pending = useRef(false);
  const voiceIsDedicated = config.bailianVoiceSource === "voice";
  const ready = voiceIsDedicated
    ? Boolean(
        config.bailianVoiceWorkspaceId && config.secrets?.BAILIAN_VOICE_API_KEY,
      )
    : Boolean(
        config.bailianWorkspaceId && config.secrets?.BAILIAN_VIDEO_API_KEY,
      );
  const workspace =
    (reuseVoice
      ? config.bailianReuseWorkspaceId
      : (draftWorkspace ?? config.bailianVoiceWorkspaceId)) || "";
  const changedWorkspace =
    workspace.trim() !== (config.bailianVoiceWorkspaceId || "");
  const dirty = changedWorkspace || Boolean(apiKey.trim() || reuseVoice);
  const canSave =
    dirty &&
    workspaceFormat.test(workspace.trim()) &&
    (reuseVoice ||
      Boolean(apiKey.trim()) ||
      (voiceIsDedicated &&
        !changedWorkspace &&
        config.secrets?.BAILIAN_VOICE_API_KEY));

  async function run(action: "saving" | ProbeSource) {
    if (pending.current || disabled) return;
    pending.current = true;
    setWorking(action);
    setError("");
    setProbe(undefined);
    try {
      if (action === "saving") {
        const updated = await studioApi(
          "/services/bailian-voice-connection",
          "PUT",
          {
            revision: config.revision,
            bailianVoiceWorkspaceId: workspace.trim(),
            ...(reuseVoice
              ? { useSavedQwenVoiceConnection: true }
              : apiKey.trim()
                ? { apiKey: apiKey.trim() }
                : {}),
          },
        );
        setDraftWorkspace(undefined);
        setApiKey("");
        setReuseVoice(false);
        onSaved(updated);
      } else {
        setProbe(
          await studioApi("/services/bailian-voice-check", "POST", {
            source: action,
          }),
        );
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "请求暂未完成，请稍后重试。",
      );
    } finally {
      pending.current = false;
      setWorking(undefined);
    }
  }

  return (
    <>
      <p className="aigc-connection-note">
        北京业务空间 · 用于服装口播的三款复刻模型。
        {ready &&
          (voiceIsDedicated
            ? "当前使用专用音色连接。"
            : "当前沿用已保存的百炼视频连接。")}
      </p>
      {config.bailianReuseAvailable && (
        <div className="aigc-connection-reuse">
          <Checkbox
            checked={reuseVoice}
            disabled={Boolean(working) || disabled}
            onChange={(event) => setReuseVoice(event.target.checked)}
          >
            将小序已保存的百炼语音连接复制到音色设置
          </Checkbox>
          <small>可以先核验小序连接，再保存到服装口播。</small>
        </div>
      )}
      <Form.Item label="百炼音色北京业务空间 ID">
        <Input
          aria-label="百炼音色北京业务空间 ID"
          value={workspace}
          placeholder="ws-… 或 llm-…"
          disabled={Boolean(working) || disabled || reuseVoice}
          onChange={(event) => setDraftWorkspace(event.target.value)}
        />
      </Form.Item>
      {changedWorkspace &&
        voiceIsDedicated &&
        !reuseVoice &&
        !apiKey.trim() && (
          <p className="aigc-connection-note">
            更换业务空间时，请同时填写新空间的 API Key。
          </p>
        )}
      <Form.Item label="百炼音色 API Key">
        <Input.Password
          aria-label="百炼音色 API Key"
          autoComplete="new-password"
          value={apiKey}
          disabled={Boolean(working) || disabled || reuseVoice}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={
            voiceIsDedicated ? "留空保留已保存密钥" : "填写音色专用 API Key"
          }
        />
      </Form.Item>
      <div className="aigc-connection-check">
        <div className="aigc-voice-probe-actions">
          <Button
            type="primary"
            disabled={!canSave || Boolean(working) || disabled}
            loading={working === "saving"}
            onClick={() => void run("saving")}
          >
            保存音色连接
          </Button>
          <Button
            disabled={!ready || Boolean(working) || disabled}
            loading={working === "configured"}
            onClick={() => void run("configured")}
          >
            核验音色连接
          </Button>
          {config.bailianReuseAvailable && (
            <Button
              disabled={Boolean(working) || disabled}
              loading={working === "saved"}
              onClick={() => void run("saved")}
            >
              核验小序语音连接
            </Button>
          )}
        </div>
        <span className="aigc-connection-note">
          核验读取已保存的连接与业务空间权限。此操作无需上传录音，无合成费用。
        </span>
        {error && <Alert type="error" showIcon title={error} />}
        {probe && <ProbeResult data={probe} />}
      </div>
    </>
  );
}
