import { Alert, App, Button, Modal, Progress, Space, Table, Typography, Upload } from "antd";
import { DownloadOutlined, ImportOutlined, InboxOutlined } from "@ant-design/icons";
import { useRef, useState } from "react";
import { api, queryClient } from "./api";
import { downloadWorkbook, readWorkbook, type EmbeddedImage } from "./sheet-excel";
import { prepareUpload, readUpload } from "./upload-file";
import { importInventoryRows, type Entry, type ImportProgress } from "./inventory-import-data";
import { inventoryImportLimits } from "../../../packages/contracts/src/inventory-import";
import { inventoryImageBatchSize, type InventoryImageBatchResult } from "../../../packages/contracts/src/inventory-image";
import {
  inventorySkuImageTargets,
  inventorySkuMaxRows,
  inventorySkuTemplate,
  inventorySkuTemplateLabel,
  parseInventorySkuRows,
  type InventorySkuEntry,
} from "../../../packages/contracts/src/inventory-sku-import";

const templateNotes = [
  "首行保留列名，列顺序可调整；带「必填」的列每行都必须填写。编码、条码请使用文本格式，公式请粘贴为值。",
  "图片（选填）：可填写 https 图片链接，或把图片插入到该行的图片单元格内（浮动图片，左上角放在该单元格）。图片按款号+颜色保存，同款同色只取第一张；唯品会已有图片时仍优先显示唯品会图片。",
  "商品编码未建档：新增 SKU；款号未建档时同时新建款号（归入「导入待分类」），需商品新建权限。",
  "商品编码已建档：更新颜色、尺码和货号（需商品编辑及库存调整权限）；款号必须与档案一致，供应商款式编码与档案不一致时该行失败，已建档款号的款号、供应商款式编码请在商品档案修改。",
  "上传后先预览校验，全部行通过后点击「确认导入」才保存；不会修改库存数量。",
  `每次最多 ${inventorySkuMaxRows} 行、${inventoryImportLimits.maxFileSizeMB}MB；支持 .xlsx 和 UTF-8 CSV（CSV 不含图片）。`,
];

type Parsed = { entries: InventorySkuEntry[]; errors: string[]; images: Record<number, EmbeddedImage> };

/** 「导入SKU」: template download, full-file validation preview, then save
 * through the existing inventory import endpoint and attach row pictures. */
export function InventorySkuImport({ onDone }: { onDone: () => void }) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState("");
  const [parsed, setParsed] = useState<Parsed>();
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [report, setReport] = useState("");
  const [imageReport, setImageReport] = useState<string[]>([]);
  const lock = useRef(false);
  const reset = () => { setParsed(undefined); setError(""); setEntries([]); setReport(""); setImageReport([]); setProgress(undefined); };
  const read = async (selected: File) => {
    if (lock.current) return;
    lock.current = true;
    reset();
    setFile(selected.name);
    setReading(true);
    try {
      const labels = inventorySkuTemplate.filter((field) => field.key === "image").flatMap((field) => [field.label, inventorySkuTemplateLabel(field), "图片链接"]);
      const sheets = (await readWorkbook(selected, {
        formattedCells: true,
        cachedImageFormulaColumns: labels,
        embeddedImageColumns: labels,
        maxFileSizeMB: inventoryImportLimits.maxFileSizeMB,
        maxRows: inventorySkuMaxRows,
      })).filter((sheet) => sheet.name !== "填写说明");
      if (!sheets.length) throw Error("没有数据工作表。");
      const sheet = sheets[0];
      const result = parseInventorySkuRows(sheet.rows, new Set(Object.keys(sheet.images ?? {}).map(Number)));
      setParsed({ ...result, images: sheet.images ?? {} });
      setEntries(result.entries.map((entry) => ({ line: entry.line, input: entry.input, key: crypto.randomUUID() })));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
      lock.current = false;
    }
  };
  const uploadImages = async (saved: Set<number>) => {
    const targets = inventorySkuImageTargets(parsed!.entries.filter((entry) => saved.has(entry.line)));
    const lines: string[] = [];
    for (let offset = 0; offset < targets.length; offset += inventoryImageBatchSize) {
      const items = [];
      for (const target of targets.slice(offset, offset + inventoryImageBatchSize)) {
        const base = { styleNo: target.styleNo, colorName: target.colorName, source: "excel" as const, fileName: `${file} 第${target.line}行`.slice(0, 255) };
        if ("url" in target.image) items.push({ ...base, url: target.image.url });
        else {
          const embedded = parsed!.images[target.image.embedded];
          try {
            const prepared = await prepareUpload(new File([embedded.bytes as BlobPart], `row-${target.line}.${embedded.type.split("/")[1]}`, { type: embedded.type }));
            items.push({ ...base, data: await readUpload(prepared) });
          } catch (e) {
            lines.push(`第 ${target.line} 行图片：${(e as Error).message}`);
          }
        }
      }
      if (!items.length) continue;
      try {
        const response = await api("/inventory/images/batch", "POST", { items });
        for (const result of response.data.results as InventoryImageBatchResult[])
          if (result.status !== "SAVED") lines.push(`${result.styleNo} ${result.colorName} 图片：${result.message ?? result.status}`);
      } catch (e) {
        lines.push(`图片保存失败：${(e as Error).message}`);
      }
    }
    return { total: targets.length, failed: lines };
  };
  const save = async () => {
    if (lock.current || !parsed || parsed.errors.length) return;
    lock.current = true;
    setBusy(true);
    try {
      const updated = await importInventoryRows(
        entries,
        async (batch) => (await api("/inventory/fulfilment/import-batch", "POST", { rows: batch.map(({ key, input }) => ({ key, input })) })).data.results,
        setProgress,
      );
      setEntries(updated);
      const savedLines = new Set(updated.filter((entry) => entry.saved).map((entry) => entry.line));
      const images = savedLines.size ? await uploadImages(savedLines) : { total: 0, failed: [] };
      const failed = updated.length - savedLines.size;
      setReport(`导入成功 ${savedLines.size} 行，失败 ${failed} 行；图片 ${images.total - images.failed.length} / ${images.total} 张已保存。${failed ? "修正失败行后可再次点击确认导入，仅提交失败行。" : ""}`);
      setImageReport(images.failed);
      if (savedLines.size) {
        await queryClient.invalidateQueries();
        onDone();
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
      lock.current = false;
    }
  };
  const failures = entries.filter((entry) => entry.error);
  const pending = entries.some((entry) => !entry.saved);
  const preview = parsed?.entries.slice(0, 200) ?? [];
  return (
    <>
      <Button icon={<ImportOutlined />} onClick={() => { reset(); setFile(""); setOpen(true); }}>
        导入SKU
      </Button>
      <Modal
        title="导入SKU"
        open={open}
        width={860}
        onCancel={() => !busy && !reading && setOpen(false)}
        mask={{ closable: !busy && !reading }}
        destroyOnHidden
        footer={
          <Space>
            <Button disabled={busy || reading} onClick={() => setOpen(false)}>关闭</Button>
            <Button type="primary" loading={busy} disabled={!parsed || !!parsed.errors.length || !pending || reading} onClick={() => void save()}>
              {busy ? "正在导入" : failures.length ? "重试失败行" : "确认导入"}
            </Button>
          </Space>
        }
      >
        <div className="inventory-sku-import-head">
          <Typography.Text>
            按模板填写款号、货号、商品编码、供应商款式编码、颜色和尺码；图片选填，可填 https 链接或在单元格插入图片。已有商品编码按编码更新，未建档的新增。
          </Typography.Text>
          <Button
            icon={<DownloadOutlined />}
            aria-label="模板下载"
            onClick={() => void downloadWorkbook(
              "导入SKU模板",
              inventorySkuTemplate.map((field) => ({ key: field.key, label: inventorySkuTemplateLabel(field), required: field.required })),
              [],
              templateNotes,
            ).catch((e: Error) => message.error(e.message))}
          >
            模板下载
          </Button>
        </div>
        <Upload.Dragger
          accept=".xlsx,.csv"
          multiple={false}
          showUploadList={false}
          disabled={busy || reading}
          beforeUpload={(selected) => { void read(selected); return false; }}
        >
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p>{reading ? "正在读取文件…" : "点击或拖拽 Excel 文件到这里"}</p>
          <p className="ant-upload-hint">支持 .xlsx、UTF-8 CSV；.xls 请另存为 .xlsx。上传后先预览校验，不会立即保存。</p>
        </Upload.Dragger>
        {file && <Typography.Paragraph style={{ marginTop: 12, marginBottom: 8 }}>文件：{file}</Typography.Paragraph>}
        {error && <Alert type="error" showIcon title={error} />}
        {parsed && !!parsed.errors.length && (
          <Alert
            type="error"
            showIcon
            title={`有 ${parsed.errors.length} 行未通过校验，请修正文件后重新上传（未保存任何数据）`}
            description={
              <div className="inventory-sku-import-errors" role="list" aria-label="校验错误">
                {parsed.errors.slice(0, 200).map((line) => <div role="listitem" key={line}>{line}</div>)}
                {parsed.errors.length > 200 && <div>仅显示前 200 条</div>}
              </div>
            }
          />
        )}
        {parsed && !parsed.errors.length && !report && (
          <Alert type="info" showIcon title={`校验通过：共 ${parsed.entries.length} 行，含图片 ${parsed.entries.filter((entry) => entry.image).length} 行。确认无误后点击「确认导入」。`} />
        )}
        {report && <Alert type={pending ? "warning" : "success"} showIcon title={report} />}
        {busy && progress && (
          <Progress style={{ marginTop: 12 }} percent={Number(((progress.completed / progress.total) * 100).toFixed(1))} format={() => `${progress.completed} / ${progress.total}`} />
        )}
        {!busy && !!failures.length && (
          <div className="inventory-sku-import-errors" aria-label="导入失败行">
            {failures.slice(0, 100).map((entry) => <div key={entry.key}>第 {entry.line} 行 · {entry.input.skuCode}：{entry.error}</div>)}
          </div>
        )}
        {!!imageReport.length && (
          <div className="inventory-sku-import-errors" aria-label="图片失败">
            {imageReport.map((line) => <div key={line}>{line}</div>)}
          </div>
        )}
        {!!preview.length && (
          <Table<InventorySkuEntry>
            size="small"
            style={{ marginTop: 12 }}
            rowKey="line"
            aria-label="导入预览"
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            dataSource={preview}
            columns={[
              { title: "行", dataIndex: "line", width: 56 },
              { title: "图片", width: 80, render: (_, entry) => !entry.image ? "—" : "url" in entry.image ? "链接" : "单元格图片" },
              { title: "款号", render: (_, entry) => entry.input.creation?.styleNo },
              { title: "货号", render: (_, entry) => entry.input.changes.articleNo },
              { title: "商品编码", render: (_, entry) => entry.input.skuCode },
              { title: "供应商款式编码", render: (_, entry) => entry.input.creation?.supplierStyleCode },
              { title: "颜色", render: (_, entry) => entry.input.changes.colorName },
              { title: "尺码", render: (_, entry) => entry.input.changes.sizeName },
            ]}
          />
        )}
      </Modal>
    </>
  );
}
