import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  Space,
  Switch,
  Tag,
} from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { Header, QueryState, Row, useUser } from "./shared";
import "./compass-ai.css";

const model = "openai/gpt-6.1-sol";
function SettingsForm() {
  const [form] = Form.useForm(),
    { message, modal } = App.useApp(),
    client = useQueryClient(),
    [busy, setBusy] = useState(false);
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
  };
  const save = async (values: Row) => {
    setBusy(true);
    try {
      const saved = await api("/analytics/compass/ai-settings", "POST", {
        enabled: values.enabled,
        ...(values.apiKey?.trim() ? { apiKey: values.apiKey.trim() } : {}),
      });
      form.setFieldValue("apiKey", "");
      if (saved.data.apiKeyConfigured) {
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
        "将关闭 AI 经营分析、商品资料生成与个人助理，日报继续提供报表汇总。",
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
    <Card className="compass-ai-settings">
      <QueryState error={q.error} reload={() => q.refetch()} />
      <p>
        使用 OpenRouter 的指定模型提供经营分析、商品资料生成与 AI 个人助理。
      </p>
      <Form
        form={form}
        layout="vertical"
        onFinish={save}
        initialValues={{ enabled: false }}
        disabled={busy || q.isFetching || !settings}
      >
        <Form.Item label="模型">
          <Input value={model} readOnly aria-label="AI 模型" />
        </Form.Item>
        <Form.Item
          name="apiKey"
          label="OpenRouter API Key"
          extra={
            settings?.apiKeyConfigured
              ? "已加密保存；留空保留原密钥，密钥不会回显。"
              : "请在本页填写密钥；不要在聊天或表格中发送。"
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
        <Form.Item name="enabled" label="开启 AI 功能" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Alert
          type="info"
          title="经营分析发送报表汇总与商品编码；商品资料生成发送有权查看的成分、类目和商品图片；个人助理发送用户消息及最近对话，经用户勾选后附带其日程和待办。数据发送至 OpenRouter 和模型供应商，不发送私有备忘、原始 Excel 或登录凭据。"
        />
        <p className="secondary">
          验证会调用少量测试内容；经营分析与标题生成按 OpenRouter
          实际用量计费。每份经营分析最多 4096 个输出
          token，同一批数据生成后复用给多个收件人。
          <a
            href="https://openrouter.ai/openai/gpt-6.1-sol#providers"
            target="_blank"
            rel="noreferrer"
          >
            查看模型与价格
          </a>
        </p>
        {!settings?.encryptionReady && settings && (
          <Alert
            type="warning"
            title="服务器凭据加密密钥待配置，暂时不能保存 API Key"
          />
        )}
        {settings?.errorNote && (
          <Alert type="error" title={settings.errorNote} />
        )}
        <Space wrap style={{ marginTop: 16 }}>
          <Button type="primary" htmlType="submit" loading={busy}>
            保存并验证模型
          </Button>
          <Tag color={settings?.verifiedAt ? "green" : "default"}>
            {settings?.verifiedAt ? "模型连接已验证" : "模型连接待验证"}
          </Tag>
          {settings?.apiKeyConfigured && (
            <Button type="link" onClick={clear}>
              清除密钥
            </Button>
          )}
        </Space>
      </Form>
    </Card>
  );
}

export function CompassAISettingsPage() {
  const user = useUser();
  if (
    !user.roleCodes?.includes("SUPER_ADMIN") ||
    !user.permissions.includes("analytics.manage")
  )
    return <Alert type="warning" title="仅超级管理员可以配置 AI 模型" />;
  return (
    <>
      <Header
        title="AI 模型设置"
        subtitle="配置经营分析、商品资料与个人助理使用的模型连接"
      />
      <SettingsForm />
    </>
  );
}
