import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Drawer,
  Input,
  Modal,
  Select,
  Space,
  Typography,
  Upload,
} from "antd";
import { UploadOutlined } from "@ant-design/icons";
import { api, queryClient } from "./api";
import { Table } from "./code-table";
import { when, type Row } from "./shared";
import { readWorkbook } from "./sheet-excel";
import {
  parseVipControlRows,
  vipControlExportTime,
  vipControlImportSchema,
  vipControlLimits,
  type VipControlRow,
} from "../../../packages/contracts/src/vip-control.js";

const controlColumns = [
  { title: "商品 ID", dataIndex: "productId", width: 210 },
  { title: "款号", dataIndex: "styleNo", width: 150 },
  { title: "货号", dataIndex: "articleNo", width: 165 },
  { title: "颜色", dataIndex: "color", width: 90 },
  {
    title: "管控问题类型",
    dataIndex: "issueType",
    width: 155,
    render: (value: string | null) => value || "未提供",
  },
  {
    title: "最后一次下架原因",
    dataIndex: "lastOffShelfReason",
    width: 350,
    render: (value: string | null) => value || "未提供",
  },
  { title: "导出时商品状态", dataIndex: "productStatus", width: 145 },
  { title: "商品名称", dataIndex: "productName", width: 280 },
];

export function VipControlPanel({
  connections,
  onClose,
}: {
  connections: Row[];
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [namespace, setNamespace] = useState<string | undefined>(
    connections.length === 1 ? connections[0].namespace : undefined,
  );
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [preview, setPreview] = useState<{
    fileName: string;
    rows: VipControlRow[];
  }>();
  const [exportTime, setExportTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const requestKey = useRef(crypto.randomUUID());
  const report = useQuery({
    queryKey: ["vip-control", namespace, page, q],
    queryFn: () =>
      api(
        `/integrations/vip/control?namespace=${encodeURIComponent(namespace!)}&page=${page}&pageSize=50&q=${encodeURIComponent(q)}`,
      ),
    enabled: !!namespace,
  });
  const data = report.data?.data;
  async function read(file: File) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setPreview(undefined);
    setError("");
    try {
      if (!/\.xlsx$/i.test(file.name))
        throw Error("请使用 VC 原始 .xlsx 导出文件");
      const sheets = await readWorkbook(file, {
        ...vipControlLimits,
        textOnlyColumns: ["商品ID", "货号", "款号"],
      });
      if (sheets.length !== 1) throw Error("请只保留一个商品数据工作表后导入");
      const records = parseVipControlRows(sheets[0].rows);
      const timestamp = vipControlExportTime(file.name);
      setExportTime(timestamp ? timestamp.slice(0, 19).replace("T", " ") : "");
      setPreview({ fileName: file.name, rows: records });
      requestKey.current = crypto.randomUUID();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (locked.current || !preview) return;
    const parsed = vipControlImportSchema.safeParse({
      namespace,
      ...preview,
      exportedAt: vipControlExportTime(exportTime),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    if (
      new TextEncoder().encode(JSON.stringify(parsed.data)).length >
      6 * 1024 * 1024
    ) {
      setError("导入内容过大，请拆分文件后重试");
      return;
    }
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await api(
        "/integrations/vip/control/import",
        "POST",
        parsed.data,
        requestKey.current,
      );
      const result = response.data;
      message.success(
        `已保存 ${result.saved} 条，重复 ${result.unchanged} 条，跳过较旧记录 ${result.stale} 条`,
      );
      setPreview(undefined);
      setImportOpen(false);
      setPage(1);
      setQ("");
      setSearch("");
      await queryClient.invalidateQueries({ queryKey: ["vip-control"] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <Drawer
      title="VC 管控资料"
      open
      onClose={onClose}
      size={1400}
      closable={!busy}
      keyboard={!busy}
      mask={{ closable: !busy }}
      styles={{ wrapper: { maxWidth: "100%" } }}
    >
      <Typography.Paragraph type="secondary">
        来源：VC
        商品列表导出表，按商品／货号保存，需重新导入文件才能更新。空白表示平台未提供；最后一次下架原因是历史记录，不代表当前仍被管控，也不代表所有尺码的状态。
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          aria-label="VC 资料供应商连接"
          placeholder="选择供应商连接"
          style={{ minWidth: 200 }}
          value={namespace}
          disabled={busy}
          options={connections.map((c) => ({
            value: c.namespace,
            label: `供应商 ${c.vendorId}`,
          }))}
          onChange={(value) => {
            setNamespace(value);
            setPage(1);
            requestKey.current = crypto.randomUUID();
          }}
        />
        <Input.Search
          aria-label="搜索 VC 管控资料"
          placeholder="商品 ID、款号、货号、类型或原因"
          style={{ width: 320 }}
          maxLength={100}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={(value) => {
            setQ(value);
            setPage(1);
          }}
          allowClear
        />
        <Button
          icon={<UploadOutlined />}
          disabled={!namespace}
          onClick={() => {
            setImportOpen(true);
            setPreview(undefined);
            setError("");
          }}
        >
          导入 VC 商品表
        </Button>
      </Space>
      {!namespace && (
        <Alert type="info" title="请选择导出文件所属的供应商连接" />
      )}
      {report.error && (
        <Alert
          type="error"
          title="读取 VC 资料失败"
          description={report.error.message}
        />
      )}
      {namespace && (
        <>
          <Typography.Paragraph>
            当前结果 {data?.total ?? 0} 条 · 已提供管控类型{" "}
            {data?.issueTypeProvided ?? 0} 条 · 已提供历史下架原因{" "}
            {data?.reasonProvided ?? 0} 条
          </Typography.Paragraph>
          <Table<Row>
            rowKey="productId"
            loading={report.isLoading}
            dataSource={data?.items ?? []}
            scroll={{ x: 2100, y: 560 }}
            pagination={{
              current: page,
              pageSize: 50,
              total: data?.total ?? 0,
              onChange: setPage,
              showSizeChanger: false,
            }}
            columns={[
              ...controlColumns,
              {
                title: "数据导出时间",
                dataIndex: "exportedAt",
                width: 190,
                render: when,
              },
              {
                title: "导入时间",
                dataIndex: "importedAt",
                width: 190,
                render: when,
              },
              { title: "来源文件", dataIndex: "fileName", width: 300 },
            ]}
          />
        </>
      )}
      <Modal
        title="导入 VC 商品管控资料"
        open={importOpen}
        width={1150}
        onCancel={() => {
          if (!busy) setImportOpen(false);
        }}
        closable={!busy}
        mask={{ closable: !busy }}
        keyboard={!busy}
        footer={
          <Space>
            <Button disabled={busy} onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button
              type="primary"
              loading={busy}
              disabled={
                !preview || !namespace || !vipControlExportTime(exportTime)
              }
              onClick={() => void save()}
            >
              确认导入
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph>
          导入到：供应商{" "}
          {connections.find((c) => c.namespace === namespace)?.vendorId}。 在 VC
          商品列表导出所需范围的商品表。每次最多 {vipControlLimits.maxRows} 条、
          {vipControlLimits.maxFileSizeMB}MB。
          确认后只更新文件内商品；较旧记录自动跳过，文件外商品保留。不会修改平台上下架、内部库存或价格。
        </Typography.Paragraph>
        <Upload
          accept=".xlsx"
          showUploadList={false}
          disabled={busy}
          beforeUpload={(file) => {
            void read(file);
            return false;
          }}
        >
          <Button icon={<UploadOutlined />} loading={busy}>
            选择 VC 导出文件
          </Button>
        </Upload>
        {error && (
          <Alert style={{ marginTop: 12 }} type="error" title={error} />
        )}
        {preview && (
          <>
            <Typography.Paragraph style={{ marginTop: 12 }}>
              {preview.fileName}
            </Typography.Paragraph>
            <Space wrap style={{ marginBottom: 12 }}>
              <label htmlFor="vc-export-time">数据导出时间（北京时间）</label>
              <Input
                id="vc-export-time"
                style={{ width: 230 }}
                value={exportTime}
                disabled={busy}
                placeholder="YYYY-MM-DD HH:mm:ss"
                maxLength={19}
                onChange={(e) => {
                  setExportTime(e.target.value);
                  requestKey.current = crypto.randomUUID();
                }}
              />
            </Space>
            <Alert
              type={preview.rows.some((r) => r.issueType) ? "info" : "warning"}
              title={`共 ${preview.rows.length} 条；管控类型有值 ${preview.rows.filter((r) => r.issueType).length} 条，历史下架原因有值 ${preview.rows.filter((r) => r.lastOffShelfReason).length} 条`}
              description="管控类型为空时保存为未提供，不根据历史下架原因生成当前管控类型。请确认供应商和导出时间。"
            />
            <Table<VipControlRow>
              style={{ marginTop: 12 }}
              rowKey="productId"
              size="small"
              dataSource={preview.rows}
              columns={controlColumns}
              scroll={{ x: 1550, y: 320 }}
              pagination={{ pageSize: 10, showSizeChanger: false }}
            />
          </>
        )}
      </Modal>
    </Drawer>
  );
}
