import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Empty, Image, Modal, Spin } from "antd";
import { CameraOutlined, UploadOutlined } from "@ant-design/icons";
import { useSelectionWorkspace } from "./selection-workspace";
import { readableSelectionCell } from "./selection-protection";
import { useCan, type Row } from "./shared";
import { prepareUpload, readUpload } from "./upload-file";
import { invalidSelectionImage } from "./selection-image-links";
import "./selection-image-search.css";

type SearchCandidate = Row & { imageSimilarity: number };
type SearchResult = { data: SearchCandidate[]; total: number; skippedImages: number; scannedImages: number; feedbackToken?: string; focused?: boolean };

export function SelectionImageSearch({ disabled = false, onSelect }: { disabled?: boolean; onSelect: (row: Row) => void }) {
  const { api } = useSelectionWorkspace();
  const canRead = useCan("selection.read");
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [feedback, setFeedback] = useState<Record<string, "same" | "different">>({});
  const camera = useRef<HTMLInputElement>(null), album = useRef<HTMLInputElement>(null);
  const file = useRef<File | null>(null), previewUrl = useRef("");
  const sequence = useRef(0), controller = useRef<AbortController | null>(null);
  const replacePreview = (url: string) => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = url;
    setPreview(url);
  };
  const cancel = () => {
    sequence.current++;
    controller.current?.abort();
    controller.current = null;
    file.current = null;
    replacePreview("");
    setOpen(false); setOpening(false); setBusy(false); setSelecting(""); setError(""); setResult(null); setFeedback({});
  };
  useEffect(() => () => {
    sequence.current++;
    controller.current?.abort();
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
  }, []);
  const start = async () => {
    if (disabled || !canRead || opening) return;
    const current = ++sequence.current, abort = new AbortController();
    controller.current?.abort(); controller.current = abort;
    setOpen(true); setOpening(true); setError(""); setResult(null);
    try {
      await api("/style-selections/revision", "GET", undefined, undefined, { signal: abort.signal });
      if (current !== sequence.current || abort.signal.aborted) return;
    } catch (failure) {
      if (current !== sequence.current || abort.signal.aborted) return;
      cancel(); message.error((failure as Error).message);
    } finally { if (current === sequence.current) setOpening(false); }
  };
  const search = async (image: File) => {
    const current = ++sequence.current, abort = new AbortController();
    controller.current?.abort(); controller.current = abort;
    file.current = image;
    replacePreview(""); setBusy(true); setError(""); setResult(null); setSelecting(""); setFeedback({});
    try {
      if (!["image/jpeg", "image/png", "image/webp"].includes(image.type)) throw Error("请选择 JPG、PNG 或 WebP 图片");
      const prepared = await prepareUpload(image);
      if (current !== sequence.current || abort.signal.aborted) return;
      file.current = prepared;
      replacePreview(URL.createObjectURL(prepared));
      const data = await readUpload(prepared);
      if (current !== sequence.current || abort.signal.aborted) return;
      const response = await api("/style-selections/image-search", "POST", { data }, undefined, { signal: abort.signal });
      if (current !== sequence.current || abort.signal.aborted) return;
      setResult(response.data as SearchResult);
    } catch (failure) {
      if (current === sequence.current && !abort.signal.aborted) setError((failure as Error).message);
    } finally { if (current === sequence.current) setBusy(false); }
  };
  const select = async (candidate: Row, vote?: "same" | "different") => {
    if (disabled || opening || busy || selecting) return;
    const current = ++sequence.current, abort = new AbortController();
    controller.current?.abort(); controller.current = abort;
    setSelecting(String(candidate.id)); setError("");
    try {
      const fresh: Row = (await api(`/style-selections/${candidate.id}`, "GET", undefined, undefined, { signal: abort.signal })).data;
      if (current !== sequence.current || abort.signal.aborted) return;
      const matched = candidate.matchedImage;
      if (!fresh || !readableSelectionCell(fresh, "images") || fresh.hiddenCells?.includes("images") ||
        !matched || !Array.isArray(fresh.images) || !fresh.images.some((image: Row) => String(image.id) === String(matched.id) && image.url === matched.url))
        throw Object.assign(Error("该候选图片已变化或不再允许查看，请重新查找"), { status: 409 });
      if (vote) {
        if (!result?.feedbackToken) throw Error("本次查找反馈已过期，请重新查找");
        await api("/style-selections/image-search/feedback", "POST", { token: result.feedbackToken, candidateId: String(candidate.id), feedback: vote }, undefined, { signal: abort.signal });
        if (current !== sequence.current || abort.signal.aborted) return;
        setFeedback(previous => ({ ...previous, [String(candidate.id)]: vote }));
        if (vote === "different") { message.success("已记录不是同款的反馈"); return; }
        message.success("已记录同款反馈，帮助本表后续识别");
      }
      onSelect(fresh);
      cancel();
    } catch (failure) {
      if (current === sequence.current && !abort.signal.aborted) {
        if ([401,403,404,409,410].includes((failure as { status?: number }).status || 0)) setResult(null);
        setError((failure as Error).message);
      }
    } finally { if (current === sequence.current) setSelecting(""); }
  };
  const fileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const image = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (image && !disabled && !opening && !busy && !selecting) void search(image);
  };
  const candidates = (result?.data || [])
    .filter(candidate => typeof candidate.imageSimilarity === "number" && Number.isFinite(candidate.imageSimilarity) && candidate.imageSimilarity > 90 && candidate.imageSimilarity <= 100)
    .sort((left, right) => right.imageSimilarity - left.imageSimilarity)
    .slice(0, 3);
  if (!canRead) return null;
  return <>
    <Button className="selection-image-search-trigger" type="text" size="small" icon={<CameraOutlined />} aria-label="拍照或上传图片查找同款" title="拍照或上传图片查找同款" disabled={disabled || opening} onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); void start(); }} />
    <Modal className="selection-image-search-modal" title="图片查找同款" open={open} width={640} onCancel={cancel} mask={{ closable: true }} footer={<Button onClick={cancel}>关闭</Button>}>
      <p className="selection-image-search-guide">仅显示图片相似度大于 90% 的前 3 款同款候选，请核对款号与图片。查询原图不保存到款式。</p>
      <p className="selection-image-search-guide">点「是同款并选择」或「不是同款」可帮助本表识别；仅保存比较特征和反馈，不保存查询原图。</p>
      <div className="selection-image-search-actions"><Button icon={<CameraOutlined />} disabled={disabled || opening || busy || !!selecting} onClick={() => camera.current?.click()}>拍照查找</Button><Button icon={<UploadOutlined />} disabled={disabled || opening || busy || !!selecting} onClick={() => album.current?.click()}>上传图片查找</Button></div>
      {opening && <div className="selection-image-search-loading"><Spin /><span>正在检查查看权限…</span></div>}
      {preview && <div className="selection-image-search-query"><Image src={preview} alt="本次查找图片" /><span>本次查找图片</span></div>}
      {busy && <div className="selection-image-search-loading"><Spin /><span>正在查找同款候选…</span></div>}
      {error && <Alert type="error" showIcon title={error} action={file.current && !opening ? <Button disabled={disabled || busy || !!selecting} onClick={() => { if (file.current) void search(file.current); }}>重新查找</Button> : undefined} />}
      {result && <>
        {!!result.skippedImages && <Alert className="selection-image-search-notice" type="info" showIcon title={`${result.skippedImages} 张外链或暂时无法读取的图片未参与查找`} description="可上传款式图片后重试。" />}
        {candidates.length ? <><h3>同款候选 · 按图片相似度排序</h3><p className="selection-image-search-count">共 {result.total} 款相似度大于 90% 的候选，当前显示 {candidates.length} 款（最多 3 款）</p>
          {result.focused && <Alert className="selection-image-search-notice" type="success" showIcon title="至少两次一致反馈且图片匹配明显领先，本次仅显示 1 款" description="仍请核对图片与款号；有疑问可反馈不是同款。" />}
          <div className="selection-image-search-results">{candidates.map(candidate => {
            const label = candidate.xutiStyleNo || candidate.supplierStyleNo || "未填写序缇款号", voted = feedback[String(candidate.id)];
            return <div className="selection-image-search-card" key={candidate.id}>
              <button type="button" className="selection-image-search-result" disabled={disabled || !!selecting} aria-label={`选择图片候选 ${label}`} onClick={() => void select(candidate)}><Image src={candidate.matchedImage?.url} fallback={invalidSelectionImage} preview={false} alt={`候选款图片 ${label}`} /><span><strong>{label}</strong><small>供应商款号：{candidate.supplierStyleNo || "—"}</small><small>供应商编码：{candidate.supplierCode || "—"}</small>{selecting === String(candidate.id) && <Spin size="small" />}</span></button>
              {result.feedbackToken && <div className="selection-image-search-feedback"><Button type="primary" size="small" disabled={disabled || !!selecting} aria-label={`确认同款 ${label}`} onClick={() => void select(candidate, "same")}>是同款并选择</Button><Button size="small" disabled={disabled || !!selecting || voted === "different"} aria-label={`反馈不是同款 ${label}`} onClick={() => void select(candidate, "different")}>{voted === "different" ? "已反馈不是同款" : "不是同款"}</Button></div>}
            </div>;
          })}</div></> : <Empty description={result.scannedImages ? "未找到相似度大于 90% 的同款候选，可换一张图片重试" : "未能读取可比较的款式图片，可上传款式图片后重试"} />}
      </>}
      <input hidden ref={camera} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" aria-label="拍照查找图片文件" onChange={fileSelected} />
      <input hidden ref={album} type="file" accept="image/jpeg,image/png,image/webp" aria-label="上传查找图片文件" onChange={fileSelected} />
    </Modal>
  </>;
}
