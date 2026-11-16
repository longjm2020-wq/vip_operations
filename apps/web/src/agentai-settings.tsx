import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import type {
  AgentAiModel,
  AgentAiStatus,
} from "../../../packages/contracts/src/agentai";
import { api } from "./api";
import { QueryState } from "./shared";

export function AgentAiSettings({ saved }: { saved: () => void }) {
  const q = useQuery({
    queryKey: ["agentai-settings"],
    queryFn: async () =>
      (await api("/ai-model-management/agentai")).data as AgentAiStatus,
  });
  return (
    <>
      <QueryState error={q.error} reload={() => q.refetch()} />
      {q.data && (
        <Connection
          key={q.data.version}
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
  value: AgentAiStatus;
  saved: () => Promise<void>;
}) {
  const { message, modal } = App.useApp();
  const [key, setKey] = useState("");
  const [enabled, setEnabled] = useState(value.enabled);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const run = async (
    name: string,
    operation: () => Promise<unknown>,
    success: string,
  ) => {
    setBusy(name);
    try {
      await operation();
      await saved();
      message.success(success);
    } catch (e) {
      message.error((e as Error).message);
      await saved();
    } finally {
      setBusy("");
    }
  };
  const save = (clearKey = false) =>
    run(
      "save",
      async () => {
        await api("/ai-model-management/agentai", "POST", {
          version: value.version,
          enabled: clearKey ? false : enabled,
          apiKey: clearKey ? "" : key,
          clearKey,
        });
        setKey("");
        setDirty(false);
      },
      clearKey ? "AgentAI 连接已清除" : "连接已保存，请同步模型目录",
    );
  const verify = (
    model: AgentAiModel,
    capability: "chat" | "tools" | "structured",
  ) =>
    run(
      model.id + capability,
      () =>
        api("/ai-model-management/agentai/test", "POST", {
          model: model.id,
          capability,
        }),
      "模型能力验证通过",
    );
  const ready =
    !dirty && value.enabled && value.apiKeyConfigured && value.encryptionReady;
  const rows = value.models.filter(
    (m) =>
      (type === "all" || m.type === type) &&
      `${m.name} ${m.model}`
        .toLowerCase()
        .includes(search.toLowerCase().trim()),
  );
  const typeName: Record<string, string> = {
    chat: "聊天",
    image: "图片",
    video: "视频",
    audio: "音频",
  };
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Text strong>AgentAI 模型连接</Typography.Text>
      <Typography.Text type="secondary">
        接入小序对话、AI 员工及支持的 AIGC
        图片和视频模型。各功能仍按实际能力筛选型号。
      </Typography.Text>
      <Typography.Link
        href="https://agentai.token6688.com/zh-CN/console/keys"
        target="_blank"
        rel="noopener noreferrer"
      >
        前往 AgentAI 管理 API 密钥
      </Typography.Link>
      <Typography.Text code>{value.endpoint}</Typography.Text>
      <Alert
        showIcon
        type={value.verifiedAt && !dirty ? "success" : "info"}
        message={
          value.verifiedAt && !dirty
            ? "密钥和模型目录已接通"
            : "保存密钥后同步模型目录"
        }
        description={
          value.errorNote ||
          "同步目录不生成内容。模型能力验证会发送少量测试内容并产生实际 API 用量；聊天、工具、结构化能力分别记录。"
        }
      />
      {!value.encryptionReady && (
        <Alert type="error" message="服务器加密配置未就绪" />
      )}
      <label>
        启用 AgentAI{" "}
        <Switch
          aria-label="启用 AgentAI"
          checked={enabled}
          disabled={!!busy}
          onChange={(v) => {
            setEnabled(v);
            setDirty(true);
          }}
        />
      </label>
      <label htmlFor="agentai-api-key">API Key</label>
      <Input.Password
        id="agentai-api-key"
        autoComplete="new-password"
        value={key}
        disabled={!!busy}
        placeholder={
          value.apiKeyConfigured
            ? "已加密保存，留空保留"
            : "粘贴 AgentAI API Key"
        }
        onChange={(e) => {
          setKey(e.target.value);
          setDirty(true);
        }}
      />
      <Space wrap>
        <Button
          type="primary"
          loading={busy === "save"}
          disabled={!!busy || !value.encryptionReady}
          onClick={() => save()}
        >
          保存连接
        </Button>
        <Button
          loading={busy === "sync"}
          disabled={!!busy || !ready}
          onClick={() =>
            run(
              "sync",
              () => api("/ai-model-management/agentai/sync", "POST", {}),
              "模型目录已同步",
            )
          }
        >
          同步模型目录
        </Button>
        {value.apiKeyConfigured && (
          <Button
            danger
            disabled={!!busy || dirty}
            onClick={() =>
              modal.confirm({
                title: "清除 AgentAI 密钥？",
                content: "清除后将停用这个模型来源。",
                onOk: () => save(true),
              })
            }
          >
            清除密钥
          </Button>
        )}
      </Space>
      <Typography.Text type="secondary">
        密钥仅在服务器加密保存，不回显。目录列出不代表模型已验证；音频目录目前供查看，不替代实时语音连接。
      </Typography.Text>
      <Space wrap>
        <Input
          aria-label="搜索 AgentAI 模型"
          allowClear
          placeholder="搜索模型名称或 ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          aria-label="AgentAI 模型类型"
          value={type}
          onChange={setType}
          style={{ width: 120 }}
          options={[
            { value: "all", label: "全部类型" },
            ...Object.entries(typeName).map(([value, label]) => ({
              value,
              label,
            })),
          ]}
        />
      </Space>
      <Table<AgentAiModel>
        size="small"
        rowKey="id"
        dataSource={rows}
        pagination={{
          pageSize: 8,
          showSizeChanger: false,
          showTotal: (n) => `${n} 个模型`,
        }}
        scroll={{ x: 520 }}
        columns={[
          {
            title: "模型",
            dataIndex: "name",
            render: (_, m) => (
              <>
                <div>{m.name}</div>
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 11, overflowWrap: "anywhere" }}
                >
                  {m.model}
                </Typography.Text>
                <div>
                  <Tag>{typeName[m.type] || m.type}</Tag>
                  {m.vision && <Tag>支持图片输入</Tag>}
                  {!m.available && <Tag color="orange">暂不可用</Tag>}
                </div>
              </>
            ),
          },
          {
            title: "能力验证",
            width: 215,
            render: (_, m) =>
              m.type === "chat" ? (
                <Space wrap size={4}>
                  {(
                    [
                      ["chat", "聊天", m.chatVerifiedAt],
                      ["tools", "工具", m.toolsVerifiedAt],
                      ["structured", "结构化", m.structuredVerifiedAt],
                    ] as const
                  ).map(([cap, label, at]) => (
                    <Button
                      key={cap}
                      size="small"
                      loading={busy === m.id + cap}
                      disabled={
                        !!busy || !ready || !value.verifiedAt || !m.available
                      }
                      onClick={() => verify(m, cap)}
                    >
                      {at ? `✓ ${label}` : `验证${label}`}
                    </Button>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary">
                  {m.type === "audio"
                    ? "音频工作流尚未接入"
                    : "在 AIGC 中按兼容能力选择；以实际任务结果为准"}
                </Typography.Text>
              ),
          },
        ]}
      />
    </Space>
  );
}
