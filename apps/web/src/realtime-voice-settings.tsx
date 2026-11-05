import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Switch,
  Typography,
} from "antd";
import type { UseQueryResult } from "@tanstack/react-query";
import { api } from "./api";
import {
  realtimeVoices,
  doubaoRealtimeVoices,
  qwenRealtimeVoices,
  type RealtimeProvider,
  type RealtimeStatus,
} from "../../../packages/contracts/src/assistant-realtime";

const names = { marin: "清朗", cedar: "沉稳", coral: "温柔", shimmer: "轻盈" };
const doubaoNames: Record<string, string> = {
  zh_female_vv_uranus_bigtts: "灵动",
  zh_female_xiaohe_uranus_bigtts: "温柔",
  zh_male_m191_uranus_bigtts: "沉稳",
  zh_male_taocheng_uranus_bigtts: "清朗",
};
const qwenNames: Record<string, string> = {
  Tina: "甜甜 · 温暖",
  Serena: "苏瑶 · 温柔",
  Mia: "舒然 · 自然",
  Ryan: "甜茶 · 活力",
};
function Settings({
  value,
  saved,
}: {
  value: RealtimeStatus;
  saved: () => Promise<unknown>;
}) {
  const { message } = App.useApp();
  const [enabled, setEnabled] = useState(value.enabled),
    [voice, setVoice] = useState(value.voice);
  const [provider, setProvider] = useState<RealtimeProvider>(
    value.provider ?? "openai",
  );
  const [key, setKey] = useState(""),
    [busy, setBusy] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(
    value.profiles?.qwen?.workspaceId ?? "",
  );
  const [freeOnly, setFreeOnly] = useState(
    value.profiles?.qwen?.freeQuotaOnlyConfirmed ?? false,
  );
  const profile =
    value.profiles?.[provider] ??
    (provider === (value.provider ?? "openai") ? value : undefined);
  const dirty =
    !!key ||
    enabled !== value.enabled ||
    voice !== value.voice ||
    (provider === "qwen" &&
      (workspaceId !== (value.profiles?.qwen?.workspaceId ?? "") ||
        freeOnly !==
          (value.profiles?.qwen?.freeQuotaOnlyConfirmed ?? false))) ||
    provider !== (value.provider ?? "openai");
  const changeProvider = (next: RealtimeProvider) => {
    setProvider(next);
    setKey("");
    setVoice(
      value.profiles?.[next]?.voice ??
        (next === "qwen"
          ? qwenRealtimeVoices[0]
          : next === "doubao"
            ? doubaoRealtimeVoices[0]
            : realtimeVoices[0]),
    );
    setWorkspaceId(value.profiles?.qwen?.workspaceId ?? "");
    setFreeOnly(value.profiles?.qwen?.freeQuotaOnlyConfirmed ?? false);
  };
  const save = async (clearKey = false) => {
    setBusy(true);
    try {
      await api("/my-workspace/assistant/realtime/settings", "POST", {
        version: value.version,
        enabled,
        provider,
        voice,
        clearKey,
        ...(provider === "qwen"
          ? { workspaceId, freeQuotaOnlyConfirmed: freeOnly }
          : {}),
        ...(key && !clearKey ? { apiKey: key } : {}),
      });
      setKey("");
      await saved();
      message.success("实时语音设置已保存");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    setBusy(true);
    try {
      const result = (
        await api("/my-workspace/assistant/realtime/verify", "POST", {})
      ).data as RealtimeStatus;
      await saved();
      if (result.verifiedAt)
        message.success("实时通道配置已验证，请开始通话测试声音");
      else message.error(result.error || "验证失败");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Form layout="vertical" disabled={busy}>
      <Typography.Paragraph type="secondary">
        选择已开通的实时服务。每个通道分别保存密钥和声音，切换后保留其他通道的配置。
        密钥仅加密保存在服务器，不回显；原有分段语音与朗读配置继续保留。
      </Typography.Paragraph>
      {!value.encryptionReady && (
        <Alert type="warning" title="服务器凭据加密尚未就绪" />
      )}
      <Form.Item label="实时服务通道">
        <Select
          aria-label="实时服务通道"
          value={provider}
          onChange={changeProvider}
          options={[
            { value: "qwen", label: "千问实时语音（北京）" },
            { value: "doubao", label: "豆包实时语音（火山引擎）" },
            { value: "openai", label: "OpenAI 实时语音" },
          ]}
        />
      </Form.Item>
      <Form.Item label="优先使用实时通话">
        <Switch
          aria-label="优先使用实时通话"
          checked={enabled}
          onChange={setEnabled}
          disabled={busy || (provider === "qwen" && !freeOnly)}
        />
      </Form.Item>
      <Form.Item label="实时通话声音">
        <Select<string>
          aria-label="实时通话声音"
          value={voice}
          onChange={setVoice}
          options={
            provider === "qwen"
              ? qwenRealtimeVoices.map((v) => ({
                  value: v,
                  label: qwenNames[v],
                }))
              : provider === "doubao"
                ? doubaoRealtimeVoices.map((v) => ({
                    value: v,
                    label: doubaoNames[v],
                  }))
                : realtimeVoices.map((v) => ({ value: v, label: names[v] }))
          }
        />
      </Form.Item>
      {provider === "qwen" && (
        <>
          <Form.Item label="北京地域业务空间 ID">
            <Input
              aria-label="北京地域业务空间 ID"
              value={workspaceId}
              maxLength={63}
              placeholder="填写百炼业务空间 ID，不填网址"
              onChange={(e) => {
                setWorkspaceId(e.target.value.trim());
                setFreeOnly(false);
                setEnabled(false);
              }}
            />
          </Form.Item>
          <Alert
            type="info"
            title="先确认免费额度保护"
            description={
              <>
                <p>
                  在百炼北京地域确认当前实时模型仍有可用免费额度，并开启“免费额度用完即停”。额度资格、有效期和生效状态以控制台为准。
                </p>
                <Checkbox
                  checked={freeOnly}
                  onChange={(e) => {
                    setFreeOnly(e.target.checked);
                    if (!e.target.checked) setEnabled(false);
                  }}
                >
                  我已在百炼控制台确认“免费额度用完即停”已生效
                </Checkbox>
                <p>
                  此处仅记录管理员确认，不会代替百炼开关；连接验证也不能核验计费设置。额度耗尽后结束通话，不自动切换通道。
                </p>
              </>
            }
          />
        </>
      )}
      <Form.Item
        label="实时服务密钥"
        extra={
          profile?.apiKeyConfigured
            ? "已保存；留空保留原密钥"
            : "只在此处填写，请勿通过聊天发送"
        }
      >
        <Input.Password
          aria-label="实时服务密钥"
          autoComplete="new-password"
          value={key}
          maxLength={512}
          onChange={(e) => {
            setKey(e.target.value);
            if (provider === "qwen") {
              setFreeOnly(false);
              setEnabled(false);
            }
          }}
          placeholder={
            profile?.apiKeyConfigured
              ? "已保存，不回显"
              : provider === "qwen"
                ? "输入百炼北京地域 API Key"
                : provider === "doubao"
                  ? "输入火山引擎语音服务 API Key"
                  : "输入 OpenAI 平台 API Key"
          }
        />
      </Form.Item>
      <Typography.Paragraph type="secondary">
        {provider === "qwen"
          ? "使用百炼北京地域的专用 API Key 和对应业务空间。业务查询与页面操作仍使用已有助理服务，费用与实时语音额度分别计算。"
          : provider === "doubao"
            ? "请在火山引擎控制台开通端到端实时语音大模型全双工服务，并使用该语音服务的 API Key；不使用 AccessKey / SecretKey 或原有聚合语音密钥。"
            : "此通道需要 OpenAI 平台的独立 API Key，原有聚合语音密钥不能用于此通道。"}
      </Typography.Paragraph>
      <Space wrap>
        <Button
          type="primary"
          loading={busy}
          disabled={
            !value.encryptionReady ||
            (provider === "qwen" && (!workspaceId || (enabled && !freeOnly)))
          }
          onClick={() => void save()}
        >
          保存实时设置
        </Button>
        <Button
          disabled={
            busy ||
            dirty ||
            !profile?.apiKeyConfigured ||
            (provider === "qwen" && !freeOnly)
          }
          onClick={() => void verify()}
        >
          验证实时通道
        </Button>
        {profile?.apiKeyConfigured && (
          <Popconfirm
            title="清除所选通道密钥并停用实时通话？"
            onConfirm={() => save(true)}
          >
            <Button danger>清除实时密钥</Button>
          </Popconfirm>
        )}
      </Space>
      <p className="realtime-footnote">
        验证只检查通道配置，不录音、不代表麦克风、扬声器或计费设置已测试。更改声音、密钥、业务空间或费用保护确认后需重新验证。
      </p>
    </Form>
  );
}
export function RealtimeVoiceSettings({
  query,
}: {
  query: UseQueryResult<RealtimeStatus, Error>;
}) {
  const s = query.data;
  return (
    <section className="realtime-settings">
      <Typography.Title level={5}>实时通话</Typography.Title>
      <p className="realtime-footnote">
        持续聆听、自然回应，可以开口打断小序。支持桌面客户端及浏览器；语音不会因停顿或空白识别而结束。
      </p>
      {query.error && <Alert type="error" title={query.error.message} />}
      {s && (
        <Alert
          type={s.ready ? "success" : "info"}
          title={
            s.ready
              ? "实时通话已就绪"
              : s.enabled
                ? "实时通话尚未就绪"
                : "实时通话尚未启用"
          }
          description={
            s.error ||
            (s.enabled && !s.verifiedAt
              ? "保存专用密钥并验证后，即可直接点击小序开始。"
              : undefined)
          }
        />
      )}
      {s?.canManage && (
        <Settings key={s.version} value={s} saved={() => query.refetch()} />
      )}
      {s && !s.canManage && !s.ready && <p>请联系管理员配置实时通话。</p>}
    </section>
  );
}
