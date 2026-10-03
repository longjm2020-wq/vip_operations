import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Image,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
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
  NOT_CONFIGURED: "等待配置",
  PENDING: "等待验证",
  RESPONSE_RECEIVED: "已收到响应，待核对口径",
};
const compassLabels: Record<string, string> = {
  ...labels,
  READY: "待验证",
  RUNNING: "验证中",
};
const compassErrors: Record<string, string> = {
  COMPASS_PRIVATE_KEY_UNAVAILABLE:
    "Worker 无法读取有效的 RSA 私钥，请管理员核对部署配置。",
  COMPASS_PARAMETERS_INVALID:
    "查询参数格式无效，请按平台提供的 API code 参数说明配置。",
  COMPASS_PARAMETERS_REJECTED:
    "平台拒绝查询参数，请核对 API code 和该接口的参数说明。",
  COMPASS_ACCESS_OR_CONCURRENCY_REJECTED:
    "罗盘权限、白名单或并发限制未通过，请联系对接商务核对开通状态。",
  COMPASS_QUERY_FAILED: "罗盘查询失败，请核对平台当前状态及参数。",
  COMPASS_RESPONSE_INVALID: "返回格式与官方接口不一致，请管理员核对接口版本。",
  COMPASS_PROBE_INTERRUPTED: "验证期间 Worker 中断，可在一分钟后重新验证。",
  AUTH_REQUIRED: "平台授权未通过，请管理员检查现有授权。",
  IP_NOT_ALLOWLISTED: "服务器出口 IP 未通过白名单，请管理员核对。",
  GATEWAY_REJECTED: "VOP 网关拒绝请求，请管理员核对应用权限与配置。",
  NETWORK_FAILED: "网络连接失败，可在一分钟后重新验证。",
};
const status = (value: string, names = labels) => (
  <Tag
    color={
      value === "SUCCESS"
        ? "green"
        : ["BLOCKED", "FAILED"].includes(value)
          ? "red"
          : "blue"
    }
  >
    {names[value] || value}
  </Tag>
);
export function VipPage() {
  const can = useCan("vip.settings");
  const { message } = App.useApp();
  const [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [probing, setProbing] = useState<string | null>(null);
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
  async function requestCompass(namespace: string) {
    setProbing(namespace);
    try {
      await api("/integrations/vip/compass/probe", "POST", { namespace });
      message.success("已提交只读取数验证，请等待 Worker 返回结果");
      await queryClient.invalidateQueries({ queryKey: ["vip-status"] });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setProbing(null);
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
          description="每小时检查更新，每日重新核对全量数据；需要时可点击立即同步。此处保留平台原始资料供核对，不会覆盖内部商品、库存或采购单。默认查询范围不包含 OXO 业务；订单、销售和库存同步尚未启用。"
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
              Date.now() - new Date(c.heartbeatAt).getTime() > 4200000) && (
              <Alert
                style={{ marginTop: 16 }}
                type="warning"
                title="Worker 超过 70 分钟未报告状态，请检查服务运行情况"
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
        <Card title="罗盘官方取数接入">
          <Typography.Paragraph type="secondary">
            首次接入需由唯品会对接商务开通罗盘取数，登记 RSA 公钥并取得指标 API
            code 与查询参数说明。管理员将对应私钥及参数配置到 Worker
            后，可验证一次只读取数。
          </Typography.Paragraph>
          <Typography.Paragraph>
            <a
              href={
                data?.compass?.documentation ||
                "https://vop.vip.com/home#/api/method/detail/com.vip.data.compass.service.vop.CompassDataOspService-1.0.0"
              }
              target="_blank"
              rel="noreferrer"
            >
              查看官方接口
            </a>
            {" · "}
            <a href="/analytics/compass">查看经营分析</a>
          </Typography.Paragraph>
          {!data?.compass?.probes?.length && (
            <Alert type="info" title="等待 Worker 检查罗盘取数配置" />
          )}
          {data?.compass?.probes?.map((p: Row) => (
            <div key={p.namespace} style={{ marginTop: 16 }}>
              <Space wrap>
                {status(p.status, compassLabels)}
                <Button
                  onClick={() => requestCompass(p.namespace)}
                  loading={probing === p.namespace}
                  disabled={
                    !p.readyForProbe ||
                    ["PENDING", "RUNNING"].includes(p.status) ||
                    Boolean(
                      p.lastProbeAt &&
                      Date.now() - new Date(p.lastProbeAt).getTime() < 60000,
                    ) ||
                    Boolean(
                      !p.heartbeatAt ||
                      Date.now() - new Date(p.heartbeatAt).getTime() > 120000,
                    )
                  }
                >
                  验证官方取数
                </Button>
                <span>最近验证：{when(p.lastProbeAt)}</span>
              </Space>
              <Space wrap style={{ marginTop: 12, display: "flex" }}>
                {[
                  ["罗盘账号", "account"],
                  ["RSA 私钥", "privateKeyFile"],
                  ["指标 API code", "apiCode"],
                  ["查询参数", "parameters"],
                ].map(([label, key]) => (
                  <span key={key}>
                    {label}：
                    <Tag color={p.configured?.[key] ? "green" : "default"}>
                      {p.configured?.[key] ? "已配置" : "待配置"}
                    </Tag>
                  </span>
                ))}
              </Space>
              {p.lastError && (
                <Alert
                  style={{ marginTop: 12 }}
                  type="warning"
                  title={
                    compassErrors[p.lastError] ||
                    "只读取数验证未通过，请管理员核对平台配置。"
                  }
                />
              )}
              {p.status === "RESPONSE_RECEIVED" && (
                <>
                  <Typography.Paragraph style={{ marginTop: 12 }}>
                    业务状态码：{p.businessCode} · 本页 {p.rowCount ?? 0} 行 ·
                    {p.hasNextCursor
                      ? "平台返回了下一页游标"
                      : "平台未返回下一页游标"}
                    {p.sourceUpdateTime &&
                      ` · 平台更新时间：${p.sourceUpdateTime}`}
                  </Typography.Paragraph>
                  <Typography.Paragraph type="secondary">
                    字段：{p.fieldNames?.join("、") || "本页无字段"}
                  </Typography.Paragraph>
                </>
              )}
            </div>
          ))}
          <Typography.Paragraph
            type="secondary"
            style={{ marginTop: 16, marginBottom: 0 }}
          >
            当前经营分析使用已导入报表。取数验证只核对一页响应，指标口径及完整分页尚待确认；收到响应不代表完整同步，也不自动替换报表或启用每日邮件。
          </Typography.Paragraph>
        </Card>
        <Card title="平台商品库">
          <Typography.Paragraph type="secondary">
            颜色、尺码、品牌、品类、图片与价格来自已发布商品资料，每小时分批核对。详情同步不会修改内部商品档案，原有单款编辑继续保留。售价、供货价为资料接口返回值，不代表实时成交价；返回
            0 时标注“未提供有效价格”。
          </Typography.Paragraph>
          {data?.detailJobs?.map((j: Row) => (
            <Typography.Paragraph key={j.namespace}>
              商品详情：{status(j.status)} 已匹配 {String(j.matched)} 条 ·
              累计扫描 {j.scanned} 条 · 当前款分页 {j.nextPage} · 最近一轮完成{" "}
              {when(j.lastSuccessAt)}
              {j.lastError && <Tag color="red">{j.lastError}</Tag>}
            </Typography.Paragraph>
          ))}
          <Table<Row>
            loading={catalog.isLoading}
            rowKey={(r) => r.namespace + ":" + r.externalKey}
            scroll={{ x: 2450 }}
            dataSource={catalog.data?.data?.items || []}
            pagination={{
              current: page,
              pageSize: 50,
              total: catalog.data?.data?.total || 0,
              onChange: setPage,
              showSizeChanger: false,
            }}
            columns={[
              {
                title: "图片",
                width: 90,
                render: (_, r) =>
                  r.detail?.images?.length ? (
                    <Image
                      width={56}
                      height={70}
                      style={{ objectFit: "contain" }}
                      src={r.detail.images[0]}
                      alt={r.productName}
                    />
                  ) : (
                    "暂无图片"
                  ),
              },
              { title: "款号", dataIndex: "styleNo" },
              { title: "条码", dataIndex: "barcode" },
              { title: "商品名称", dataIndex: "productName", width: 320 },
              ...[
                ["颜色", "color"],
                ["尺码", "size"],
                ["品牌", "brandName"],
                ["品类", "categoryName"],
              ].map(([title, key]) => ({
                title,
                width: 110,
                render: (_: unknown, r: Row) =>
                  r.detail?.[key] || (r.detail ? "未提供" : "待同步"),
              })),
              ...[
                ["吊牌价", "marketPrice"],
                ["资料售价", "sellPrice"],
                ["资料供货价", "supplyPrice"],
              ].map(([title, key]) => ({
                title,
                width: 160,
                render: (_: unknown, r: Row) =>
                  !r.detail
                    ? "待同步"
                    : r.detail[key] == null
                      ? "未提供"
                      : Number(r.detail[key]) === 0
                        ? "0（未提供有效价格）"
                        : `${r.detail.currency || "币种未提供"} ${Number(r.detail[key]).toFixed(2)}`,
              })),
              { title: "合作编码", dataIndex: "cooperationNo" },
              { title: "仓库", dataIndex: "warehouse" },
              {
                title: "平台更新时间",
                dataIndex: "sourceUpdatedAt",
                render: (v) => when(Number(v) * 1000),
              },
              { title: "入库时间", dataIndex: "syncedAt", render: when },
              {
                title: "详情同步时间",
                dataIndex: "detailSyncedAt",
                render: when,
              },
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
