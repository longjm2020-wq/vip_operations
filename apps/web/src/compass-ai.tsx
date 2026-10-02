import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Space,
  Switch,
  Tag,
} from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { QueryState, Row } from "./shared";

const model = "openai/gpt-6.1-sol";
const states: Record<string, string> = {
  READY: "已生成",
  PENDING: "生成中",
  FAILED: "生成失败",
  DISABLED: "未开启",
  WAITING_KEY: "待配置密钥",
  WAITING_VERIFICATION: "待验证",
  WAITING_DATA: "等待完整报表",
  NOT_GENERATED: "待生成",
};
export function CompassAISettings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [form] = Form.useForm(),
    { message, modal } = App.useApp(),
    client = useQueryClient(),
    [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ["compass-ai-settings"],
    queryFn: () => api("/analytics/compass/ai-settings"),
    enabled: open,
  });
  const settings = q.data?.data;
  useEffect(() => {
    if (open && settings)
      form.setFieldsValue({ enabled: settings.enabled, apiKey: "" });
  }, [open, settings, form]);
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
      content: "将关闭 AI 分析，日报继续提供报表汇总。",
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
    <Modal
      title="AI 模型设置"
      open={open}
      onCancel={busy ? undefined : onClose}
      closable={!busy}
      maskClosable={!busy}
      footer={null}
      width={620}
      destroyOnHidden
    >
      <QueryState error={q.error} reload={() => q.refetch()} />
      <p>使用 OpenRouter 的指定模型生成每日经营摘要、观察、建议与风险分析。</p>
      <Form
        form={form}
        layout="vertical"
        onFinish={save}
        initialValues={{ enabled: false }}
        disabled={busy || q.isFetching || !settings}
      >
        <Form.Item label="模型">
          <Input value={model} readOnly aria-label="AI 分析模型" />
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
        <Form.Item
          name="enabled"
          label="开启 AI 经营分析"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Alert
          type="info"
          title="开启后，将销售、退货、库存汇总、每日趋势及三个维度 TOP 10 商品编码发送至 OpenRouter 和模型供应商生成分析。不会上传原始 Excel、邮箱或 ERP 凭据。"
        />
        <p className="secondary">
          验证会调用少量测试内容；生成分析按 OpenRouter
          实际用量计费。每份分析最多 4096 个输出
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
    </Modal>
  );
}
export function CompassAIReport({
  manage,
  sourceKey,
  onSettings,
}: {
  manage: boolean;
  sourceKey: string;
  onSettings: () => void;
}) {
  const { message } = App.useApp(),
    [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ["compass-ai-report", sourceKey],
    queryFn: () => api("/analytics/compass/ai-report"),
    refetchInterval: (query) =>
      query.state.data?.data?.state === "PENDING" ? 5000 : false,
  });
  const report = q.data?.data,
    content = report?.content,
    canGenerate = ["READY", "NOT_GENERATED", "FAILED"].includes(report?.state);
  const generate = async () => {
    setBusy(true);
    try {
      const r = await api("/analytics/compass/ai-generate", "POST", {});
      if (r.data.state === "READY") message.success("AI 分析已生成");
      else message.warning(r.data.message || "AI 分析尚未完成");
      await q.refetch();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      className="compass-ai"
      title={
        <Space wrap>
          <span>AI 经营分析</span>
          <Tag color={report?.state === "READY" ? "green" : "default"}>
            {states[report?.state] || "读取中"}
          </Tag>
        </Space>
      }
      extra={
        manage && (
          <Space>
            <Button size="small" onClick={onSettings}>
              模型设置
            </Button>
            {canGenerate && (
              <Button size="small" loading={busy} onClick={generate}>
                {report.state === "READY" ? "读取已生成分析" : "生成分析"}
              </Button>
            )}
          </Space>
        )
      }
    >
      <QueryState error={q.error} reload={() => q.refetch()} />
      {content ? (
        <>
          <p className="secondary">
            {report.responseModel} · {report.provider} · 数据截止{" "}
            {report.reportDate} · 生成于{" "}
            {new Date(report.generatedAt).toLocaleString("zh-CN")}
          </p>
          <p>{content.summary}</p>
          <details>
            <summary>展开经营观察、建议与风险</summary>
            <div className="compass-ai-columns">
              {[
                ["经营观察", content.observations],
                ["建议", content.actions],
                ["风险与数据限制", content.risks],
              ].map(([label, items]) => (
                <section key={String(label)}>
                  <h4>{label}</h4>
                  <ul>
                    {(items as string[]).map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </details>
          <small>
            分析基于三张最新报表的全量汇总，包含近1/3/7/15/30天及各维度近7天
            TOP10，与面板当前筛选无关。AI 建议供经营决策参考。
          </small>
        </>
      ) : (
        <p>{report?.message || "读取 AI 生成状态…"}</p>
      )}
    </Card>
  );
}
