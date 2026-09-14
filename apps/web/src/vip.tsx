import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Card, Space, Table, Tag, Typography } from "antd";
import { api, queryClient } from "./api";
import { Header, useCan, when, type Row } from "./shared";

const labels: Record<string, string> = {
  READY: "待启动",
  RUNNING: "同步中",
  REFRESHING: "更新授权中",
  CONTINUING: "继续下一批",
  SUCCESS: "同步成功",
  PARTIAL: "部分记录待处理",
  RETRY: "等待重试",
  BLOCKED: "需要处理",
  FAILED: "失败",
  INTERRUPTED: "已恢复断点",
};
const status = (value: string) => (
  <Tag
    color={
      value === "SUCCESS"
        ? "green"
        : ["BLOCKED", "FAILED"].includes(value)
          ? "red"
          : "blue"
    }
  >
    {labels[value] || value}
  </Tag>
);
export function VipPage() {
  const can = useCan("vip.settings");
  const { message } = App.useApp();
  const [page, setPage] = useState(1),
    [busy, setBusy] = useState(false);
  const overview = useQuery({
    queryKey: ["vip-status"],
    queryFn: () => api("/integrations/vip/status"),
    enabled: can,
    refetchInterval: 15000,
  });
  const catalog = useQuery({
    queryKey: ["vip-catalog", page],
    queryFn: () => api(`/integrations/vip/catalog?page=${page}&pageSize=50`),
    enabled: can,
    refetchInterval: 15000,
  });
  if (!can) return <Alert type="error" title="需要唯品会接入管理权限" />;
  const data = overview.data?.data;
  async function request() {
    setBusy(true);
    try {
      await api("/integrations/vip/sync", "POST", {});
      message.success("已提交同步任务，Worker 将在下一轮检查时执行");
      await queryClient.invalidateQueries({ queryKey: ["vip-status"] });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Header
        title="唯品会接入"
        subtitle="自动接收档期商品资料，查看同步进度与异常记录。"
        extra={
          <Button
            type="primary"
            loading={busy}
            disabled={!data?.connections?.length}
            onClick={request}
          >
            立即同步 / 重试
          </Button>
        }
      />
      <Space orientation="vertical" size="large" style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          title="当前同步范围：唯品会档期商品"
          description="每 5 分钟检查更新，每日重新核对全量数据。此处保留平台原始资料供核对，不会覆盖内部商品、库存或采购单。默认查询范围不包含 OXO 业务；订单、销售和库存同步尚未启用。"
        />
        {(overview.error || catalog.error) && (
          <Alert
            type="error"
            title="读取同步状态失败"
            description={String((overview.error || catalog.error)?.message)}
          />
        )}
        {data?.mode === "disabled" && (
          <Alert type="warning" title="等待 Worker 配置并启动同步" />
        )}
        {data?.connections?.map((c: Row) => (
          <Card
            key={c.namespace}
            title={`供应商 ${c.vendorId}`}
            extra={status(c.status)}
          >
            <Space wrap size="large">
              <span>平台商品 {String(data.total || 0)} 条</span>
              <span>待处理 {String(data.rejected || 0)} 条</span>
              <span>上次完成：{when(c.lastSuccessAt)}</span>
              <span>当前页：{c.nextPage}</span>
              <span>授权到期：{when(c.tokenExpiresAt)}</span>
            </Space>
            {(!c.heartbeatAt ||
              Date.now() - new Date(c.heartbeatAt).getTime() > 600000) && (
              <Alert
                style={{ marginTop: 16 }}
                type="warning"
                title="Worker 超过 10 分钟未报告状态，请检查服务运行情况"
              />
            )}
            {c.lastError && (
              <Alert
                style={{ marginTop: 16 }}
                type="error"
                title={`同步错误：${c.lastError}`}
                description="网络失败会自动重试。授权或白名单错误需修复配置后重试；令牌刷新中断时请先恢复授权。"
              />
            )}
          </Card>
        ))}
        <Card title="平台商品库">
          <Table<Row>
            loading={catalog.isLoading}
            rowKey={(r) => r.namespace + ":" + r.externalKey}
            scroll={{ x: 1100 }}
            dataSource={catalog.data?.data?.items || []}
            pagination={{
              current: page,
              pageSize: 50,
              total: catalog.data?.data?.total || 0,
              onChange: setPage,
              showSizeChanger: false,
            }}
            columns={[
              { title: "款号", dataIndex: "styleNo" },
              { title: "条码", dataIndex: "barcode" },
              { title: "商品名称", dataIndex: "productName", width: 320 },
              { title: "合作编码", dataIndex: "cooperationNo" },
              { title: "仓库", dataIndex: "warehouse" },
              {
                title: "平台更新时间",
                dataIndex: "sourceUpdatedAt",
                render: (v) => when(Number(v) * 1000),
              },
              { title: "入库时间", dataIndex: "syncedAt", render: when },
            ]}
          />
        </Card>
        <Card title="最近同步记录">
          <Typography.Paragraph type="secondary">
            断点按页保存；重复记录不会重复入库。异常记录会隔离保存，修复解析规则后自动重试。
          </Typography.Paragraph>
          <Table<Row>
            rowKey="id"
            dataSource={data?.runs || []}
            pagination={{ pageSize: 10 }}
            scroll={{ x: 900 }}
            columns={[
              { title: "开始时间", dataIndex: "startedAt", render: when },
              { title: "状态", dataIndex: "status", render: status },
              { title: "页数", dataIndex: "pages" },
              { title: "接收", dataIndex: "received" },
              { title: "新增 / 更新", dataIndex: "changed" },
              { title: "异常尝试", dataIndex: "rejected" },
              { title: "错误代码", dataIndex: "errorCode" },
            ]}
          />
        </Card>
      </Space>
    </>
  );
}
