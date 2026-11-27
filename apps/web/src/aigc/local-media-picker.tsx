import { useEffect, useRef, useState } from "react";
import { Alert, Button, Empty, Input, InputNumber, Modal, Space } from "antd";
import { FolderOpenOutlined } from "@ant-design/icons";
import {
  canIndexLocalMedia,
  desktopMediaPageSize,
  loadLocalMediaIndex,
  openLocalMediaIndex,
  prepareLocalMediaExcerpt,
  previewLocalMedia,
  readLocalMediaFile,
  type DesktopMediaAsset,
  type DesktopMediaIndexPage,
} from "../desktop-client";
import { studioApi, type Item } from "./api";

export function LocalReferencePicker({ projectId, maxBytes, disabled, onBusy, onImport }: {
  projectId: string;
  maxBytes: number;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onImport: (file: Item) => void;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<DesktopMediaIndexPage>();
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<DesktopMediaAsset>();
  const [preview, setPreview] = useState<{ url: string; mime: string }>();
  const [start, setStart] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const pending = useRef<AbortController>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  if (!canIndexLocalMedia()) return null;

  async function run(label: string, action: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    setError("");
    setBusy(label);
    const request = new AbortController();
    pending.current = request;
    try {
      await action(request.signal);
    } catch (failure) {
      if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "本机素材处理失败");
    } finally {
      pending.current = null;
      if (!request.signal.aborted) setBusy("");
    }
  }

  function select(asset?: DesktopMediaAsset) {
    setSelected(asset);
    setPreview(undefined);
    setStart(0);
  }

  function browse() {
    void run("folder", async (signal) => {
      const next = await openLocalMediaIndex(signal);
      if (!next) return;
      setPage(next);
      setQuery("");
      setAppliedQuery("");
      setOffset(0);
      select(undefined);
    });
  }

  function load(nextOffset: number, search: string) {
    if (!page) return;
    void run("page", async (signal) => {
      const next = await loadLocalMediaIndex(page.indexId, nextOffset, search, signal);
      setPage(next);
      setOffset(nextOffset);
      setAppliedQuery(search);
      select(undefined);
    });
  }

  function upload(excerpt: boolean) {
    if (!page || selected?.kind !== "video" || disabled) return;
    void run("import", async (signal) => {
      onBusy(true);
      try {
        const file = excerpt
          ? await prepareLocalMediaExcerpt(page.indexId, selected.id, start, maxBytes, signal)
          : await readLocalMediaFile(page.indexId, selected.id, maxBytes, signal);
        if (!file) return;
        const body = new FormData();
        body.set("file", file);
        body.set("kind", "video");
        body.set("projectId", projectId);
        onImport(await studioApi("/assets", "POST", body, { signal, readTimeoutMs: 180_000 }));
        setOpen(false);
        select(undefined);
      } finally {
        onBusy(false);
      }
    });
  }

  return (
    <>
      <Button size="small" icon={<FolderOpenOutlined />} disabled={disabled} onClick={() => setOpen(true)}>浏览本机素材</Button>
      <Modal title="本机素材" open={open} footer={null} destroyOnHidden closable={!busy} mask={{ closable: !busy }} onCancel={() => {
        if (busy) return;
        setOpen(false);
        select(undefined);
      }}>
        <Space orientation="vertical" size="middle" className="aigc-local-media-picker">
          <Space wrap>
            <Button loading={busy === "folder"} disabled={Boolean(busy)} onClick={browse}>{page ? "更换文件夹" : "选择文件夹"}</Button>
            {page && <span>{page.folderName} · {page.total.toLocaleString()} 个文件{page.truncated ? "（已达索引上限）" : ""}</span>}
          </Space>
          {error && <Alert type="error" showIcon title={error} />}
          {page && <>
            <Input.Search aria-label="搜索本机文件" placeholder="搜索文件名或子目录" value={query} maxLength={128} disabled={Boolean(busy)} onChange={(event) => setQuery(event.target.value)} onSearch={(value) => load(0, value.trim())} />
            {page.items.length ? (
              <ul className="aigc-local-media-list">
                {page.items.map((asset) => <li key={asset.id}>
                  <button type="button" disabled={Boolean(busy)} aria-pressed={selected?.id === asset.id} onClick={() => select(asset)}>
                    <span title={asset.relativePath}>{asset.relativePath}</span>
                    <small>{(asset.bytes / (1024 * 1024)).toFixed(1)} MB</small>
                  </button>
                </li>)}
              </ul>
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的文件" />}
            <Space>
              <Button size="small" disabled={Boolean(busy) || offset === 0} onClick={() => load(offset - desktopMediaPageSize, appliedQuery)}>上一页</Button>
              <Button size="small" disabled={Boolean(busy) || offset + page.items.length >= page.total} onClick={() => load(offset + desktopMediaPageSize, appliedQuery)}>下一页</Button>
            </Space>
            {selected && <>
              <Space wrap>
                {selected.kind === "video" && <InputNumber aria-label="预览起点（秒）" min={0} max={86_400} precision={0} value={start} onChange={(value) => setStart(value ?? 0)} suffix="秒" disabled={Boolean(busy)} />}
                <Button loading={busy === "preview"} disabled={Boolean(busy)} onClick={() => void run("preview", async (signal) => {
                  const media = await previewLocalMedia(page.indexId, selected.id, start, signal);
                  if (signal.aborted) URL.revokeObjectURL(media.url);
                  else setPreview(media);
                })}>本机预览</Button>
                {selected.kind === "video" && <>
                  <Button type="primary" loading={busy === "import"} disabled={disabled || Boolean(busy) || selected.bytes > maxBytes || selected.bytes > 100 * 1024 * 1024} onClick={() => upload(false)}>上传原片</Button>
                  <Button disabled={disabled || Boolean(busy)} onClick={() => upload(true)}>上传此处短片</Button>
                </>}
              </Space>
              {preview && (preview.mime.startsWith("image/") ? (
                <img className="aigc-local-media-preview" src={preview.url} alt={selected.name} />
              ) : preview.mime.startsWith("video/") ? (
                <video className="aigc-local-media-preview" src={preview.url} controls aria-label={selected.name} />
              ) : <audio src={preview.url} controls aria-label={selected.name} />)}
            </>}
          </>}
        </Space>
      </Modal>
    </>
  );
}
