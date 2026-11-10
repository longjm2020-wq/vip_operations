import { App, Button, Modal, Progress, Space, Table, Typography } from "antd";
import { PictureOutlined } from "@ant-design/icons";
import { useRef, useState } from "react";
import { api } from "./api";
import { prepareUpload, readUpload } from "./upload-file";
import {
  inventoryImageBatchSize,
  planInventoryImageFiles,
  type InventoryImageBatchResult,
} from "../../../packages/contracts/src/inventory-image";

type ResultRow = { key: string; styleNo: string; colorName: string; fileName: string; status: string; message: string };
const statusLabel: Record<string, string> = { SAVED: "已导入", NOT_FOUND: "未找到款号", INVALID: "图片无效", SKIPPED: "已跳过", FAILED: "失败" };

/** Bulk import user pictures by 款号. Files are compressed in the browser and
 * sent in small batches; each picture succeeds or fails independently. */
export function InventoryImageImport({ onDone }: { onDone: () => void }) {
  const { message } = App.useApp();
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<ResultRow[]>([]);
  const run = async (list: FileList | null) => {
    if (!list?.length) return;
    const files = [...list].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    const plan = planInventoryImageFiles(files);
    const rows: ResultRow[] = plan.skipped
      .filter(({ file }) => /\.(jpe?g|png|webp)$/i.test(file.path))
      .map(({ file, reason }) => ({ key: "skip:" + file.path, styleNo: "—", colorName: "", fileName: file.path, status: "SKIPPED", message: reason }));
    setResults(rows);
    setProgress({ done: 0, total: plan.chosen.length });
    if (!plan.chosen.length) {
      message.warning("没有可导入的图片：请按款号命名文件，或选择图片批量命名生成的款号目录");
      return;
    }
    setRunning(true);
    try {
      for (let offset = 0; offset < plan.chosen.length; offset += inventoryImageBatchSize) {
        const batch = plan.chosen.slice(offset, offset + inventoryImageBatchSize);
        const items: { styleNo: string; colorName: string; data: string; fileName: string }[] = [];
        for (const entry of batch) {
          try {
            const prepared = await prepareUpload(entry.file.file);
            items.push({ styleNo: entry.styleNo, colorName: entry.colorName, data: await readUpload(prepared), fileName: entry.file.path.slice(-255) });
          } catch (error) {
            rows.push({ key: "bad:" + entry.file.path, styleNo: entry.styleNo, colorName: entry.colorName, fileName: entry.file.path, status: "INVALID", message: (error as Error).message });
          }
        }
        if (items.length) {
          try {
            const response = await api("/inventory/images/batch", "POST", { items });
            for (const result of response.data.results as InventoryImageBatchResult[])
              rows.push({ key: `${result.status}:${result.fileName}:${result.styleNo}`, styleNo: result.styleNo, colorName: result.colorName, fileName: result.fileName ?? "", status: result.status, message: result.message ?? "" });
          } catch (error) {
            for (const item of items)
              rows.push({ key: "fail:" + item.fileName, styleNo: item.styleNo, colorName: item.colorName, fileName: item.fileName, status: "FAILED", message: (error as Error).message });
          }
        }
        setProgress({ done: Math.min(plan.chosen.length, offset + batch.length), total: plan.chosen.length });
        setResults([...rows]);
      }
      const saved = rows.filter((row) => row.status === "SAVED").length;
      message[saved ? "success" : "warning"](`已导入 ${saved} 张图片`);
      if (saved) onDone();
    } finally {
      setRunning(false);
      for (const input of [filesInput.current, folderInput.current]) if (input) input.value = "";
    }
  };
  return (
    <>
      <Button icon={<PictureOutlined />} onClick={() => setOpen(true)}>
        批量导入图片
      </Button>
      <Modal
        title="批量导入库存图片"
        open={open}
        onCancel={() => !running && setOpen(false)}
        footer={<Button onClick={() => setOpen(false)} disabled={running}>关闭</Button>}
        width={720}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          唯品会有图片时始终优先显示唯品会图片；导入的图片在唯品会缺图时显示。文件名用款号，例如 S22X20130.jpg；颜色图片用「款号_颜色」，例如 S22X20130_黑色.jpg。也可选择「图片批量命名」生成的款号目录，自动选用 1 号轮播图（其次 50 号列表图），不选详情、吊牌和平铺图。同一款号再次导入会替换原上传图片。
        </Typography.Paragraph>
        <input ref={filesInput} type="file" hidden multiple accept="image/jpeg,image/png,image/webp" aria-label="选择图片文件" onChange={(event) => void run(event.target.files)} />
        <input
          ref={folderInput}
          type="file"
          hidden
          multiple
          aria-label="选择图片文件夹"
          {...({ webkitdirectory: "" } as Record<string, string>)}
          onChange={(event) => void run(event.target.files)}
        />
        <Space>
          <Button type="primary" disabled={running} onClick={() => filesInput.current?.click()}>选择图片文件</Button>
          <Button disabled={running} onClick={() => folderInput.current?.click()}>选择款号目录</Button>
        </Space>
        {progress.total > 0 && <Progress percent={Math.round((progress.done / progress.total) * 100)} format={() => `${progress.done} / ${progress.total}`} style={{ marginTop: 12 }} />}
        {results.length > 0 && (
          <Table<ResultRow>
            size="small"
            style={{ marginTop: 12 }}
            rowKey="key"
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            dataSource={results}
            columns={[
              { title: "款号", dataIndex: "styleNo" },
              { title: "颜色", dataIndex: "colorName", render: (value: string) => value || "整款" },
              { title: "文件", dataIndex: "fileName", ellipsis: true },
              { title: "结果", dataIndex: "status", render: (value: string, row) => `${statusLabel[value] ?? value}${row.message ? `：${row.message}` : ""}` },
            ]}
          />
        )}
      </Modal>
    </>
  );
}
