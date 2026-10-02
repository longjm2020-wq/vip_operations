import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from "antd";
import {
  MailOutlined,
  ReloadOutlined,
  SearchOutlined,
  UploadOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api, queryClient } from "./api";
import { CompassAIReport } from "./compass-ai";
import { CompassTrend } from "./compass-charts";
import { CompassDetailTable } from "./compass-detail-table";
import { CompassDateFilter } from "./compass-date-filter";
import { Header, QueryState, Row, useCan } from "./shared";
import {
  compassDimensions,
  CompassDimension,
  compassLabels,
  CompassRecord,
  CompassPeriod,
  CompassDateRange,
} from "../../../packages/contracts/src/compass-analytics";
import "./compass-analytics.css";
const number = (value: any) =>
  value == null
    ? "—"
    : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const money = (value: any) => (value == null ? "—" : "¥ " + number(value));
const percent = (value: any) =>
  value == null ? "—" : (Number(value) * 100).toFixed(2) + "%";
const mailState: Record<string, string> = {
  ACCEPTED: "邮件服务器已接收",
  FAILED: "发送失败",
  UNKNOWN: "发送结果待核实",
  SENDING: "发送中",
};

function ImportReports({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [phase, setPhase] = useState(""),
    [error, setError] = useState(""),
    [results, setResults] = useState<string[]>([]);
  const workerRef = useRef<Worker | null>(null);
  useEffect(() => () => workerRef.current?.terminate(), []);
  async function read(file: File): Promise<{
    fileHash: string;
    report: {
      dimension: CompassDimension;
      startDate: string;
      endDate: string;
      records: CompassRecord[];
    };
  }> {
    const worker = new Worker(
      new URL("./compass-import-worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;
    return new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        worker.terminate();
        workerRef.current = null;
        if (e.data.error) reject(Error(e.data.error));
        else resolve(e.data);
      };
      worker.onerror = () => {
        worker.terminate();
        workerRef.current = null;
        reject(Error("报表解析未完成，请重试或关闭其他占用内存的页面"));
      };
      worker.postMessage(file);
    });
  }
  const importFiles = async (files: File[]) => {
    if (busy || !files.length) return;
    setBusy(true);
    setError("");
    setResults([]);
    setProgress(0);
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        setPhase(`解析 ${index + 1}/${files.length}：${file.name}`);
        const { report, fileHash } = await read(file),
          rows = report.records;
        const task = (
          await api("/analytics/compass/imports", "POST", {
            dimension: report.dimension,
            fileName: file.name,
            fileHash,
            startDate: report.startDate,
            endDate: report.endDate,
            expectedRows: rows.length,
          })
        ).data;
        if (task.status !== "COMPLETE") {
          for (let start = 0; start < rows.length; start += 1000) {
            await api(
              `/analytics/compass/imports/${task.id}/chunks`,
              "POST",
              { records: rows.slice(start, start + 1000) },
              `compass-${fileHash}-${start}`,
            );
            setProgress(
              Math.round(
                (100 *
                  (index + Math.min(rows.length, start + 1000) / rows.length)) /
                  files.length,
              ),
            );
            setPhase(
              `上传${compassLabels[report.dimension]}报表：${number(Math.min(rows.length, start + 1000))} / ${number(rows.length)} 行`,
            );
          }
          await api(
            `/analytics/compass/imports/${task.id}/finish`,
            "POST",
            {},
            `compass-finish-${fileHash}`,
          );
        }
        setResults((old) => [
          ...old,
          `${compassLabels[report.dimension]}：${number(rows.length)} 行 · ${report.startDate} 至 ${report.endDate}`,
        ]);
        onImported();
      }
      setProgress(100);
      setPhase("报表导入完成，面板已更新");
    } catch (e) {
      setError((e as Error).message);
      setPhase("导入未完成，已上传批次保留，可重选原始文件继续");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="导入魔方罗盘报表"
      open={open}
      onCancel={() => !busy && onClose()}
      closable={!busy}
      maskClosable={!busy}
      footer={
        <Button disabled={busy} onClick={onClose}>
          关闭
        </Button>
      }
      width={680}
    >
      <p>
        选择下载中心的「按款号（近30天）」「按货号（近30天）」「按条码（近30天）」原始
        Excel，可一次选择三张。
      </p>
      <div
        className="compass-upload"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void importFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <UploadOutlined />
        <p>选择或拖入报表</p>
        <input
          aria-label="选择罗盘报表文件"
          type="file"
          accept=".xlsx,.csv"
          multiple
          disabled={busy}
          onChange={(e) => {
            void importFiles(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
        <p className="secondary">
          每张最多 100MB / 200000 行；日期、编码和平台 ID 保留原始值。
        </p>
      </div>
      {phase && <p aria-live="polite">{phase}</p>}
      {busy && <Progress percent={progress} status="active" />}
      {results.map((v) => (
        <Alert key={v} type="success" title={v} style={{ marginTop: 8 }} />
      ))}
      {error && <Alert type="error" showIcon title={error} />}
      <p className="secondary">
        完整上传后才替换对应维度的报表。重复文件不会重复累计；未完成的上传不影响当前面板。平台数据不会修改内部库存。
      </p>
    </Modal>
  );
}
function MailSettings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [form] = Form.useForm(),
    [busy, setBusy] = useState(false),
    { message } = App.useApp();
  const q = useQuery({
    queryKey: ["compass-mail-settings"],
    queryFn: () => api("/analytics/compass/mail-settings"),
    enabled: open,
  });
  const history = useQuery({
    queryKey: ["compass-mail-history"],
    queryFn: () => api("/analytics/compass/mail-history"),
    enabled: open,
  });
  useEffect(() => {
    if (q.data?.data && open)
      form.setFieldsValue({
        ...q.data.data,
        recipients: q.data.data.recipients.join(", "),
        password: "",
      });
  }, [q.data, open, form]);
  const settings = q.data?.data;
  const save = async (values: Row) => {
    setBusy(true);
    try {
      await api("/analytics/compass/mail-settings", "POST", {
        ...values,
        smtpPort: Number(values.smtpPort),
        recipients: values.recipients.split(/[,，;；\s]+/).filter(Boolean),
      });
      if (values.password || settings?.passwordConfigured) {
        await api("/analytics/compass/mail-test", "POST", {});
        message.success("发件配置验证通过");
      } else message.success("配置已保存，填写授权码后可验证发件");
      await q.refetch();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    setBusy(true);
    try {
      const result = (await api("/analytics/compass/send-daily", "POST", {}))
        .data;
      if (result.state === "COMPLETE")
        message.success("今日邮件任务已处理，请在记录中查看各邮箱状态");
      else
        message.warning(result.message || "部分邮箱需要处理，请查看发送记录");
      await history.refetch();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      title="每日分析邮件"
      onCancel={() => !busy && onClose()}
      footer={null}
      width={720}
      destroyOnHidden
    >
      <QueryState error={q.error} reload={() => q.refetch()} />
      <p>
        每天
        08:00（北京时间）采集，三张报表更新到昨日后发送日报。支持多个收件邮箱，每个地址单独发送。
      </p>
      <p className="secondary">
        本机 Chrome 和 Codex
        需在线并保持罗盘登录。平台尚未生成完整报表时等待更新，不发送旧数据。
      </p>
      {settings && !settings.encryptionReady && (
        <Alert
          type="warning"
          title="服务器邮件加密密钥待配置，暂时不能保存授权码"
        />
      )}
      <Form
        form={form}
        layout="vertical"
        onFinish={save}
        initialValues={{
          enabled: false,
          smtpHost: "smtp.qq.com",
          smtpPort: 465,
          smtpUser: "",
          fromEmail: "",
          recipients: "",
        }}
      >
        <Form.Item
          name="recipients"
          label="收件邮箱"
          rules={[{ required: true }]}
        >
          <Input.TextArea placeholder="多个邮箱用逗号分隔" rows={2} />
        </Form.Item>
        <div className="compass-form-grid">
          <Form.Item
            name="smtpUser"
            label="SMTP 账号"
            rules={[{ required: true, type: "email" }]}
          >
            <Input placeholder="QQ 邮箱" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="fromEmail"
            label="发件邮箱"
            rules={[{ required: true, type: "email" }]}
          >
            <Input placeholder="与 SMTP 账号一致" />
          </Form.Item>
          <Form.Item
            name="smtpHost"
            label="SMTP 服务器"
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="smtpPort" label="加密端口">
            <Select
              options={[
                { value: 465, label: "465 · TLS" },
                { value: 587, label: "587 · STARTTLS" },
              ]}
            />
          </Form.Item>
        </div>
        <Form.Item
          name="password"
          label="SMTP 授权码"
          extra={
            settings?.passwordConfigured
              ? "已安全保存；留空保留原授权码。修改发件账号时请重新填写。"
              : "QQ 邮箱需先开启 SMTP，并填写授权码；请勿填写邮箱登录密码。"
          }
        >
          <Input.Password
            autoComplete="new-password"
            placeholder={
              settings?.passwordConfigured
                ? "已配置，留空保留"
                : "输入邮箱授权码"
            }
          />
        </Form.Item>
        <Form.Item name="enabled" label="开启每日邮件" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Space>
          <Button htmlType="submit" type="primary" loading={busy}>
            保存并验证
          </Button>
          <Button
            icon={<MailOutlined aria-hidden="true" />}
            disabled={busy || !settings?.enabled || !settings?.verifiedAt}
            onClick={send}
          >
            发送今日报告
          </Button>
          <Tag color={settings?.verifiedAt ? "green" : "default"}>
            {settings?.verifiedAt ? "发件配置已验证" : "发件配置待验证"}
          </Tag>
        </Space>
      </Form>
      <h3>最近发送记录</h3>
      <Table<Row>
        size="small"
        rowKey={(r) => r.reportDate + r.recipient}
        pagination={false}
        dataSource={history.data?.data || []}
        scroll={{ y: 180, x: 600 }}
        columns={[
          { title: "数据日期", dataIndex: "reportDate", width: 115 },
          { title: "邮箱", dataIndex: "recipient", width: 210 },
          {
            title: "状态",
            render: (_, r) => (
              <Tooltip title={r.errorNote}>
                {mailState[r.status] || r.status}
              </Tooltip>
            ),
            width: 175,
          },
          {
            title: "时间",
            render: (_, r) =>
              r.sentAt ? new Date(r.sentAt).toLocaleString("zh-CN") : "—",
            width: 180,
          },
        ]}
      />
    </Modal>
  );
}
export function CompassAnalyticsPage() {
  const manage = useCan("analytics.manage"),
    [dimension, setDimension] = useState<CompassDimension>("style"),
    [period, setPeriod] = useState<CompassPeriod>("recent:7"),
    [dateRange, setDateRange] = useState<CompassDateRange | null>(null),
    [search, setSearch] = useState(""),
    [qText, setQText] = useState(""),
    [styleNo, setStyleNo] = useState(""),
    [articleNo, setArticleNo] = useState(""),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(20),
    [sort, setSort] = useState("salesAmount"),
    [importOpen, setImportOpen] = useState(false),
    [mailOpen, setMailOpen] = useState(false),
    [aiOpen, setAIOpen] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQText(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const q = useQuery({
    queryKey: [
      "compass-dashboard",
      dimension,
      period,
      dateRange,
      qText,
      styleNo,
      articleNo,
      page,
      pageSize,
      sort,
    ],
    queryFn: () =>
      api(
        "/analytics/compass?" +
          new URLSearchParams({
            dimension,
            days: period.startsWith("recent:") ? period.slice(7) : "7",
            ...(dateRange
              ? { startDate: dateRange[0], endDate: dateRange[1] }
              : {}),
            q: qText,
            styleNo,
            articleNo,
            page: String(page),
            pageSize: String(pageSize),
            sort,
          }),
      ),
    staleTime: 30000,
  });
  const data = q.data?.data,
    summary = data?.summary || {},
    top: Row[] = data?.top || [],
    sources: Row[] = data?.sources || [];
  const changeDimension = (value: string) => {
    setDimension(value as CompassDimension);
    if (
      value === "barcode" &&
      ["exposure", "detailViews", "clickRate", "conversionRate"].includes(sort)
    )
      setSort("salesAmount");
    setPage(1);
  };
  const drill = (row: Row) => {
    if (dimension === "style") {
      setStyleNo(row.code);
      setArticleNo("");
      changeDimension("article");
    } else if (dimension === "article") {
      setArticleNo(row.code);
      changeDimension("barcode");
    } else setSearch(row.code);
  };
  const coverage = data?.summary?.coveredDays;
  return (
    <div className="compass-page">
      <Header
        title="经营分析"
        subtitle="唯品会 · 魔方罗盘"
        extra={
          <>
            <Button
              icon={<ReloadOutlined aria-hidden="true" />}
              onClick={() => {
                void q.refetch();
                void queryClient.invalidateQueries({
                  queryKey: ["compass-ai-report"],
                });
              }}
              loading={q.isFetching}
            >
              刷新
            </Button>
            {manage && (
              <>
                <Button
                  icon={<UploadOutlined aria-hidden="true" />}
                  onClick={() => setImportOpen(true)}
                >
                  导入报表
                </Button>
              </>
            )}
            <Button
              icon={<RobotOutlined aria-hidden="true" />}
              onClick={() => setAIOpen(true)}
            >
              AI 经营分析
            </Button>
            {manage && (
              <Button
                icon={<MailOutlined aria-hidden="true" />}
                onClick={() => setMailOpen(true)}
              >
                每日邮件
              </Button>
            )}
          </>
        }
      />
      <div className="compass-toolbar">
        <CompassDateFilter
          period={period}
          range={dateRange}
          sourceEnd={
            sources.find((source) => source.dimension === dimension)?.endDate
          }
          onChange={(value, range) => {
            setPeriod(value);
            setDateRange(range);
            setPage(1);
          }}
        />
        <Input
          aria-label="搜索款号货号条码"
          prefix={<SearchOutlined />}
          placeholder="搜索款号 / 货号 / 条码"
          value={search}
          allowClear
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 290 }}
        />
      </div>
      <Tabs
        activeKey={dimension}
        onChange={changeDimension}
        items={compassDimensions.map((key) => ({
          key,
          label: `按${compassLabels[key]}分析`,
        }))}
      />
      {(styleNo || articleNo) && (
        <div className="compass-drill">
          <span>分析范围</span>
          {styleNo && (
            <Tag
              closable
              onClose={() => {
                setStyleNo("");
                setPage(1);
              }}
            >
              款号 {styleNo}
            </Tag>
          )}
          {articleNo && (
            <Tag
              closable
              onClose={() => {
                setArticleNo("");
                setPage(1);
              }}
            >
              货号 {articleNo}
            </Tag>
          )}
          <Button
            type="link"
            onClick={() => {
              setStyleNo("");
              setArticleNo("");
              setSearch("");
              setPage(1);
            }}
          >
            查看全部
          </Button>
        </div>
      )}
      <QueryState error={q.error} reload={() => q.refetch()} />
      {q.isLoading ? (
        <Spin />
      ) : data?.empty ? (
        <Card>
          <Empty description={`尚未导入${compassLabels[dimension]}报表`}>
            {manage && (
              <Button type="primary" onClick={() => setImportOpen(true)}>
                导入罗盘报表
              </Button>
            )}
          </Empty>
        </Card>
      ) : (
        data && (
          <>
            <p className="compass-period">
              {data.startDate} — {data.endDate} · {number(summary.entities)} 个
              {compassLabels[dimension]}
              {data.stale && <Tag color="orange">报表尚未更新至昨日</Tag>}
              {(!data.complete || coverage !== data.days) && (
                <>
                  <Tag color="orange">
                    日期覆盖不足：{coverage || 0}/{data.days} 天
                  </Tag>
                  <span>
                    报表覆盖 {data.source.startDate} — {data.source.endDate}
                  </span>
                </>
              )}
            </p>
            <div className="compass-kpis">
              {[
                {
                  label: "销售额",
                  value: money(summary.salesAmount),
                  note: "报表成交金额",
                },
                {
                  label: "净销售额",
                  value: money(summary.netSalesAmount),
                  note: "报表不含拒退金额",
                },
                {
                  label: "销售件数",
                  value: number(summary.salesQty),
                  note: `净销售 ${number(summary.netSalesQty)} 件`,
                },
                {
                  label: "期间退货率",
                  value: percent(summary.returnRate),
                  note: `退货 ${number(summary.returnsQty)} 件 · ${money(summary.returnsAmount)}`,
                },
                {
                  label: "可售库存",
                  value: number(summary.saleableStock),
                  note: `${data.endDate} 平台库存快照`,
                },
              ].map((k) => (
                <Card key={k.label}>
                  <span className="secondary">{k.label}</span>
                  <strong>{k.value}</strong>
                  <small>{k.note}</small>
                </Card>
              ))}
            </div>
            <div className="compass-charts">
              <Card title="每日销售趋势">
                <CompassTrend data={data.daily} />
              </Card>
              <Card
                title={`销售额 TOP 10 · ${compassLabels[dimension]}`}
                extra={<span className="secondary">点击查看明细</span>}
              >
                <div className="compass-ranks">
                  {top.length ? (
                    top.map((r, i) => (
                      <button
                        key={r.code}
                        onClick={() => drill(r)}
                        title={`查看 ${r.code}`}
                      >
                        <span className="compass-rank-number">{i + 1}</span>
                        <span className="compass-rank-code">{r.code}</span>
                        <span className="compass-rank-bar">
                          <i
                            style={{
                              width: `${Math.max(1, (Number(r.salesAmount) / Math.max(1, Number(top[0].salesAmount))) * 100)}%`,
                            }}
                          />
                        </span>
                        <b>{money(r.salesAmount)}</b>
                      </button>
                    ))
                  ) : (
                    <Empty description="暂无排行" />
                  )}
                </div>
              </Card>
            </div>
            {dimension !== "barcode" && (
              <div className="compass-traffic">
                <span>
                  累计曝光 UV <b>{number(summary.exposure)}</b>
                </span>
                <span>
                  累计商详 UV <b>{number(summary.detailViews)}</b>
                </span>
                <span>
                  点击率 <b>{percent(summary.clickRate)}</b>
                </span>
                <span>
                  累计客户数 <b>{number(summary.customers)}</b>
                </span>
                <span>
                  购买转化率 <b>{percent(summary.conversionRate)}</b>
                </span>
                <Tooltip title="UV、收藏、加购及客户数由每日指标累计，跨日未去重">
                  <span className="secondary">按每日累计口径</span>
                </Tooltip>
              </div>
            )}
            <CompassDetailTable
              dimension={dimension}
              data={data}
              loading={q.isFetching}
              page={page}
              pageSize={pageSize}
              sort={sort}
              onPage={(nextPage, nextSize) => {
                setPage(nextSize === pageSize ? nextPage : 1);
                setPageSize(nextSize);
              }}
              onSort={(value) => {
                setSort(value);
                setPage(1);
              }}
              onDrill={drill}
            />
            <details className="compass-notes">
              <summary>数据来源与计算口径</summary>
              <p>
                三张报表独立统计；销售与退货按日期累计，库存仅使用截止日快照。跨日
                UV 和客户数未去重。期间退货率为退货件数 / 销售量，可能超过
                100%，不代表同批订单的退货率；条码报表没有曝光、商详 UV 指标。
              </p>
              {sources.map((s) => (
                <p key={s.dimension}>
                  {compassLabels[s.dimension as CompassDimension]}：{s.fileName}{" "}
                  · {number(s.expectedRows)} 行 · 更新时间{" "}
                  {new Date(s.completedAt).toLocaleString("zh-CN")}
                </p>
              ))}
            </details>
          </>
        )
      )}
      <CompassAIReport
        manage={manage}
        sourceKey={sources.map((s) => s.id).join(":")}
        open={aiOpen}
        onClose={() => setAIOpen(false)}
      />
      <ImportReports
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void q.refetch()}
      />
      {manage && (
        <>
          <MailSettings open={mailOpen} onClose={() => setMailOpen(false)} />
        </>
      )}
    </div>
  );
}
