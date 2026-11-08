import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Input,
  Space,
  Switch,
  Typography,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import type { BailianChatStatus } from "../../../packages/contracts/src/bailian-chat";
import { api } from "./api";
import { QueryState } from "./shared";

export function BailianChatSettings({ saved }: { saved: () => void }) {
  const q = useQuery({
    queryKey: ["bailian-chat-settings"],
    queryFn: async () =>
      (await api("/ai-model-management/bailian-chat"))
        .data as BailianChatStatus,
  });
  return (
    <>
      <QueryState error={q.error} reload={() => q.refetch()} />
      {q.data && (
        <Connection
          key={q.data.version + ":" + q.data.verifiedAt}
          value={q.data}
          saved={async () => {
            await q.refetch();
            saved();
          }}
        />
      )}
    </>
  );
}
function Connection({
  value,
  saved,
}: {
  value: BailianChatStatus;
  saved: () => Promise<void>;
}) {
  const { message, modal } = App.useApp();
  const [workspace, setWorkspace] = useState(value.workspaceId),
    [key, setKey] = useState(""),
    [enabled, setEnabled] = useState(value.enabled),
    [reuse, setReuse] = useState(false),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false);
  const save = async (clearKey = false) => {
    setBusy(true);
    try {
      await api("/ai-model-management/bailian-chat", "POST", {
        version: value.version,
        enabled: clearKey ? false : enabled,
        workspaceId: workspace,
        apiKey: reuse || clearKey ? "" : key,
        useSavedQwenConnection: !clearKey && reuse,
        clearKey,
      });
      await saved();
      message.success("百炼聊天连接已保存，请验证后使用");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    setBusy(true);
    try {
      await api("/ai-model-management/bailian-chat/test", "POST", {});
      await saved();
      message.success("DeepSeek 识图、工具调用和 JSON 回复已验证");
    } catch (e) {
      message.error((e as Error).message);
      await saved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Text strong>DeepSeek V4.1 Flash · 百炼北京</Typography.Text>
      <Typography.Text type="secondary">
        新增为小序网站内聊天选项，保留现有默认模型。支持文字、图片和工具调用；公开搜索与网站识别使用另行配置的
        OpenRouter 搜索服务。
      </Typography.Text>
      <Alert
        type={value.verifiedAt && !dirty ? "success" : "info"}
        showIcon
        message={
          value.verifiedAt && !dirty
            ? "聊天连接已验证"
            : "保存后需验证，接通前不显示在聊天菜单"
        }
        description={
          value.errorNote ||
          "验证发送一张纯色测试图和少量文字，检查工具调用与 JSON 回复，会产生少量 API 用量。"
        }
      />
      {!value.encryptionReady && (
        <Alert type="error" message="服务器加密配置未就绪" />
      )}
      <label>
        启用百炼聊天{" "}
        <Switch
          aria-label="启用百炼聊天"
          checked={enabled}
          disabled={busy}
          onChange={(v) => {
            setEnabled(v);
            setDirty(true);
          }}
        />
      </label>
      <label htmlFor="bailian-chat-workspace">百炼北京业务空间 ID</label>
      <Input
        id="bailian-chat-workspace"
        value={workspace}
        placeholder="ws-..."
        disabled={busy || reuse}
        onChange={(e) => {
          setWorkspace(e.target.value);
          setDirty(true);
        }}
      />
      <label htmlFor="bailian-chat-key">百炼 API Key</label>
      <Input.Password
        id="bailian-chat-key"
        value={key}
        autoComplete="new-password"
        disabled={busy || reuse}
        placeholder={value.apiKeyConfigured ? "已保存，留空保留" : "sk-..."}
        onChange={(e) => {
          setKey(e.target.value);
          setDirty(true);
        }}
      />
      {value.reuseAvailable && (
        <Checkbox
          checked={reuse}
          disabled={busy}
          onChange={(e) => {
            setReuse(e.target.checked);
            setDirty(true);
            if (e.target.checked) {
              setWorkspace(value.reuseWorkspaceId);
              setKey("");
            }
          }}
        >
          使用已保存的百炼语音连接
        </Checkbox>
      )}
      <Typography.Text type="secondary">
        密钥由服务器加密保存，不回显。复用时仅复制连接，需在百炼为该密钥授权
        deepseek-v4.1-flash-1017；不修改语音配置。
      </Typography.Text>
      <Space wrap>
        <Button
          type="primary"
          loading={busy}
          disabled={
            !value.encryptionReady || !/^ws-[a-z0-9]{8,64}$/.test(workspace)
          }
          onClick={() => save()}
        >
          保存聊天连接
        </Button>
        <Button
          loading={busy}
          disabled={
            dirty ||
            !value.enabled ||
            !value.apiKeyConfigured ||
            !value.encryptionReady
          }
          onClick={verify}
        >
          验证 DeepSeek 连接
        </Button>
        {value.apiKeyConfigured && (
          <Button
            danger
            disabled={busy || dirty}
            onClick={() =>
              modal.confirm({
                title: "清除百炼聊天密钥？",
                content: "将停用此聊天连接，语音和其他服务保持原配置。",
                onOk: () => save(true),
              })
            }
          >
            清除密钥
          </Button>
        )}
      </Space>
    </Space>
  );
}
