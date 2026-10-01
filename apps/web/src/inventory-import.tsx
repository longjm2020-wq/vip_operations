import { useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Modal,
  Select,
  Space,
  Typography,
  Upload,
} from "antd";
import { DownloadOutlined, InboxOutlined } from "@ant-design/icons";
import {
  inventoryImportFields,
  inventoryImportSchema,
  type InventoryImportInput,
} from "../../../packages/contracts/src/inventory-import";
import { api, queryClient } from "./api";
import { downloadWorkbook, readWorkbook } from "./sheet-excel";
import { options, useCan, useOptions } from "./shared";
type Entry = {
  line: number;
  input: InventoryImportInput;
  key: string;
  error?: string;
  uncertain?: boolean;
  saved?: boolean;
};
type Workbook = Awaited<ReturnType<typeof readWorkbook>>;
const normalize = (s: string) =>
  s
    .trim()
    .replace(/\s+/g, "")
    .replaceAll("（", "(")
    .replaceAll("）", ")")
    .toUpperCase();
const readonlyHeaders = [
  "图片",
  "款号",
  "商品名称",
  "供应商款式编码",
  "采购在途数",
  "在途数量",
  "调拨在途数",
  "进货仓库存",
  "可售天数",
  "补货建议",
  "可售库存",
  "锁定库存",
  "次品数量",
];
function parseRows(rows: string[][], warehouseId?: string) {
  const header = rows[0] || [],
    mapping = header.map((label) =>
      inventoryImportFields.find((f) =>
        [f.label, ...f.aliases].some(
          (alias) => normalize(alias) === normalize(label),
        ),
      ),
    );
  const unknown = header.filter(
    (label, i) =>
      label.trim() &&
      !mapping[i] &&
      !readonlyHeaders.some((k) => normalize(k) === normalize(label)),
  );
  if (unknown.length)
    throw Error("不支持的列：" + unknown.join("、") + "。请按模板列名填写。");
  if (!mapping.some((f) => f?.key === "skuCode"))
    throw Error("首行必须包含「商品编码」列（SKU 编码）。");
  const keys = mapping.filter(Boolean).map((f) => f!.key);
  if (new Set(keys).size !== keys.length)
    throw Error("有重复列名，请保留一列后重试。");
  const entries: Entry[] = [],
    seen = new Set<string>();
  const names = new Set<string>();
  if (rows.length > 501) throw Error("每次最多导入 500 行，请拆分文件。");
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].every((v) => !v.trim())) continue;
    const input: Record<string, any> = {
      changes: {},
      ...(warehouseId ? { warehouseId } : {}),
    };
    header.forEach((_, col) => {
      const field = mapping[col],
        value = String(rows[i][col] || "").trim();
      if (!field || !value) return;
      if (field.key === "skuCode" || field.key === "warehouse")
        input[field.key] = value;
      else {
        let v: string | number = value;
        if ("number" in field) {
          v = Number(value.replaceAll(",", "").replace(/%$/, ""));
          if (!Number.isFinite(v))
            throw Error(`第 ${i + 1} 行「${field.label}」必须是数字。`);
        }
        if (field.key === "reason")
          v =
            (
              {
                期初建账: "OPENING",
                盘点差异: "STOCKTAKE",
                人工调整: "MANUAL",
              } as Record<string, string>
            )[value] || value;
        if (
          field.key === "referenceDate" &&
          /^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(value)
        )
          v = value
            .split(/[/-]/)
            .map((v, i) => (i ? v.padStart(2, "0") : v))
            .join("-");
        input.changes[field.key] = v;
        names.add(field.label);
      }
    });
    const parsed = inventoryImportSchema.safeParse(input);
    if (!parsed.success)
      throw Error(
        `第 ${i + 1} 行：${parsed.error.issues.map((issue) => issue.message).join("；")}`,
      );
    const target =
      parsed.data.skuCode +
      "::" +
      (parsed.data.warehouse || parsed.data.warehouseId || "");
    if (seen.has(target))
      throw Error(`第 ${i + 1} 行重复出现相同商品编码与仓库，请合并成一行。`);
    seen.add(target);
    entries.push({ line: i + 1, input: parsed.data, key: crypto.randomUUID() });
  }
  if (!entries.length) throw Error("文件没有可导入的数据行。");
  return {
    entries,
    names: [...names],
    ignored: header.filter((label, i) => label.trim() && !mapping[i]),
  };
}
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
  const locked = useRef(false),
    attempted = useRef(false);
  const prepare = (data: Workbook, index: number, target?: string) => {
    setError("");
    setReport("");
    setEntries([]);
    try {
      const parsed = parseRows(data[index].rows, target);
      setEntries(parsed.entries);
      setFields(parsed.names);
      setIgnored(parsed.ignored);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const read = async (file: File) => {
    if (locked.current) return;
    setReading(true);
    setError("");
    setReport("");
    setEntries([]);
    setWorkbook([]);
    setFilename(file.name);
    attempted.current = false;
    try {
      const data = (await readWorkbook(file, { formattedCells: true })).filter(
        (s) => s.name !== "填写说明",
      );
      if (!data.length) throw Error("没有数据工作表。");
      setWorkbook(data);
      setSheet(0);
      prepare(data, 0, warehouse);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  };
  const save = async () => {
    if (locked.current || !entries.length) return;
    locked.current = true;
    attempted.current = true;
    setBusy(true);
    setError("");
    const updated = [...entries];
    let saved = entries.filter((e) => e.saved).length;
    try {
      for (let i = 0; i < updated.length; i++) {
        if (updated[i].saved) continue;
        try {
          await api(
            "/inventory/fulfilment/import-row",
            "POST",
            updated[i].input,
            updated[i].key,
          );
          updated[i] = {
            ...updated[i],
            saved: true,
            error: undefined,
            uncertain: false,
          };
          saved++;
        } catch (e) {
          const status = (e as Error & { status?: number }).status;
          updated[i] = {
            ...updated[i],
            error: (e as Error).message,
            uncertain: !status || status >= 500,
          };
        }
        setEntries([...updated]);
      }
      const failed = updated.length - saved;
      setReport(
        `导入成功 ${saved} 行，失败 ${failed} 行。${failed ? "重试仅提交失败行。修正文件重新导入时，请仅保留失败行。" : ""}`,
      );
      await queryClient.invalidateQueries();
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const hasPending = entries.some((e) => !e.saved);
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
            {attempted.current && hasPending ? "重试失败行" : "确认导入"}
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
                inventoryImportFields.map((f) => ({
                  key: f.key,
                  label: f.label,
                  required: "required" in f && f.required,
                })),
                [],
                [
                  "商品编码使用内部 SKU 编码；仅修改已有资料，不会创建 SKU。",
                  "首行保留列名，可删除不需要修改的列；空白单元格保留原值。",
                  "上传后点击确认导入才保存；编码、条码请使用文本格式，公式请粘贴为值。",
                  "在仓库存数为调整后的绝对数量，变化数量为增减数量，两者每行只能填一项；修改库存必须填写仓库或选择导入仓库。",
                  "颜色、尺码和货号按 SKU 更新；日销、退货率、预估销退仅为人工参考。退货率填写百分数，如 1.5 或 1.5%。",
                  "新参考记录默认来源为 Excel 导入（人工维护）及导入当天日期；现有记录未提供的参考字段保持原值。",
                  "采购在途、调拨在途、进货仓及可售天数等只读列不会修改。每个文件最多 500 行。",
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
        商品编码按 SKU
        编码精确匹配；空白单元格保留原值。颜色、尺码和条码修改需要商品编辑权限。库存或经营参考修改需要库存调整权限。
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
          支持 .xlsx、UTF-8 CSV，最多 5MB / 500 行；.xls 请另存为 .xlsx。
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
          只读列将保留原值：{ignored.join("、")}
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
      {entries.some((e) => e.error) && (
        <div style={{ maxHeight: 140, overflow: "auto", marginTop: 8 }}>
          {entries
            .filter((e) => e.error)
            .map((e) => (
              <div key={e.key}>
                第 {e.line} 行 · {e.input.skuCode}：{e.error}
              </div>
            ))}
        </div>
      )}
    </Modal>
  );
}
