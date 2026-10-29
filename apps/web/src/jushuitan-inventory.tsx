import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Descriptions,
  Divider,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { CloudSyncOutlined } from "@ant-design/icons";
import { api, queryClient } from "./api";
import { QueryState, useUser, when, type Row } from "./shared";

const states: Record<string, string> = {
  QUEUED: "等待同步",
  RUNNING: "同步中",
  COMPLETE: "已完成",
  FAILED: "未完成",
};
export function JushuitanInventory({ onView }: { onView: () => void }) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(""),
    [dirty, setDirty] = useState(false);
  const [form] = Form.useForm(),
    { message } = App.useApp(),
    user = useUser();
  const manager =
    user.permissions.includes("inventory.adjust") &&
    user.roleCodes?.includes("SUPER_ADMIN");
  const status = useQuery({
    queryKey: ["jushuitan-inventory"],
    queryFn: async () => (await api("/inventory/jushuitan")).data,
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });
  const s = status.data;
  useEffect(() => {
    if (!open || !s) return;
    form.setFieldsValue({
      version: s.version,
      appKey: "",
      appSecret: "",
      clearCredentials: false,
      warehouseId: s.warehouseId,
      enabled: s.enabled,
      intervalMinutes: s.intervalMinutes,
      ruleConfirmed: !!s.availableRule,
      purchase: s.availableRule?.purchase ?? false,
      incoming: s.availableRule?.incoming ?? false,
      returns: s.availableRule?.returns ?? false,
    });
    setDirty(false);
  }, [open, s?.version, form]);
  useEffect(() => {
    if (open && s && !dirty) form.setFieldValue("enabled", s.enabled);
  }, [open, s?.enabled, dirty, form]);
  const confirmed = Form.useWatch("ruleConfirmed", form);
  const run = async (action: string) => {
    setBusy(action);
    try {
      if (action === "settings") {
        const b = await form.validateFields();
        await api("/inventory/jushuitan/settings", "POST", {
          version: s.version,
          appKey: b.appKey,
          appSecret: b.appSecret,
          clearCredentials: !!b.clearCredentials,
          warehouseId: b.warehouseId ?? null,
          enabled: !!b.enabled,
          intervalMinutes: b.intervalMinutes,
          availableRule: b.ruleConfirmed
            ? {
                purchase: !!b.purchase,
                incoming: !!b.incoming,
                returns: !!b.returns,
              }
            : null,
        });
        form.setFieldsValue({ appKey: "", appSecret: "" });
        setDirty(false);
        message.success("聚水潭接入设置已保存");
      } else {
        await api(`/inventory/jushuitan/${action}`, "POST", {});
        message.success(
          action === "verify"
            ? "授权和仓库查询已验证，请选择杭州总仓；库存权限将在同步时核验"
            : "同步任务已提交，可在下方查看进度",
        );
      }
      await status.refetch();
      await queryClient.invalidateQueries({ queryKey: ["/inventory/summary"] });
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
      await status.refetch();
    } finally {
      setBusy("");
    }
  };
  const active = s?.runs?.some((r: Row) =>
    ["QUEUED", "RUNNING"].includes(r.status),
  );
  return (
    <>
      <Button
        aria-label="聚水潭同步"
        icon={<CloudSyncOutlined />}
        onClick={() => setOpen(true)}
      >
        聚水潭同步
      </Button>
      <Drawer
        title="聚水潭库存接入"
        open={open}
        size={620}
        destroyOnHidden
        onClose={() => {
          setOpen(false);
          form.resetFields();
        }}
        footer={
          <Space wrap>
            {manager && (
              <Button
                type="primary"
                disabled={!s}
                loading={busy === "settings"}
                onClick={() => void run("settings")}
              >
                保存设置
              </Button>
            )}
            <Button onClick={() => setOpen(false)}>关闭</Button>
          </Space>
        }
      >
        <QueryState error={status.error} reload={() => void status.refetch()} />
        <Alert
          type="info"
          showIcon
          title="杭州总仓 → 网站库存明细"
          description="按完整商品编码同步库存快照。查询聚水潭库存，不产生盘点单，也不修改聚水潭或网站的库存台账。"
        />
        <Typography.Paragraph style={{ marginTop: 16 }}>
          在{" "}
          <a
            href="https://openweb.jushuitan.com/management/apps"
            target="_blank"
            rel="noreferrer"
          >
            聚水潭开放平台
          </a>{" "}
          查看自研应用是否已审核通过，并确认「商品库存查询」和「仓库查询」权限。
          <a
            href="/help?chapter=38-jushuitan-inventory.md"
            target="_blank"
            rel="noreferrer"
          >
            接入说明
          </a>
        </Typography.Paragraph>
        {s && (
          <>
            {s.errorNote && (
              <Alert showIcon type="warning" title={s.errorNote} />
            )}
            {!s.encryptionReady && (
              <Alert
                type="error"
                title="服务器凭据加密尚未配置，请联系管理员"
              />
            )}
            <Descriptions
              column={1}
              size="small"
              style={{ marginTop: 16 }}
              items={[
                {
                  key: "auth",
                  label: "应用凭据",
                  children: s.configured ? "已加密保存（不回显）" : "未配置",
                },
                {
                  key: "verified",
                  label: "仓库查询验证",
                  children: when(s.verifiedAt),
                },
                {
                  key: "expire",
                  label: "授权有效期至",
                  children: when(s.tokenExpiresAt),
                },
                {
                  key: "warehouse",
                  label: "同步仓库",
                  children: s.warehouseName
                    ? `${s.warehouseName} · 编号 ${s.warehouseId} · 公司 ${s.companyId}`
                    : "待核验选择（不使用全部仓库合计）",
                },
              ]}
            />
            {manager ? (
              <Form
                form={form}
                layout="vertical"
                onValuesChange={() => setDirty(true)}
                style={{ marginTop: 24 }}
                disabled={!!busy}
              >
                <Form.Item
                  label="App Key"
                  name="appKey"
                  extra="更换应用时与 App Secret 一起填写；留空保留已存凭据。"
                >
                  <Input.Password
                    autoComplete="new-password"
                    visibilityToggle={false}
                    placeholder={
                      s.configured
                        ? "已保存，留空不更换"
                        : "填写自研应用 App Key"
                    }
                  />
                </Form.Item>
                <Form.Item label="App Secret" name="appSecret">
                  <Input.Password
                    autoComplete="new-password"
                    visibilityToggle={false}
                    placeholder="仅在此处填写，不要发到聊天"
                  />
                </Form.Item>
                {s.configured && (
                  <Form.Item name="clearCredentials" valuePropName="checked">
                    <Checkbox>清除已保存凭据与当前快照入口</Checkbox>
                  </Form.Item>
                )}
                <Button
                  loading={busy === "verify"}
                  disabled={dirty || !s.configured || !!busy}
                  onClick={() => void run("verify")}
                >
                  验证授权并读取仓库
                </Button>
                <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
                  先保存凭据再验证。使用已批准的自研应用获取授权，并在到期前自动续期；不支持服务商应用。
                  {dirty && " 设置有修改，请先保存。"}
                </Typography.Paragraph>
                <Form.Item
                  label="同步仓库"
                  name="warehouseId"
                  extra="选择截图中的杭州总仓，并核对公司编号。编号为 0 代表全部仓库，不能代替杭州总仓。"
                >
                  <Select
                    allowClear
                    placeholder="验证后选择杭州总仓"
                    options={(s.warehouses ?? [])
                      .filter((w: Row) => Number(w.wmsCoId) > 0)
                      .map((w: Row) => ({
                        value: w.wmsCoId,
                        label: `${w.name} · ${w.wmsCoId}（公司 ${w.coId}）`,
                      }))}
                  />
                </Form.Item>
                <Form.Item
                  name="enabled"
                  label="定时同步"
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Form.Item name="intervalMinutes" label="同步间隔">
                  <Select
                    options={[15, 30, 60].map((n) => ({
                      value: n,
                      label: `每 ${n} 分钟`,
                    }))}
                  />
                </Form.Item>
                <Divider />
                <Form.Item name="ruleConfirmed" valuePropName="checked">
                  <Checkbox>已核对聚水潭的可用数业务设置</Checkbox>
                </Form.Item>
                <Typography.Paragraph type="secondary">
                  可用数按「实际库存 − 订单占有 +
                  虚拟库存」加上下方选中项计算。未核对时显示“待核对口径”，原始库存仍正常同步。
                </Typography.Paragraph>
                <Space wrap>
                  <Form.Item name="purchase" valuePropName="checked">
                    <Checkbox disabled={!confirmed}>计入采购在途</Checkbox>
                  </Form.Item>
                  <Form.Item name="incoming" valuePropName="checked">
                    <Checkbox disabled={!confirmed}>计入进货仓</Checkbox>
                  </Form.Item>
                  <Form.Item name="returns" valuePropName="checked">
                    <Checkbox disabled={!confirmed}>计入销退仓</Checkbox>
                  </Form.Item>
                </Space>
              </Form>
            ) : (
              <Typography.Paragraph type="secondary">
                请由超级管理员配置或发起同步。
              </Typography.Paragraph>
            )}
            <Divider />
            <Space wrap style={{ marginBottom: 16 }}>
              {manager && (
                <Button
                  type="primary"
                  aria-label="立即同步"
                  icon={<CloudSyncOutlined />}
                  loading={busy === "sync" || active}
                  disabled={dirty || !s.verifiedAt || !s.warehouseId || !!busy}
                  onClick={() => void run("sync")}
                >
                  立即同步
                </Button>
              )}
              <Button
                disabled={!s.activeRunId}
                onClick={() => {
                  onView();
                  setOpen(false);
                  void queryClient.invalidateQueries({
                    queryKey: ["/inventory/summary"],
                  });
                }}
              >
                查看聚水潭库存
              </Button>
              <Button onClick={() => void status.refetch()}>刷新状态</Button>
            </Space>
            <Table<Row>
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={s.runs ?? []}
              scroll={{ x: 530 }}
              columns={[
                {
                  title: "时间",
                  dataIndex: "createdAt",
                  render: when,
                  width: 150,
                },
                {
                  title: "状态",
                  dataIndex: "status",
                  render: (v: string) => (
                    <Tag
                      color={
                        v === "FAILED"
                          ? "error"
                          : v === "COMPLETE"
                            ? "success"
                            : "processing"
                      }
                    >
                      {states[v]}
                    </Tag>
                  ),
                  width: 100,
                },
                {
                  title: "匹配 / 已查 / 总数",
                  render: (_, r) =>
                    `${r.receivedCount} / ${r.processedCount} / ${r.requestedCount}`,
                },
              ]}
              expandable={{
                expandedRowRender: (r) => (
                  <div>
                    <p>
                      {r.warehouseName} ·{" "}
                      {r.triggerType === "MANUAL" ? "手动同步" : "定时同步"}
                    </p>
                    {r.errorNote && (
                      <Alert type="warning" title={r.errorNote} />
                    )}
                    {!!r.missingCodes?.length && (
                      <p>
                        未匹配编码（最多列出 50 个）：
                        {r.missingCodes.join("、")}
                      </p>
                    )}
                    <p>完成时间：{when(r.finishedAt)}</p>
                  </div>
                ),
              }}
            />
          </>
        )}
      </Drawer>
    </>
  );
}
