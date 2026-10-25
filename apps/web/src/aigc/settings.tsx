import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
} from "antd";
import { Link } from "react-router-dom";
import { studioApi, type Item } from "./api";
const secretLabels: Record<string, string> = {
  VIDEO_RELAY_API_KEY: "玄宇令牌 · 视频及兼容图像 Key",
  XYLP_IMAGE_TT25_KEY: "TT Image 2.5 · 按量渠道 Key",
  XYLP_IMAGE_BANANA_PRO_KEY: "纳米香蕉 Pro · 图像渠道 Key",
  XHAI_API_KEY: "星火 AIGC Key",
  XAI_API_KEY: "xAI 官方视频 Key",
  RUNNINGHUB_API_KEY: "RunningHub 深度参考 Key",
  OPENTALKING_GATEWAY_KEY: "OpenTalking 网关 Key",
};
export function ServiceSettings({ onSaved }: { onSaved: () => void }) {
  const { message } = App.useApp();
  const [config, setConfig] = useState<Item>();
  const [keys, setKeys] = useState<Item>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void studioApi("/services")
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, []);
  if (error) return <Alert type="error" title={error} />;
  if (!config) return <Spin />;
  const save = async () => {
    setBusy(true);
    try {
      setConfig(
        await studioApi("/services", "PUT", {
          revision: config.revision,
          videoRelayBaseUrl: config.videoRelayBaseUrl || "",
          xhaiBaseUrl: config.xhaiBaseUrl || "",
          opentalkingBaseUrl: config.opentalkingBaseUrl || "",
          runninghubWorkflowId: config.runninghubWorkflowId || "",
          secrets: keys,
        }),
      );
      setKeys({});
      message.success("连接配置已加密保存");
      onSaved();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Tabs
      items={[
        {
          key: "connections",
          label: "模型连接",
          children: (
            <Form layout="vertical">
              <Alert
                type="info"
                title="内部创作使用自己的模型服务"
                description={
                  <>
                    拆解复用本站已验证的 OpenRouter 设置，模型为
                    openai/gpt-6.1-sol。
                    <Link to="/settings/ai">打开 AI 模型设置</Link>
                    。图片、视频和数字人使用各自的服务；第三方 API
                    可能产生供应商费用。
                  </>
                }
              />
              <div className="aigc-form-grid">
                {[
                  [
                    "videoRelayBaseUrl",
                    "玄宇令牌服务地址",
                    "https://api.lk888.ai",
                  ],
                  [
                    "xhaiBaseUrl",
                    "星火 AIGC 服务地址",
                    "https://xhai.token6688.com",
                  ],
                  [
                    "opentalkingBaseUrl",
                    "OpenTalking 推理服务地址",
                    "https://你的推理服务",
                  ],
                  ["runninghubWorkflowId", "RunningHub 工作流 ID", "选填"],
                ].map(([key, label, placeholder]) => (
                  <Form.Item key={key} label={label}>
                    <Input
                      value={config[key] || ""}
                      placeholder={placeholder}
                      onChange={(e) =>
                        setConfig({ ...config, [key]: e.target.value })
                      }
                    />
                  </Form.Item>
                ))}
              </div>
              {Object.entries(secretLabels).map(([key, label]) => (
                <Form.Item
                  key={key}
                  label={label}
                  extra={
                    config.secrets?.[key] ? "已配置；留空保留原值" : "未配置"
                  }
                >
                  <Input.Password
                    autoComplete="new-password"
                    value={keys[key] || ""}
                    onChange={(e) =>
                      setKeys({ ...keys, [key]: e.target.value })
                    }
                    placeholder="填写后加密保存在服务器，不回显原值"
                  />
                </Form.Item>
              ))}
              {!config.encryptionReady && (
                <Alert type="warning" title="服务器凭据加密尚未就绪" />
              )}
              <Button
                type="primary"
                loading={busy}
                disabled={!config.encryptionReady}
                onClick={save}
              >
                保存服务配置
              </Button>
            </Form>
          ),
        },
        { key: "digital", label: "数字人配置", children: <DigitalSettings /> },
      ]}
    />
  );
}
function DigitalSettings() {
  const { message } = App.useApp();
  const [settings, setSettings] = useState<Item>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = () => studioApi("/admin/digital-human").then(setSettings);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  if (error) return <Alert type="error" title={error} />;
  if (!settings) return <Spin />;
  const run = async (action: string) => {
    setBusy(action);
    try {
      if (action === "check") {
        await studioApi("/admin/digital-human/preflight", "POST", {});
        message.success("已连接并读取真实模型");
      } else {
        const {
          baseUrl: _base,
          keyConfigured: _key,
          operations: _ops,
          availableTemplates: _templates,
          checkedAt: _checked,
          ...s
        } = settings;
        await studioApi("/admin/digital-human", "PUT", {
          ...s,
          publicEnabled: true,
          videoCredits: 0,
          sessionCredits: 0,
        });
        message.success("数字人配置已保存");
      }
      await load();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setBusy("");
    }
  };
  return (
    <Form layout="vertical">
      <Alert
        type="info"
        title="先保存模型连接，再检测可用形象模板"
        description="需要部署独立的 OpenTalking 推理服务。检测只读取模型状态，不创建视频。"
      />
      <Space style={{ margin: "16px 0" }}>
        <Button loading={busy === "check"} onClick={() => run("check")}>
          检测服务与真实模型
        </Button>
        <span>
          {settings.checkedAt
            ? `最近检测：${new Date(settings.checkedAt).toLocaleString()}`
            : "尚未检测"}
        </span>
      </Space>
      <Form.Item label="开放形象模板">
        <Select
          mode="multiple"
          value={(settings.templates || []).map((t: Item) => t.id)}
          onChange={(ids) =>
            setSettings({
              ...settings,
              templates: ids.map((id: string) => {
                const t = settings.availableTemplates.find(
                  (x: Item) => x.id === id,
                );
                return {
                  id: t.id,
                  model: t.model,
                  label: t.label || t.name || t.id,
                };
              }),
            })
          }
          options={(settings.availableTemplates || []).map((t: Item) => ({
            value: t.id,
            label: t.label || t.name || t.id,
          }))}
        />
      </Form.Item>
      <Form.Item label="启用数字人">
        <Switch
          checked={settings.enabled}
          onChange={(enabled) => setSettings({ ...settings, enabled })}
        />
      </Form.Item>
      <Space>
        <Checkbox
          checked={settings.textEnabled}
          onChange={(e) =>
            setSettings({ ...settings, textEnabled: e.target.checked })
          }
        >
          启用文字口播
        </Checkbox>
        <Checkbox
          checked={settings.realtimeEnabled}
          onChange={(e) =>
            setSettings({ ...settings, realtimeEnabled: e.target.checked })
          }
        >
          启用实时互动
        </Checkbox>
      </Space>
      <div className="aigc-form-grid">
        {[
          ["ttsProvider", "语音合成服务"],
          ["ttsModel", "语音合成模型"],
          ["sttProvider", "语音识别服务"],
        ].map(([key, label]) => (
          <Form.Item key={key} label={label}>
            <Input
              value={settings[key]}
              onChange={(e) =>
                setSettings({ ...settings, [key]: e.target.value })
              }
            />
          </Form.Item>
        ))}
        <Form.Item label="实时互动时长（分钟）">
          <InputNumber
            min={1}
            max={30}
            value={settings.sessionMinutes}
            onChange={(sessionMinutes) =>
              setSettings({ ...settings, sessionMinutes })
            }
          />
        </Form.Item>
        <Form.Item label="口播文字上限">
          <InputNumber
            min={10}
            max={3000}
            value={settings.maxTextLength}
            onChange={(maxTextLength) =>
              setSettings({ ...settings, maxTextLength })
            }
          />
        </Form.Item>
      </div>
      <Form.Item label="可用声音（每行：声音 ID=显示名称）">
        <Input.TextArea
          rows={3}
          value={(settings.voices || [])
            .map((v: Item) => `${v.id}=${v.label}`)
            .join("\n")}
          onChange={(e) =>
            setSettings({
              ...settings,
              voices: e.target.value
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                  const [id, ...label] = line.split("=");
                  return { id, label: label.join("=") || id };
                }),
            })
          }
        />
      </Form.Item>
      <Button
        type="primary"
        loading={busy === "save"}
        onClick={() => run("save")}
      >
        保存数字人配置
      </Button>
    </Form>
  );
}
