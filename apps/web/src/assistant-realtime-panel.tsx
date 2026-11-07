import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Collapse,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from "antd";
import {
  AudioOutlined,
  CustomerServiceOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import type { UseQueryResult } from "@tanstack/react-query";
import { api } from "./api";
import {
  voiceModels,
  voiceNames,
  type AssistantVoiceStatus,
} from "../../../packages/contracts/src/assistant-voice";

import { pcmBuffer, pcmBytes } from "./voice-pcm";
import "./assistant-realtime.css";
import { RealtimeVoiceSettings } from "./realtime-voice-settings";
import type { RealtimeStatus } from "../../../packages/contracts/src/assistant-realtime";

const endpoint = "/my-workspace/assistant/voice";

function VoiceSettings({
  value,
  saved,
}: {
  value: AssistantVoiceStatus;
  saved: () => Promise<unknown>;
}) {
  const { message } = App.useApp();
  const [enabled, setEnabled] = useState(value.enabled),
    [model, setModel] = useState(value.model),
    [voice, setVoice] = useState(value.voice);
  const [key, setKey] = useState(""),
    [busy, setBusy] = useState(false);
  const sampleContext = useRef<AudioContext | null>(null);
  useEffect(
    () => () => {
      void sampleContext.current?.close().catch(() => {});
    },
    [],
  );
  const save = async (clearKey = false) => {
    setBusy(true);
    try {
      await api(endpoint + "/settings", "POST", {
        version: value.version,
        enabled: clearKey ? false : enabled,
        model,
        voice,
        ...(key && !clearKey ? { apiKey: key } : {}),
        clearKey,
      });
      setKey("");
      await saved();
      message.success("语音设置已保存");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    setBusy(true);
    void sampleContext.current?.close().catch(() => {});
    const context = new AudioContext({ sampleRate: 24000 });
    sampleContext.current = context;
    let playing = false;
    try {
      await context.resume();
      const result = (await api(endpoint + "/verify", "POST", {}))
        .data as AssistantVoiceStatus & { sample?: string };
      await saved();
      if (result.verifiedAt && result.sample) {
        message.success("GPT 声音生成已验证");
        if (context.state !== "closed") {
          const source = context.createBufferSource();
          source.buffer = pcmBuffer(context, pcmBytes(result.sample));
          source.connect(context.destination);
          source.onended = () => {
            void context.close().catch(() => {});
          };
          source.start();
          playing = true;
        }
      } else message.error(result.error || "验证失败");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      if (!playing) void context.close().catch(() => {});
      setBusy(false);
    }
  };
  const dirty =
    !!key ||
    enabled !== value.enabled ||
    model !== value.model ||
    voice !== value.voice;
  return (
    <Form layout="vertical" className="realtime-settings" disabled={busy}>
      <Typography.Paragraph type="secondary">
        通过 OpenRouter 使用 GPT Audio，按 API
        用量计费。建议配置小序专用密钥并在 OpenRouter
        设置额度。密钥仅加密保存在服务器，保存后不回显。
      </Typography.Paragraph>
      {!value.encryptionReady && (
        <Alert
          type="warning"
          title="服务器凭据加密尚未就绪，请联系部署管理员"
        />
      )}
      <Form.Item label="启用 GPT 语音">
        <Switch
          checked={enabled}
          onChange={setEnabled}
          aria-label="启用 GPT 语音"
        />
      </Form.Item>
      <Form.Item label="语音模型">
        <Select
          aria-label="语音模型"
          value={model}
          onChange={setModel}
          options={voiceModels.map((v) => ({ value: v, label: v }))}
        />
      </Form.Item>
      <Form.Item label="声音">
        <Select
          aria-label="声音"
          value={voice}
          onChange={setVoice}
          options={voiceNames.map((v) => ({ value: v, label: v }))}
        />
      </Form.Item>
      <Form.Item
        label="OpenRouter API Key"
        extra={
          value.apiKeyConfigured
            ? "已配置；留空保留原密钥"
            : "请在此页面填写，不要通过聊天发送密钥"
        }
      >
        <Input.Password
          aria-label="OpenRouter API Key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="new-password"
          maxLength={512}
          placeholder={
            value.apiKeyConfigured
              ? "已保存，不回显"
              : "输入 OpenRouter API Key"
          }
        />
      </Form.Item>
      <Space wrap>
        <Button
          type="primary"
          loading={busy}
          disabled={!value.encryptionReady}
          onClick={() => void save()}
        >
          保存语音设置
        </Button>
        <Button
          disabled={busy || dirty || !value.apiKeyConfigured}
          onClick={() => void verify()}
        >
          验证并试听
        </Button>
        {value.apiKeyConfigured && (
          <Popconfirm
            title="清除语音密钥并停用 GPT 语音？"
            onConfirm={() => save(true)}
          >
            <Button danger disabled={busy}>
              清除密钥
            </Button>
          </Popconfirm>
        )}
      </Space>
      <p className="realtime-footnote">
        验证会实际生成一句简短语音并产生少量费用，不会录音。
        {value.verifiedAt ? "声音生成已验证。" : "尚未验证。"}{" "}
        新设置从下一条语音请求生效。
      </p>
    </Form>
  );
}

export function AssistantVoiceSettingsPanel({
  executionLabel,
  status,
  realtime,
  context,
  setContext,
  memory,
  setMemory,
  startVoice,
}: {
  executionLabel: string;
  status: UseQueryResult<AssistantVoiceStatus, Error>;
  realtime: UseQueryResult<RealtimeStatus, Error>;
  context: boolean;
  setContext: (value: boolean) => void;
  memory: boolean;
  setMemory: (value: boolean) => void;
  startVoice: () => void;
}) {
  const s = status.data;
  const native = realtime.data?.enabled;
  const ready = native ? realtime.data?.ready : s?.ready;
  return (
    <div className="realtime-panel">
      <div className="realtime-heading">
        <span>
          <CustomerServiceOutlined /> 小序的声音
        </span>
        <Button
          type="text"
          aria-label="刷新语音配置"
          icon={<ReloadOutlined />}
          loading={status.isFetching}
          onClick={() => {
            void status.refetch();
            void realtime.refetch();
          }}
        />
      </div>
      <p className="realtime-footnote">
        直接点击页面上的小序就能开始语音对话，她会用动作和简短字幕回应。声音由
        AI 生成。
      </p>
      {status.isLoading && <Spin />}
      {status.error && <Alert type="error" title={status.error.message} />}
      {s && !s.ready && !native && (
        <Alert
          type="info"
          title="智能语音尚未就绪"
          description={
            s.error ||
            (!s.assistantReady
              ? "请先启用并验证工作台助理模型。"
              : s.canManage
                ? "保存下方语音设置并验证后即可使用。"
                : "请联系管理员配置并启用语音服务。")
          }
        />
      )}
      <Space wrap>
        <Tag>{native ? "小序实时通话" : "小序智能语音"}</Tag>
        <Tag>执行位置：{executionLabel}</Tag>
        <Button
          type="primary"
          icon={<AudioOutlined />}
          disabled={!ready || realtime.isLoading || !!realtime.error}
          onClick={startVoice}
        >
          与小序语音对话
        </Button>
      </Space>
      <div className="realtime-context">
        <Checkbox
          checked={context}
          onChange={(e) => setContext(e.target.checked)}
        >
          查询时附带已保存日程与待办
        </Checkbox>
        <Checkbox
          checked={memory}
          onChange={(e) => setMemory(e.target.checked)}
        >
          使用个人记忆
        </Checkbox>
      </div>
      <RealtimeVoiceSettings query={realtime} />
      {s?.canManage && (
        <Collapse
          items={[
            {
              key: "legacy",
              label: "原有分段语音与朗读设置",
              children: (
                <VoiceSettings
                  key={s.version}
                  value={s}
                  saved={() => status.refetch()}
                />
              ),
            },
          ]}
        />
      )}
      <p className="realtime-footnote">
        {native
          ? "实时传输声音并持续交谈，不限制语音条数；单次通话最长一小时，到期可重新开始。启用后不会在出错时自动降为分段语音。"
          : "原有分段语音每段最长25秒，轮流说话，每次最多10分钟。"}
        网站不保存录音，完成的文字对话保存在本人互动对话。隐藏页面或点击结束会关闭麦克风；打开页面和更新任务沿用现有权限，日程与记忆卡片仍需核对。
        {native &&
          "实时通话可向所选电脑下达识屏点击、输入和滚动任务；先在对话输入区选择执行电脑。通话开始后固定电脑和识图能力，更换需重新开始。电脑执行仍遵守本机授权，结束通话不撤销已提交任务。"}
      </p>
    </div>
  );
}
