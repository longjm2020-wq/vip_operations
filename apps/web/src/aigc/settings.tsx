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
  BAILIAN_VIDEO_API_KEY: "百炼 MiniMax H3 视频 API Key",
  VIDEO_RELAY_API_KEY: "玄宇令牌 · 视频及兼容图像 Key",
  XYLP_IMAGE_TT25_KEY: "TT Image 2.5 · 按量渠道 Key",
  XYLP_IMAGE_BANANA_PRO_KEY: "纳米香蕉 Pro · 图像渠道 Key",
  XHAI_API_KEY: "星火 AIGC Key",
  XAI_API_KEY: "xAI 官方视频 Key",
  RUNNINGHUB_API_KEY: "RunningHub 深度参考 Key",
  OPENTALKING_GATEWAY_KEY: "OpenTalking 网关 Key",
  XYLP_VIDEO_H3_OMNI_KEY: "海螺 H3 视频渠道 Key",
  XYLP_VIDEO_SD20_OMNI_KEY: "SD 2.0 视频渠道 Key",
  XYLP_VIDEO_SD25_OMNI_KEY: "SD 2.5 视频渠道 Key",
  XYLP_VIDEO_VIDU_Q3_KEY: "Vidu Q3 视频渠道 Key",
  XYLP_VIDEO_GK35_KEY: "GK-video-3.5 视频渠道 Key",
  XYLP_VIDEO_OMNI11_KEY: "Omni 1.1 视频渠道 Key",
  XYLP_VIDEO_ENHANCE_KEY: "视频增强渠道 Key",
  XYLP_CHAT_ASTRA_KEY: "TT-6 Astra 编译渠道 Key",
  XYLP_CHAT_SOL6_KEY: "TT-6 Sol 编译渠道 Key",
  XYLP_CHAT_SOL56_KEY: "TT-5.6 Sol 编译渠道 Key",
};
export function ServiceSettings({ onSaved }: { onSaved: () => void }) {
  const { message, modal } = App.useApp();
  const [config, setConfig] = useState<Item>();
  const [keys, setKeys] = useState<Item>({});
  const [reuseQwen, setReuseQwen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void studioApi("/services")
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (config?.bailianVideoCheck?.state !== "pending") return;
    const timer = window.setInterval(() => {
      void studioApi("/services/bailian-video-check")
        .then((check) => {
          setConfig((value: Item) => ({ ...value, bailianVideoCheck: check }));
          if (check?.state === "succeeded") onSaved();
        })
        .catch((e) => message.error(e.message));
    }, 15000);
    return () => window.clearInterval(timer);
  }, [config?.bailianVideoCheck?.state]);
  const checkVideo = () =>
    modal.confirm({
      title: "生成 4 秒 H3 连接测试",
      content:
        "将创建一条 768P、4 秒的纯文字测试视频，不使用业务素材。刊例约 2 元，无免费额度，实际以百炼账单为准。",
      okText: "开始测试",
      cancelText: "取消",
      onOk: async () => {
        setChecking(true);
        try {
          const check = await studioApi(
            "/services/bailian-video-check",
            "POST",
            { confirmPaid: true },
          );
          setConfig((value: Item) => ({ ...value, bailianVideoCheck: check }));
        } catch (e: any) {
          message.error(e.message);
        } finally {
          setChecking(false);
        }
      },
    });
  if (error) return <Alert type="error" title={error} />;
  if (!config) return <Spin />;
  const save = async () => {
    setBusy(true);
    try {
      setConfig(
        await studioApi("/services", "PUT", {
          revision: config.revision,
          bailianWorkspaceId: config.bailianWorkspaceId || "",
          useSavedQwenConnection: reuseQwen,
          videoRelayBaseUrl: config.videoRelayBaseUrl || "",
          xhaiBaseUrl: config.xhaiBaseUrl || "",
          opentalkingBaseUrl: config.opentalkingBaseUrl || "",
          runninghubWorkflowId: config.runninghubWorkflowId || "",
          secrets: keys,
        }),
      );
      setKeys({});
      setReuseQwen(false);
      setDirty(false);
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
                    脚本、图片和视频的默认模型由 AI 模型管理统一选择。
                    <Link to="/settings/ai">打开 AI 模型管理</Link>
                    。图片、视频和数字人使用各自的服务；第三方 API
                    可能产生供应商费用。
                  </>
                }
              />
              <Alert
                type="info"
                title="视频生成：MiniMax/MiniMax-H3"
                description="使用百炼北京业务空间，支持 768P / 2K、每段 4～15 秒。该模型无免费额度；768P 刊例为 0.50 元/秒，2K 为 0.80 元/秒，输入视频及超过 5 张的图片另计，实际以百炼账单为准。"
              />
              {config.bailianReuseAvailable && (
                <Form.Item>
                  <Checkbox
                    checked={reuseQwen}
                    onChange={(event) => {
                      setDirty(true);
                      setReuseQwen(event.target.checked);
                      if (event.target.checked)
                        setConfig({
                          ...config,
                          bailianWorkspaceId: config.bailianReuseWorkspaceId,
                        });
                    }}
                  >
                    使用已保存的百炼语音连接
                  </Checkbox>
                  <div>
                    保存时在服务器复制密钥与业务空间；视频服务之后独立配置。
                  </div>
                </Form.Item>
              )}
              <Form.Item label="百炼北京业务空间 ID">
                <Input
                  aria-label="百炼北京业务空间 ID"
                  placeholder="ws-…"
                  value={config.bailianWorkspaceId || ""}
                  disabled={reuseQwen}
                  onChange={(event) => {
                    setDirty(true);
                    setConfig({
                      ...config,
                      bailianWorkspaceId: event.target.value,
                    });
                  }}
                />
              </Form.Item>
              {config.secrets?.BAILIAN_VIDEO_API_KEY && (
                <Space direction="vertical" style={{ marginBottom: 16 }}>
                  <Button
                    loading={
                      checking ||
                      ["submitting", "pending"].includes(
                        config.bailianVideoCheck?.state,
                      )
                    }
                    disabled={
                      dirty ||
                      reuseQwen ||
                      Object.values(keys).some(Boolean) ||
                      ["submitting", "pending", "uncertain"].includes(
                        config.bailianVideoCheck?.state,
                      )
                    }
                    onClick={checkVideo}
                  >
                    验证 H3 视频连接
                  </Button>
                  <span>测试使用已保存配置；请先保存页面上的修改。</span>
                  {!dirty && config.bailianVideoCheck && (
                    <Alert
                      type={
                        config.bailianVideoCheck.state === "succeeded"
                          ? "success"
                          : config.bailianVideoCheck.state === "pending"
                            ? "info"
                            : "warning"
                      }
                      title={
                        {
                          submitting: "测试提交中，请勿重复操作",
                          pending: "测试视频生成中，页面每 15 秒查询一次",
                          succeeded: "H3 视频生成已验证",
                          failed: "测试生成失败",
                          uncertain: "测试结果待核实，已阻止重复提交",
                        }[String(config.bailianVideoCheck.state)]
                      }
                      description={
                        config.bailianVideoCheck.message ||
                        (config.bailianVideoCheck.taskId
                          ? `任务编号：${config.bailianVideoCheck.taskId}`
                          : "")
                      }
                    />
                  )}
                  {!dirty && config.bailianVideoCheck?.videoUrl && (
                    <a
                      href={config.bailianVideoCheck.videoUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看 4 秒测试视频
                    </a>
                  )}
                </Space>
              )}
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
                      onChange={(e) => {
                        setDirty(true);
                        setConfig({ ...config, [key]: e.target.value });
                      }}
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
                    disabled={key === "BAILIAN_VIDEO_API_KEY" && reuseQwen}
                    onChange={(e) => {
                      setDirty(true);
                      setKeys({ ...keys, [key]: e.target.value });
                    }}
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
