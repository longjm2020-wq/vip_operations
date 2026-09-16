import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
} from "antd";
import { Decimal } from "decimal.js";
import { api } from "./api";
import { Header, Row, useCan } from "./shared";
import {
  statementKinds,
  statementQuerySchema,
} from "../../../packages/contracts/src/supply-aftersales";
import { statementPeriod } from "../../../packages/contracts/src/supply-statement-period";
const money = (v: unknown) => new Decimal(String(v || 0)).toFixed(2);
export function SupplyStatements({ internal = false }: { internal?: boolean }) {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    yearNow = Number(today.slice(0, 4)),
    monthNow = Number(today.slice(5, 7));
  const [mode, setMode] = useState("month"),
    [year, setYear] = useState(yearNow),
    [month, setMonth] = useState(monthNow),
    [quarter, setQuarter] = useState(Math.ceil(monthNow / 3)),
    [custom, setCustom] = useState(statementPeriod("month", yearNow, monthNow)),
    [supplier, setSupplier] = useState<string | undefined>(),
    [kind, setKind] = useState(""),
    [page, setPage] = useState(1),
    [exporting, setExporting] = useState(false);
  const { message } = App.useApp(),
    canOrder = useCan("supply.purchase");
  const period =
    mode === "custom"
      ? custom
      : statementPeriod(mode, year, mode === "quarter" ? quarter : month);
  const filters = {
      internal: internal ? "1" : "0",
      ...period,
      kind,
      ...(supplier && internal ? { accountId: supplier } : {}),
      page: String(page),
    },
    valid = statementQuerySchema.safeParse(filters).success;
  const query = new URLSearchParams(filters);
  const result = useQuery({
    queryKey: ["supply-statements", filters],
    queryFn: () => api("/supply/statements?" + query),
    enabled: valid,
    refetchInterval: 15000,
  });
  const suppliers = useQuery({
    queryKey: ["supply-statement-suppliers"],
    queryFn: async () => (await api("/supply/statement-suppliers")).data,
    enabled: internal,
  });
  const s = result.data?.summary || {};
  const exportBill = async () => {
    setExporting(true);
    try {
      const r = await fetch("/api/v1/supply/statements/export?" + query, {
        credentials: "same-origin",
      });
      if (!r.ok) {
        const e = await r.json();
        throw Error(e.error?.message || "导出失败，请重试");
      }
      const blob = await r.blob(),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = `对账单_${period.from}_${period.to}.xlsx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      message.success("对账单已导出");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  };
  return (
    <>
      <Header
        title="对账中心"
        subtitle="交易成功计入货款，退款完成自动扣减，换货不扣款。"
        extra={
          <Button
            type="primary"
            disabled={!valid || !!result.error}
            loading={exporting}
            onClick={() => void exportBill()}
          >
            导出本期账单
          </Button>
        }
      />
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          aria-label="对账周期"
          value={mode}
          style={{ width: 130 }}
          onChange={(v) => {
            setMode(v);
            setPage(1);
          }}
          options={[
            { value: "month", label: "按月" },
            { value: "quarter", label: "按季度" },
            { value: "year", label: "按年" },
            { value: "custom", label: "自定义日期" },
          ]}
        />
        {mode !== "custom" && (
          <InputNumber
            aria-label="对账年份"
            min={1900}
            max={9999}
            precision={0}
            value={year}
            onChange={(v) => {
              if (v) setYear(v);
              setPage(1);
            }}
            addonAfter="年"
            style={{ width: 145 }}
          />
        )}
        {mode === "month" && (
          <Select
            aria-label="对账月份"
            value={month}
            style={{ width: 105 }}
            options={Array.from({ length: 12 }, (_, i) => ({
              value: i + 1,
              label: i + 1 + "月",
            }))}
            onChange={(v) => {
              setMonth(v);
              setPage(1);
            }}
          />
        )}
        {mode === "quarter" && (
          <Select
            aria-label="对账季度"
            value={quarter}
            style={{ width: 130 }}
            options={[1, 2, 3, 4].map((v) => ({
              value: v,
              label: "第" + v + "季度",
            }))}
            onChange={(v) => {
              setQuarter(v);
              setPage(1);
            }}
          />
        )}
        {mode === "custom" && (
          <>
            <Input
              aria-label="开始日期"
              type="date"
              value={custom.from}
              style={{ width: 160 }}
              onChange={(e) => {
                setCustom((s) => ({ ...s, from: e.target.value }));
                setPage(1);
              }}
            />
            至
            <Input
              aria-label="结束日期"
              type="date"
              value={custom.to}
              style={{ width: 160 }}
              onChange={(e) => {
                setCustom((s) => ({ ...s, to: e.target.value }));
                setPage(1);
              }}
            />
          </>
        )}
        {internal && (
          <Select
            aria-label="对账供应商"
            showSearch
            allowClear
            placeholder="全部供应商"
            optionFilterProp="label"
            style={{ width: 210 }}
            value={supplier}
            loading={suppliers.isLoading}
            options={(suppliers.data || []).map((s: Row) => ({
              value: s.id,
              label: s.name,
            }))}
            onChange={(v) => {
              setSupplier(v);
              setPage(1);
            }}
          />
        )}
        <Select
          aria-label="交易事项"
          value={kind}
          style={{ width: 160 }}
          onChange={(v) => {
            setKind(v);
            setPage(1);
          }}
          options={[
            { value: "", label: "全部交易事项" },
            ...Object.entries(statementKinds).map(([value, label]) => ({
              value,
              label,
            })),
          ]}
        />
        <Button onClick={() => void result.refetch()} disabled={!valid}>
          刷新
        </Button>
      </Space>
      {!valid && (
        <Alert
          type="warning"
          title="请选择有效周期，开始日期不能晚于结束日期。"
        />
      )}
      {(result.error || suppliers.error) && (
        <Alert
          type="error"
          title={(result.error || suppliers.error)?.message}
        />
      )}
      {valid && (
        <>
          <div className="statement-summary">
            {[
              ["交易成功货款", "¥" + money(s.saleAmount)],
              ["退款扣减", "¥" + money(s.refundAmount)],
              ["本期应结货款", "¥" + money(s.netAmount)],
              ["换货完成", (s.exchangeCount || 0) + " 笔 · 不扣款"],
            ].map(([title, value]) => (
              <Card key={title} size="small">
                <span className="statement-label">{title}</span>
                <strong>{value}</strong>
              </Card>
            ))}
          </div>
          <Alert
            type="info"
            style={{ marginBottom: 12 }}
            title={`${period.from} 至 ${period.to}（北京时间，含首尾日期）。按事件发生日期记账；退款扣在完成当期，跨期可能出现负应结金额。金额不代表已付款。`}
          />
          <Card>
            <Table<Row>
              rowKey="id"
              loading={result.isLoading}
              dataSource={result.data?.data || []}
              size="small"
              scroll={{ x: 1080 }}
              pagination={{
                current: page,
                pageSize: 20,
                total: result.data?.total,
                showSizeChanger: false,
                onChange: setPage,
              }}
              columns={[
                {
                  title: "记账时间",
                  render: (_, r) =>
                    new Date(r.occurredAt).toLocaleString("zh-CN", {
                      timeZone: "Asia/Shanghai",
                      hour12: false,
                    }),
                },
                {
                  title: "订单号",
                  render: (_, r) =>
                    !internal || canOrder ? (
                      <Link
                        to={
                          (internal
                            ? "/supply/procurement"
                            : "/supply/orders") +
                          "?order=" +
                          r.orderId
                        }
                      >
                        {r.orderNo}
                      </Link>
                    ) : (
                      r.orderNo
                    ),
                },
                ...(internal
                  ? [{ title: "供应商", dataIndex: "supplierName" }]
                  : []),
                { title: "售后单号", render: (_, r) => r.caseNo || "—" },
                {
                  title: "交易事项",
                  render: (_, r) => (
                    <Tag
                      color={
                        r.kind === "SALE"
                          ? "green"
                          : r.kind === "REFUND"
                            ? "orange"
                            : "blue"
                      }
                    >
                      {statementKinds[r.kind]}
                    </Tag>
                  ),
                },
                { title: "数量", dataIndex: "quantity" },
                {
                  title: "货款变动（元）",
                  align: "right",
                  render: (_, r) => (
                    <strong
                      style={{
                        color: r.kind === "REFUND" ? "#d4380d" : undefined,
                      }}
                    >
                      {money(r.amount)}
                    </strong>
                  ),
                },
              ]}
            />
          </Card>
        </>
      )}
    </>
  );
}
