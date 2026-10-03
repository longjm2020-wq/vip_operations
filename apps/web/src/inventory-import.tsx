import { useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Modal,
  Progress,
  Select,
  Space,
  Typography,
  Upload,
} from "antd";
import { DownloadOutlined, InboxOutlined } from "@ant-design/icons";
import {
  inventoryImportFields,
  inventoryImportLimits,
} from "../../../packages/contracts/src/inventory-import";
import { api, queryClient } from "./api";
import { downloadWorkbook, readWorkbook } from "./sheet-excel";
import { options, useCan, useOptions } from "./shared";
import {
  parseInventoryRows,
  importInventoryRows,
  type Entry,
  type ImportProgress,
} from "./inventory-import-data";
type Workbook = Awaited<ReturnType<typeof readWorkbook>>;
export function InventoryImport({
  warehouseId: initialWarehouse,
  onClose,
}: {
  warehouseId?: string;
  onClose: () => void;
}) {
  const { message, modal } = App.useApp(),
    canStock = useCan("inventory.adjust"),
    canWarehouse = useCan("warehouse.read"),
    warehouses = useOptions("/warehouses", canStock && canWarehouse);
  const [warehouse, setWarehouse] = useState(initialWarehouse),
    [workbook, setWorkbook] = useState<Workbook>([]),
    [sheet, setSheet] = useState(0);
  const [entries, setEntries] = useState<Entry[]>([]),
    [fields, setFields] = useState<string[]>([]),
    [ignored, setIgnored] = useState<string[]>([]);
  const [filename, setFilename] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reading, setReading] = useState(false),
    [templateBusy, setTemplateBusy] = useState(false),
    [report, setReport] = useState("");
  const [progress, setProgress] = useState<ImportProgress>();
  const locked = useRef(false),
    attempted = useRef(false);
  const prepare = (data: Workbook, index: number, target?: string) => {
    setError("");
    setReport("");
    setProgress(undefined);
    setEntries([]);
    try {
      const parsed = parseInventoryRows(data[index].rows, target);
      setEntries(parsed.entries);
      setFields(parsed.names);
      setIgnored(parsed.ignored);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const read = async (file: File) => {
    if (locked.current) return;
    locked.current = true;
    setReading(true);
    setError("");
    setReport("");
    setEntries([]);
    setWorkbook([]);
    setFilename(file.name);
    attempted.current = false;
    try {
      const data = (
        await readWorkbook(file, {
          formattedCells: true,
          ...inventoryImportLimits,
        })
      ).filter((s) => s.name !== "填写说明");
      if (!data.length) throw Error("没有数据工作表。");
      setWorkbook(data);
      setSheet(0);
      prepare(data, 0, warehouse);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      locked.current = false;
      setReading(false);
    }
  };
  const save = async () => {
    if (locked.current || !entries.length) return;
    const missing = entries.find(
      (e) =>
        !e.saved &&
        (e.input.changes.physicalQty !== undefined ||
          e.input.changes.quantity !== undefined) &&
        !e.input.warehouse &&
        !e.input.warehouseId,
    );
    if (missing) {
      setError(`第 ${missing.line} 行：修改库存需填写仓库列或选择导入仓库`);
      return;
    }
    locked.current = true;
    attempted.current = true;
    setBusy(true);
    setError("");
    const started = performance.now();
    try {
      const updated = await importInventoryRows(
        entries,
        async (batch) =>
          (
            await api("/inventory/fulfilment/import-batch", "POST", {
              rows: batch.map(({ key, input }) => ({ key, input })),
            })
          ).data.results,
        setProgress,
      );
      setEntries(updated);
      const saved = updated.filter((e) => e.saved).length,
        failed = updated.length - saved;
      setReport(
        `导入成功 ${saved} 行，失败 ${failed} 行。本次保存用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒。${failed ? "重试仅提交失败行。修正文件重新导入时，请仅保留失败行。" : ""}`,
      );
      await queryClient.invalidateQueries();
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const hasPending = entries.some((e) => !e.saved);
  const failures = entries.filter((e) => e.error);
  const close = () => {
    if (busy || reading) return;
    if (entries.some((e) => e.uncertain))
      modal.confirm({
        title: "有行的保存结果尚未确认",
        content: "请先重试失败行以核对原请求。关闭后重新导入可能重复调整库存。",
        okText: "关闭卡片",
        cancelText: "继续重试",
        onOk: onClose,
      });
    else onClose();
  };
  return (
    <Modal
      title="从 Excel 导入库存资料"
      open
      width={640}
      onCancel={close}
      closable={!busy && !reading}
      mask={{ closable: !busy && !reading }}
      keyboard={!busy && !reading}
      footer={
        <Space>
          <Button disabled={busy || reading} onClick={close}>
            关闭
          </Button>
          <Button
            type="primary"
            loading={busy}
            disabled={!hasPending || !!error || reading}
            onClick={save}
          >
            {busy
              ? "正在导入"
              : attempted.current && hasPending
                ? "重试失败行"
                : "确认导入"}
          </Button>
        </Space>
      }
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          marginBottom: 16,
          padding: 12,
          background: "#fff5eb",
          borderRadius: 6,
        }}
      >
        <Typography.Text>
          导入修改已有资料时，可仅保留［商品编码］和需要修改的列。例如改颜色，表中仅保留［商品编码］［颜色］两列。
        </Typography.Text>
        <Button
          aria-label="下载模板"
          style={{ flexShrink: 0 }}
          icon={<DownloadOutlined />}
          loading={templateBusy}
          disabled={busy}
          onClick={async () => {
            setTemplateBusy(true);
            try {
              await downloadWorkbook(
                "库存资料导入模板",
                [
                  { key: "mainImageUrl", label: "图片" },
                  { key: "styleNo", label: "款号" },
                  ...[
                    "articleNo",
                    "skuCode",
                    "colorName",
                    "sizeName",
                    "physicalQty",
                    "dailySales",
                    "returnRatePercent",
                    "estimatedReturns",
                    "warehouse",
                  ].map((key) =>
                    inventoryImportFields.find((f) => f.key === key)!,
                  ),
                ].map((f) => ({
                  key: f.key,
                  label: f.label,
                  required: "required" in f && f.required,
                })),
                [],
                [
                  "商品编码使用内部 SKU 编码；未建档商品首次导入需填写款号、颜色和尺码，需要商品新建权限。新款默认归入导入待分类，可在商品档案完善品类。",
                  "首行保留列名，可删除不需要修改的列；空白单元格保留原值。",
                  "上传后点击确认导入才保存；编码、条码请使用文本格式，公式请粘贴为值。",
                  "在仓库存数为调整后的绝对数量，变化数量为增减数量，两者每行只能填一项；修改库存必须填写仓库或选择导入仓库。",
                  "颜色、尺码和货号按 SKU 更新；此处填写的日销、退货率和预估销退为人工备用参考。库存查询优先使用罗盘条码报表计算结果。退货率填写百分数，如 1.5 或 1.5%。",
                  "新参考记录默认来源为 Excel 导入（人工维护）及导入当天日期；现有记录未提供的参考字段保持原值。",
                  `采购在途、调拨在途、进货仓及可售天数等只读列不会修改。单个文件最多 ${inventoryImportLimits.maxFileSizeMB}MB，每次最多 ${inventoryImportLimits.maxRows} 数据行（不含表头）。`,
                ],
              );
            } catch (e) {
              message.error((e as Error).message);
            } finally {
              setTemplateBusy(false);
            }
          }}
        >
          下载模板
        </Button>
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        已有商品按编码更新，空白单元格保留原值。首次导入需款号、颜色、尺码及商品新建权限，新款归入「导入待分类」。图片（链接）、款号、商品名称、供应商款式编码仅用于新款建档。修改资料需商品编辑权限，修改库存或参考值需库存调整权限。
      </Typography.Paragraph>
      {canStock && (
        <Space style={{ marginBottom: 12 }}>
          导入仓库
          <Select
            aria-label="导入仓库"
            style={{ width: 200 }}
            placeholder="修改库存时选择"
            allowClear
            options={options(warehouses.data)}
            value={warehouse}
            disabled={busy || reading || attempted.current}
            onChange={(value) => {
              setWarehouse(value);
              if (workbook.length) prepare(workbook, sheet, value);
            }}
          />
        </Space>
      )}
      <Upload.Dragger
        accept=".xlsx,.csv"
        multiple={false}
        showUploadList={false}
        disabled={busy || reading || (attempted.current && hasPending)}
        beforeUpload={(file) => {
          void read(file);
          return false;
        }}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p>{reading ? "正在读取文件…" : "点击或拖拽 Excel 文件到这里上传"}</p>
        <p className="ant-upload-hint">
          支持 .xlsx、UTF-8 CSV，最多 {inventoryImportLimits.maxFileSizeMB}MB /{" "}
          {inventoryImportLimits.maxRows} 行；.xls 请另存为 .xlsx。
        </p>
      </Upload.Dragger>
      {filename && (
        <Typography.Paragraph style={{ marginTop: 12, marginBottom: 8 }}>
          文件：{filename}
        </Typography.Paragraph>
      )}
      {workbook.length > 1 && (
        <Select
          aria-label="数据工作表"
          value={sheet}
          options={workbook.map((s, index) => ({
            value: index,
            label: s.name,
          }))}
          disabled={busy || attempted.current}
          onChange={(index) => {
            setSheet(index);
            prepare(workbook, index, warehouse);
          }}
        />
      )}
      {!!entries.length && (
        <Typography.Paragraph type="secondary">
          共 {entries.length} 行，更新列：{fields.join("、")}
        </Typography.Paragraph>
      )}
      {!!ignored.length && (
        <Typography.Paragraph type="secondary">
          已有资料保留原值（新款可用于建档）：{ignored.join("、")}
        </Typography.Paragraph>
      )}
      {error && <Alert type="error" title={error} showIcon />}
      {report && (
        <Alert
          type={hasPending ? "warning" : "success"}
          title={report}
          showIcon
        />
      )}
      {busy && progress && (
        <div style={{ marginTop: 12 }}>
          <Progress
            percent={Number(
              ((progress.completed / progress.total) * 100).toFixed(1),
            )}
          />
          <Typography.Text type="secondary">
            正在导入：{progress.completed} / {progress.total} 行，成功{" "}
            {progress.saved} 行，失败 {progress.failed} 行
          </Typography.Text>
          {progress.firstError && (
            <Alert type="warning" title={progress.firstError} showIcon />
          )}
        </div>
      )}
      {!busy && !!failures.length && (
        <div style={{ maxHeight: 140, overflow: "auto", marginTop: 8 }}>
          {failures.slice(0, 100).map((e) => (
            <div key={e.key}>
              第 {e.line} 行 · {e.input.skuCode}：{e.error}
            </div>
          ))}
          {failures.length > 100 && (
            <Typography.Text type="secondary">
              共 {failures.length} 行失败，仅显示前 100
              条；重试会处理全部失败行。
            </Typography.Text>
          )}
        </div>
      )}
    </Modal>
  );
}
