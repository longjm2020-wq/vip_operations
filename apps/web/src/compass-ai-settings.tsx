import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  Switch,
  Tag,
} from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { QueryState, Row, useUser } from "./shared";
import { AiModelManagementPage } from "./ai-model-management";

function SettingsForm() {
  const [form] = Form.useForm(),
    { message, modal } = App.useApp(),
    client = useQueryClient(),
    [busy, setBusy] = useState(false);
  const enabled = Form.useWatch("enabled", form);
  const q = useQuery({
    queryKey: ["compass-ai-settings"],
    queryFn: () => api("/analytics/compass/ai-settings"),
  });
  const settings = q.data?.data;
  useEffect(() => {
    if (settings)
      form.setFieldsValue({ enabled: settings.enabled, apiKey: "" });
  }, [settings, form]);
  const refresh = async () => {
    await q.refetch();
    await client.invalidateQueries({ queryKey: ["compass-ai-report"] });
    await client.invalidateQueries({ queryKey: ["ai-model-management"] });
  };
  const save = async (values: Row) => {
    setBusy(true);
    try {
      const saved = await api("/analytics/compass/ai-settings", "POST", {
        enabled: values.enabled,
        ...(values.apiKey?.trim() ? { apiKey: values.apiKey.trim() } : {}),
      });
      form.setFieldValue("apiKey", "");
      if (saved.data.enabled && saved.data.apiKeyConfigured) {
        const result = await api("/analytics/compass/ai-test", "POST", {});
        message.success(`连接已验证：${result.data.model}`);
      } else message.success("AI 设置已保存");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      form.setFieldValue("apiKey", "");
      await refresh();
      setBusy(false);
    }
  };
  const clear = () =>
    modal.confirm({
      title: "清除 OpenRouter API Key？",
      content:
        "将关闭依赖此共享连接的小序、团队、经营分析、商品资料及 AIGC 编译；日报继续提供报表汇总。独立语音和媒体凭据另行管理。",
      okText: "清除",
      cancelText: "取消",
      onOk: async () => {
        await api("/analytics/compass/ai-settings", "POST", {
          enabled: false,
          clearKey: true,
        });
        form.setFieldValue("apiKey", "");
        await refresh();
      },
    });
  return (
    <div className="ai-connection-settings">
      <QueryState error={q.error} reload={() => q.refetch()} />
      <p className="ai-connection-hint">
        小序、团队、经营分析及商品资料等功能共用。
      </p>
      <Form
        form={form}
        layout="vertical"
        onFinish={save}
        initialValues={{ enabled: false }}
        disabled={busy || q.isFetching || !settings}
      >
        <Form.Item
          name="apiKey"
          label="API Key"
          extra={
            settings?.apiKeyConfigured
              ? "密钥已加密保存，留空保留。"
              : "密钥将加密保存，不会回显。"
          }
        >
          <Input.Password
            autoComplete="new-password"
            placeholder={
              settings?.apiKeyConfigured
                ? "已配置，留空保留"
                : "输入 OpenRouter API Key"
            }
          />
        </Form.Item>
        <div className="ai-connection-state">
          <label htmlFor="enabled">启用连接</label>
          <Form.Item name="enabled" valuePropName="checked" noStyle>
            <Switch aria-label="启用连接" />
          </Form.Item>
          {settings && (
            <Tag color={settings.enabled && settings.verifiedAt ? "green" : "default"}>
              {!settings.enabled
                ? "已关闭"
                : settings.verifiedAt
                  ? "连接已验证"
                  : "待验证"}
            </Tag>
          )}
        </div>
        {!settings?.encryptionReady && settings && (
          <Alert
            type="warning"
            title="服务器凭据加密密钥待配置，暂时不能保存 API Key"
          />
        )}
        {settings?.errorNote && (
          <Alert type="error" title={settings.errorNote} />
        )}
        <p className="ai-connection-hint">
          验证使用经营分析的当前模型，会产生少量用量。
        </p>
        <div className="ai-connection-actions">
          {settings?.apiKeyConfigured && (
            <Button type="text" danger onClick={clear}>
              清除密钥
            </Button>
          )}
          <Button type="primary" htmlType="submit" loading={busy}>
            {enabled ? "保存并验证" : "保存"}
          </Button>
        </div>
      </Form>
    </div>
  );
}

export function CompassAISettingsPage() {
  const user = useUser();
  if (
    !user.roleCodes?.includes("SUPER_ADMIN") ||
    !user.permissions.includes("analytics.manage")
  )
    return <Alert type="warning" title="仅超级管理员可以配置 AI 模型" />;
  return <AiModelManagementPage connections={<SettingsForm />} />;
}
