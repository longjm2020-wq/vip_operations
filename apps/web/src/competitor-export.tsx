import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Space, Spin } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import type { analyzeCompetitor } from "../../../packages/contracts/src/competitor-analysis";
import { competitorMaterialDisplay } from "./competitor-material-display";
import {
  prepareSheetDownload,
  releaseSheetDownload,
  triggerSheetDownload,
  type SheetDownload,
} from "./download-sheet";

export function CompetitorExport({
  result,
  loading,
}: {
  result?: ReturnType<typeof analyzeCompetitor>;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState<SheetDownload | null>(null);
  const [summary, setSummary] = useState("");
  const busyRef = useRef(false),
    alive = useRef(true),
    fileRef = useRef<SheetDownload | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (fileRef.current) releaseSheetDownload(fileRef.current);
    };
  }, []);
  async function start() {
    if (busyRef.current || loading || !result?.top20.length) return;
    busyRef.current = true;
    setBusy(true);
    setOpen(true);
    setError("");
    setFile(null);
    if (fileRef.current) releaseSheetDownload(fileRef.current);
    fileRef.current = null;
    // Capture this brand and its current filtered/sorted rows before asynchronous generation.
    const name = `${result.brand.name}-竞品TOP20`;
    const records = result.top20.map((p) => ({
      品牌: result.brand.name,
      公开排名: p.publicRank,
      商品名称: p.title,
      款号: p.styleCode,
      特卖价: p.salePrice,
      品类: p.category,
      详细材质信息: competitorMaterialDisplay(p.materialInfo),
      季节: p.seasons.join("、"),
      预览图链接: p.imageUrl,
      商品详情链接: p.productUrl,
    }));
    setSummary(
      `${result.brand.name} · ${records.length} 款 · 按当前筛选和排序导出`,
    );
    try {
      const next = await prepareSheetDownload(name, records);
      if (!alive.current) {
        releaseSheetDownload(next);
        return;
      }
      fileRef.current = next;
      setFile(next);
      // Some browsers suppress automatic downloads after asynchronous work.
      // Keep a normal user-clickable download link available for the same file.
      try {
        triggerSheetDownload(next);
      } catch {
        /* The explicit link remains available. */
      }
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "文件生成失败");
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <>
      <Button
        icon={<DownloadOutlined aria-hidden="true" />}
        loading={busy}
        disabled={loading || !result?.top20.length}
        onClick={() => void start()}
      >
        导出TOP20
      </Button>
      <Modal
        title="导出TOP20"
        open={open}
        width={540}
        maskClosable={false}
        closable={!busy}
        onCancel={() => !busy && setOpen(false)}
        footer={
          <Space wrap>
            <Button disabled={busy} onClick={() => setOpen(false)}>
              关闭
            </Button>
            {error && (
              <Button
                type="primary"
                disabled={loading || !result?.top20.length}
                onClick={() => void start()}
              >
                重新生成
              </Button>
            )}
            {file && (
              <Button
                type="primary"
                icon={<DownloadOutlined aria-hidden="true" />}
                href={file.url}
                download={file.fileName}
              >
                下载 Excel
              </Button>
            )}
          </Space>
        }
      >
        <p>{summary}</p>
        {busy && (
          <Space>
            <Spin size="small" />
            <span>正在生成 Excel，请稍候…</span>
          </Space>
        )}
        {file && (
          <Alert
            type="success"
            showIcon
            title="Excel 文件已生成"
            description={
              <>
                <p>{file.fileName}</p>
                <p>
                  已尝试开始下载，可在浏览器下载记录中查看。若未出现文件，请点击下方「下载
                  Excel」。
                </p>
              </>
            }
          />
        )}
        {error && (
          <Alert
            type="error"
            showIcon
            title="导出失败，请重试"
            description={
              <>
                <p>
                  {/dynamically imported module|Loading chunk|Importing a module script|Failed to fetch/i.test(
                    error,
                  )
                    ? "导出组件加载失败，请刷新页面后重新导出，并检查网络连接。"
                    : error}
                </p>
                <p>此次未生成文件，可点击「重新生成」再试。</p>
              </>
            }
          />
        )}
      </Modal>
    </>
  );
}
