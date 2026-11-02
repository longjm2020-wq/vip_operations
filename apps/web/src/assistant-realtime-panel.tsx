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
  AudioMutedOutlined,
  CustomerServiceOutlined,
  PhoneOutlined,
  ReloadOutlined,
  SettingOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import {
  voiceModels,
  voiceNames,
  type AssistantVoiceStatus,
} from "../../../packages/contracts/src/assistant-voice";
import { useGptVoice, type VoiceState } from "./use-gpt-voice";
import { pcmBuffer, pcmBytes } from "./voice-pcm";
import "./assistant-realtime.css";

const endpoint = "/my-workspace/assistant/voice";
const stateLabels: Record<VoiceState, string> = {
  idle: "小序在这里",
  connecting: "正在打开麦克风…",
  listening: "我在听，你说",
  thinking: "让我想一想…",
  speaking: "小序正在说话",
};

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

export function AssistantRealtimePanel({
  userId,
  onState,
  onBusinessResult,
  openChat,
}: {
  userId: string;
  onState: (state: VoiceState) => void;
  onBusinessResult: () => void;
  openChat: () => void;
}) {
  const status = useQuery({
    queryKey: ["assistant-voice", userId],
    queryFn: async () => (await api(endpoint)).data as AssistantVoiceStatus,
    staleTime: 0,
  });
  const voice = useGptVoice(onBusinessResult),
    [context, setContext] = useState(false),
    [memory, setMemory] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onState(voice.state);
    return () => onState("idle");
  }, [voice.state, onState]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [voice.captions]);
  const s = status.data;
  return (
    <div className="realtime-panel">
      <div className="realtime-heading">
        <span>
          <CustomerServiceOutlined /> 与小序语音对话
        </span>
        <Button
          type="text"
          aria-label="刷新语音配置"
          icon={<ReloadOutlined />}
          loading={status.isFetching}
          disabled={voice.active}
          onClick={() => void status.refetch()}
        />
      </div>
      {status.isLoading && <Spin />}
      {status.error && (
        <Alert type="error" title={(status.error as Error).message} />
      )}
      {s && !s.ready && (
        <Alert
          showIcon
          type="info"
          title="GPT 语音尚未就绪"
          description={
            s.error ||
            (!s.assistantReady
              ? "工作台助理尚未就绪，请先启用并验证原有 AI 模型。"
              : s.canManage
                ? "展开下方语音设置，保存 OpenRouter API Key、启用并验证。"
                : "请联系管理员配置并启用 GPT 语音服务。 ")
          }
        />
      )}
      <div
        className={`realtime-stage is-${voice.state}${voice.muted ? " is-muted" : ""}`}
      >
        <div className="realtime-orb" aria-hidden="true">
          <div />
          <i />
          <b />
        </div>
        <h2 aria-live="polite">
          {voice.muted && voice.active
            ? "麦克风已静音"
            : stateLabels[voice.state]}
        </h2>
        <p>
          {voice.active
            ? "说完停顿后回复，播放时可点击打断"
            : "用声音聊想法，也把工作安排好"}
        </p>
        <div className="realtime-model">
          <Tag>{voice.model || s?.model || "GPT Audio"}</Tag>
          <span>OpenRouter · AI 生成声音 · {s?.voice || "coral"}</span>
        </div>
      </div>
      <div className="realtime-controls">
        {!voice.active ? (
          <Button
            type="primary"
            size="large"
            shape="round"
            icon={<AudioOutlined />}
            disabled={!s?.ready || !voice.supported}
            onClick={() =>
              void voice.start({
                includePersonalContext: context,
                includeMemory: memory,
              })
            }
          >
            开始语音对话
          </Button>
        ) : (
          <>
            <Button
              shape="circle"
              size="large"
              icon={voice.muted ? <AudioMutedOutlined /> : <AudioOutlined />}
              disabled={voice.state === "connecting"}
              aria-label={voice.muted ? "取消静音" : "麦克风静音"}
              title={voice.muted ? "取消静音" : "麦克风静音"}
              onClick={voice.toggleMute}
            />
            {voice.state === "listening" ? (
              <Button
                shape="round"
                size="large"
                disabled={voice.muted}
                onClick={voice.send}
              >
                发送这段
              </Button>
            ) : (
              <Button
                shape="round"
                size="large"
                icon={<StopOutlined />}
                disabled={voice.state !== "speaking"}
                onClick={voice.interrupt}
              >
                打断并说话
              </Button>
            )}
            <Button
              danger
              type="primary"
              shape="round"
              size="large"
              icon={<PhoneOutlined />}
              onClick={() => voice.stop()}
            >
              结束语音
            </Button>
          </>
        )}
      </div>
      {!voice.supported && (
        <Alert
          type="warning"
          title="当前环境不支持语音，请在 HTTPS 网站使用 Chrome / Edge 等支持 Web Audio 的浏览器"
        />
      )}
      {voice.playbackBlocked && (
        <Button icon={<CustomerServiceOutlined />} onClick={voice.play}>
          点击允许播放声音
        </Button>
      )}
      {voice.error && <Alert type="error" showIcon title={voice.error} />}
      {voice.note && (
        <p className="realtime-note" role="status">
          {voice.note}
        </p>
      )}
      <div className="realtime-context">
        <Checkbox
          checked={context}
          disabled={voice.active}
          onChange={(e) => setContext(e.target.checked)}
        >
          查询时附带已保存日程与待办
        </Checkbox>
        <Checkbox
          checked={memory}
          disabled={voice.active}
          onChange={(e) => setMemory(e.target.checked)}
        >
          使用个人记忆
        </Checkbox>
      </div>
      <p className="realtime-footnote">
        每段最长25秒，说完后自动发送给 OpenRouter /
        OpenAI，语音识别、助理回答和声音生成分别按用量计费。轮流说话，每次最长10分钟；关闭窗口或隐藏网页结束。网站不保存录音，识别文字与助理回复保存在互动对话。
      </p>
      {voice.hasBusiness && (
        <Alert
          type="info"
          title="回复已保存到互动对话"
          description="日程、记忆和同步任务仍需在卡片中确认。"
          action={
            <Button
              size="small"
              onClick={() => {
                voice.stop();
                openChat();
              }}
            >
              结束并查看
            </Button>
          }
        />
      )}
      <section
        className="realtime-captions"
        aria-label="语音对话文字"
        aria-live="polite"
        aria-relevant="additions"
      >
        <div className="realtime-caption-heading">
          对话文字<span>显示本次最近40条</span>
        </div>
        {!voice.captions.length && (
          <p className="realtime-caption-empty">你的声音，会在这里变成文字。</p>
        )}
        {voice.captions.map((item) => (
          <div key={item.id} className={`realtime-caption ${item.role}`}>
            <small>{item.role === "user" ? "你" : "小序"}</small>
            <p>{item.text}</p>
          </div>
        ))}
        <div ref={bottom} />
      </section>
      <p className="realtime-footnote">
        回答沿用工作台助理及其权限，每小时最多20条语音，也计入助理消息额度。日程、记忆和同步仍需手动确认；语音识别的商品编码请核对。每条最多朗读600字，完整内容可在互动对话查看。
      </p>
      {s?.canManage && !voice.active && (
        <Collapse
          items={[
            {
              key: "settings",
              label: (
                <span>
                  <SettingOutlined /> 语音设置
                </span>
              ),
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
    </div>
  );
}
