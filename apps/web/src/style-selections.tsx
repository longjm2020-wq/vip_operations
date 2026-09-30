import {SelectionFieldManager,SelectionFieldInput} from "./selection-field-manager";
import {defaultTagConfig,orderedFieldTags,fieldValueError,fieldImages,defaultImageConfig,type SelectionField} from "./selection-field-types";
import { SelectionStatistics } from "./selection-statistics";
import { SelectionCollections } from "./selection-collections";
import { CollectionStockEditor } from "./selection-collection-stock";
import { SelectionPhotoQr } from "./selection-photo-qr";
import { SelectionFilterPanel } from "./selection-filter-panel";
import type { SelectionView } from "../../../packages/contracts/src/selection-view";
import { selectionImageLinks, invalidSelectionImage } from "./selection-image-links";
import { copySelectionImage, copySelectionImageAddress, downloadSelectionImage } from "./selection-image-actions";
import { parseSelectionClipboard } from "./selection-clipboard";
import { duplicateStyleCounts, selectionStyleKey } from "./selection-duplicates";
import { SelectionFormatModal, type FormatPatch } from "./selection-format-modal";
import { formatSelectionValue } from "../../../packages/contracts/src/selection-format";
import { Fragment, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Card, Checkbox, Empty, Image, Input, Modal, Pagination, Popover, Dropdown, Select, Space, Tag, Tooltip } from "antd";
import { BgColorsOutlined, CopyOutlined, DownloadOutlined, FontColorsOutlined, VerticalAlignTopOutlined, VerticalAlignMiddleOutlined, VerticalAlignBottomOutlined, CloseOutlined, AlignLeftOutlined, AlignCenterOutlined, AlignRightOutlined, DeleteOutlined, FilterOutlined, LinkOutlined, PlusOutlined, SettingOutlined, SortAscendingOutlined, TeamOutlined, UnorderedListOutlined, UploadOutlined } from "@ant-design/icons";
import { api, queryClient } from "./api";
import { prepareUpload, readUpload } from "./upload-file";
import { Header, QueryState, Row, useCan, useUser } from "./shared";
import { mergeSelectionSave, normalizeSelection, SelectionSaveAttempts } from "./selection-autosave";
import { fetchSelectionRows, SelectionTransfer } from "./selection-transfer";
import { matchesSelectionFilters, sortSelectionRows, selectionAllCells, clearSelectionCells, type SelectionFilters } from "./selection-filters";
import { selectionSizes as sizes, sortSelectionSizes } from "../../../packages/contracts/src/selection-sizes";
import "./style-selections.css";

const colorOptions = [
  { value: "NONE", label: "无填色", color: "#ffffff" }, { value: "ORANGE", label: "橙色", color: "#fff1e7" },
  { value: "YELLOW", label: "黄色", color: "#fff8cf" }, { value: "GREEN", label: "绿色", color: "#eef9e8" },
  { value: "BLUE", label: "蓝色", color: "#edf5ff" }, { value: "PINK", label: "粉色", color: "#fff0f3" },
];
const textColorOptions = [
  { value: "", label: "默认颜色" }, { value: "#262626", label: "黑色" },
  { value: "#cf1322", label: "红色" }, { value: "#d46b08", label: "橙色" },
  { value: "#ad8b00", label: "金色" }, { value: "#389e0d", label: "绿色" },
  { value: "#0958d9", label: "蓝色" }, { value: "#531dab", label: "紫色" },
  { value: "#c41d7f", label: "粉色" }, { value: "#595959", label: "灰色" },
];
type SelectionImage = { id: string; url: string; color: string };
type Column = SelectionField;
const baseColumns: Column[] = [
  { key: "registrationBatch", label: "登记批次", width: 120 }, { key: "images", label: "图片", width: 120 },
  { key: "labelImages", label: "洗唛/吊牌图", width: 140 },
  { key: "xutiStyleNo", label: "序缇款号", width: 120 }, { key: "supplierStyleNo", label: "供应商款号", width: 120 },
  { key: "supplierCode", label: "供应商编码", width: 120 }, { key: "color", label: "颜色", width: 120 },
  { key: "sizeRange", label: "尺码范围", width: 120 }, { key: "material", label: "材质", width: 120 },
  { key: "supplyPriceExclTax", label: "供货价（不含税）", width: 120 }, { key: "vipPrice", label: "唯品价", width: 120 },
  { key: "livePrice", label: "直播价", width: 120 }, { key: "tagPrice", label: "吊牌价", width: 120 },
];
const baseKeys = baseColumns.map((column) => column.key);
const imageKeys = new Set(["images", "labelImages"]);
const imageContextItems = [
  { key: "copy-image", label: "复制当前图片", icon: <CopyOutlined /> },
  { key: "download-image", label: "下载当前图片", icon: <DownloadOutlined /> },
  { key: "copy-image-url", label: "复制图片地址", icon: <LinkOutlined /> },
];
const collectionColumns: Column[] = [{key:"sellingPoints",label:"产品卖点/简介",width:200},{key:"reorderDays",label:"翻单周期（天）",width:120},{key:"collectionInventory",label:"库存数",width:160}];
const collectionKeys = new Set(collectionColumns.map(column => column.key));
const moneyKeys = new Set(["supplyPriceExclTax", "vipPrice", "livePrice", "tagPrice"]);
const clean = (value: unknown) => (value === "" || value === undefined ? null : value);
const splitTags = (value: unknown) => [...new Set(String(value ?? "").split("/").map((item) => item.trim()).filter(Boolean))];
const joinTags = (value: string[]) => [...new Set(value.map((item) => item.trim()).filter(Boolean))].join("/");
const comparable = (value: unknown) => value && typeof value === "object" ? JSON.stringify(value) : String(clean(value) ?? "");
const cellId = (rowKey: string, columnKey: string) => `${rowKey}::${columnKey}`;
const collaboratorColor = (id: string) => ["#722ed1", "#08979c", "#c41d7f", "#389e0d", "#d46b08", "#1d39c4"][Array.from(id).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % 6];
const pageSizes = [20, 50, 100, 200, 500, 1000];
const pageSizeKey = "style-selection-page-size-v1";
const imageVisibilityCallbacks = new WeakMap<Element, (visible: boolean) => void>();
let imageVisibilityObserver: IntersectionObserver | null = null;
function observeImageVisibility(element: Element, callback: (visible: boolean) => void) {
  if (typeof IntersectionObserver === "undefined") { callback(true); return () => {}; }
  imageVisibilityObserver ||= new IntersectionObserver(entries => entries.forEach(entry => imageVisibilityCallbacks.get(entry.target)?.(entry.isIntersecting)));
  imageVisibilityCallbacks.set(element, callback);
  imageVisibilityObserver.observe(element);
  return () => { imageVisibilityObserver?.unobserve(element); imageVisibilityCallbacks.delete(element); };
}
const customColumnsKey = "style-selection-custom-columns-v1";
const storedColumns = () => {
  try {
    const value = JSON.parse(localStorage.getItem(customColumnsKey) || "[]");
    return Array.isArray(value) ? value.filter((column): column is Column => column?.custom && typeof column.key === "string" && typeof column.label === "string") : [];
  } catch { return []; }
};
const columnLabelsKey = "style-selection-column-labels-v1";
const initialColumns = (): Column[] => {
  let config:Record<string,Partial<Column>>={};
  try{config=JSON.parse(localStorage.getItem("selection-field-config-v1") || "{}");}catch{}
  let labels: Record<string, string> = {};
  try { labels = JSON.parse(localStorage.getItem(columnLabelsKey) || "{}") || {}; } catch {}
  return [...baseColumns, ...collectionColumns, ...storedColumns()].map(column => ({ ...column, ...config[column.key],key:column.key,custom:column.custom,label: typeof labels[column.key] === "string" && labels[column.key].trim() ? labels[column.key].trim().slice(0, 40) : column.label })).sort((a,b)=>{const keys=Object.keys(config);const rank=(key:string)=>keys.includes(key)?keys.indexOf(key):keys.length;return rank(a.key)-rank(b.key);});
};
const rowImages = (row: Row): SelectionImage[] => Array.isArray(row.images) ? row.images : [];
const rowLabelImages = (row: Row): SelectionImage[] => Array.isArray(row.labelImages) ? row.labelImages : [];
const valueAt = (row: Row, column: Column) => column.custom ? row.extraFields?.[column.key] ?? "" : row[column.key];
const withValue = (row: Row, column: Column, value: unknown) => collectionKeys.has(column.key) ? row : column.custom
  ? { ...row, extraFields: { ...(row.extraFields || {}), [column.key]: String(value ?? "") } }
  : { ...row, [column.key]: column.key === "sizeRange" ? sortSelectionSizes(value) : value };
const sameRow = (a: Row, b: Row) =>
  baseKeys.every((key) => comparable(a[key]) === comparable(b[key])) &&
  comparable(a.cellNumberFormats) === comparable(b.cellNumberFormats) && comparable(a.cellTextColors) === comparable(b.cellTextColors) && comparable(a.cellVerticalAlignments) === comparable(b.cellVerticalAlignments) && comparable(a.cellAlignments) === comparable(b.cellAlignments) && comparable(a.extraFields) === comparable(b.extraFields) && comparable(a.cellColors) === comparable(b.cellColors) &&
  Number(a.sortOrder || 0) === Number(b.sortOrder || 0);

function SizeEditor({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const addCustom = () => {
    if (disabled || !customValue.trim()) return;
    onChange(sortSelectionSizes([value, customValue].filter(Boolean).join("/")));
    setCustomValue(""); setCustomOpen(false);
  };
  return <div className="selection-size-editor"><Select aria-label="编辑尺码范围" virtual={false} mode="tags" value={splitTags(value)} disabled={disabled} tokenSeparators={["/"]} placeholder="选择尺码或选择其他补充" options={[...sizes.map(value => ({ value, label: value })), { value: "__custom_size__", label: "其他" }]} onChange={values => {
    if (values.includes("__custom_size__")) { setCustomOpen(true); return; }
    onChange(sortSelectionSizes(joinTags(values)));
  }} />{customOpen && <Space.Compact><Input autoFocus aria-label="补充尺码" value={customValue} disabled={disabled} placeholder="输入尺码，按回车添加" onChange={event => setCustomValue(event.target.value)} onPressEnter={addCustom} /><Button disabled={disabled || !customValue.trim()} onClick={addCustom}>添加</Button><Button onClick={() => { setCustomOpen(false); setCustomValue(""); }}>取消</Button></Space.Compact>}</div>;
}

function TagCell({ value, disabled, placeholder }: { value: unknown; disabled: boolean; placeholder: string }) {
  return <div className="selection-tag-preview" tabIndex={0} role="group" aria-label={placeholder.slice(2)} aria-readonly={disabled}>{splitTags(value).map((tag) => <span className="selection-chip" key={tag}>{tag}</span>)}{!splitTags(value).length && <span className="selection-tag-placeholder">{placeholder}</span>}</div>;
}

function ImagePreviewClose({ children, onClose, imageUrl, imageName }: { children: React.ReactNode; onClose: () => void; imageUrl: string; imageName: string }) {
  const { message } = App.useApp();
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let frame = 0;
    const position = () => {
      const image = container.current?.querySelector("img");
      if (image && button.current) {
        const rect = image.getBoundingClientRect();
        button.current.style.top = `${Math.max(8, Math.min(window.innerHeight - 40, rect.top + 8))}px`;
        button.current.style.left = `${Math.max(8, Math.min(window.innerWidth - 40, rect.right - 40))}px`;
      }
      frame = requestAnimationFrame(position);
    };
    position();
    return () => cancelAnimationFrame(frame);
  }, []);
  return <div ref={container} style={{ display: "contents" }}><Dropdown trigger={["contextMenu"]} overlayStyle={{ zIndex: 9999 }} menu={{ items: imageContextItems, onClick: ({ key }) => {
    if (key === "copy-image") void copySelectionImage(imageUrl).then(() => message.success("图片已复制")).catch(() => message.error("无法复制图片；外部图片可能禁止跨域读取，可尝试复制图片地址"));
    if (key === "download-image") void downloadSelectionImage(imageUrl, imageName).then(() => message.success("图片已下载")).catch(() => message.error("无法下载图片；外部图片可能禁止跨域读取，可复制图片地址后打开保存"));
    if (key === "copy-image-url") void copySelectionImageAddress(imageUrl).then(() => message.success("图片地址已复制")).catch(() => message.error("无法复制图片地址"));
  } }}><div style={{ display: "contents" }}>{children}</div></Dropdown><button ref={button} type="button" className="selection-preview-close" aria-label="关闭图片预览" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onClose(); }}><CloseOutlined /></button></div>;
}

function ImageCell({ images, colors, disabled, onChange, mobileId, labelImages = false,field }: {field?:Column; mobileId?: string; images: SelectionImage[]; colors: string[]; disabled: boolean; onChange: (images: SelectionImage[]) => void; labelImages?: boolean }) {
  const { message } = App.useApp();
  const config={...defaultImageConfig,colors:!labelImages,...field?.imageConfig};
  const [url, setUrl] = useState("");
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());
  const imageError = (url: string) => setFailedImages(current => new Set([...current, url]));
  const [busy, setBusy] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [galleryPreviewOpen, setGalleryPreviewOpen] = useState(false);
  const [imageIndex, setImageIndex] = useState(0);
  const [carouselPaused, setCarouselPaused] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const [hasBeenVisible, setHasBeenVisible] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const currentImageIndex = Math.min(imageIndex, Math.max(0, images.length - 1));
  useEffect(() => summaryRef.current ? observeImageVisibility(summaryRef.current, visible => { setOnScreen(visible); if (visible) setHasBeenVisible(true); }) : undefined, [images.length > 0]);
  useEffect(() => {
    if (images.length < 2 || !onScreen || allOpen || previewOpen || carouselPaused || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setImageIndex(index => (index + 1) % images.length), 4000);
    return () => window.clearInterval(timer);
  }, [images.length, onScreen, allOpen, previewOpen, carouselPaused]);
  const uploadInput = useRef<HTMLInputElement>(null);
  const latestImages = useRef(images);
  latestImages.current = images;
  const add = (next: SelectionImage[]) => {
    if(latestImages.current.length+next.length>config.max){message.error(`最多 ${config.max} 张图片`);return;}
    latestImages.current = [...latestImages.current, ...next];
    onChange(latestImages.current);
  };
  const addUrl = () => {
    if(!config.links)return;
    const value = url.trim();
    if (!value) return;
    if (!selectionImageLinks(value).length) return message.error("请输入以 http:// 或 https:// 开头的图片网址");
    add([{ id: crypto.randomUUID(), url: value, color: !config.colors ? "" : colors[0] || "" }]); setUrl(""); setLinkOpen(false);
  };
  const addFiles = async (files: File[]) => {
    if (disabled || !config.upload || !files.length || busy) return;
    if(images.length+files.length>config.max)return void message.error(`最多 ${config.max} 张图片`);
    setBusy(true);
    const next: SelectionImage[] = [];
    try {
      for (let file of files) { file = await prepareUpload(file); const uploaded = await api("/style-selections/images", "POST", { data: await readUpload(file) }); next.push({ id: crypto.randomUUID(), url: uploaded.data.url, color: !config.colors ? "" : colors[0] || "" }); }
    } catch (error) { message.error((error as Error).message); } finally { if (next.length) add(next); setBusy(false); }
  };
  const paste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => !!file);
    if (disabled || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (files.length) { event.preventDefault(); event.stopPropagation(); void addFiles(files); return; }
    const text = event.clipboardData.getData("text/plain");
    if (!text.trim()) return;
    event.preventDefault(); event.stopPropagation();
    if(!config.links)return;
    const links = selectionImageLinks(text);
    if (!links.length) { message.warning("请粘贴完整的 http(s) 图片链接，多张图片每行一个链接"); return; }
    add(links.map(url => ({ id: crypto.randomUUID(), url, color: !config.colors ? "" : colors[0] || "" })));

  };
  const editor = <div className="selection-images selection-image-editor" tabIndex={disabled ? -1 : 0} aria-label="图片，支持粘贴" onPaste={paste}>
    <Image.PreviewGroup preview={{ open: galleryPreviewOpen, onOpenChange: setGalleryPreviewOpen, closeIcon: false, imageRender: (node, info) => galleryPreviewOpen ? <ImagePreviewClose onClose={() => setGalleryPreviewOpen(false)} imageUrl={info.image.url} imageName={`${labelImages ? "洗唛吊牌图" : "款式图片"}-${info.current + 1}`}>{node}</ImagePreviewClose> : node }}><div className="selection-image-list">{images.map((image, index) => <div className="selection-image-item" key={image.id}>
      <i className="selection-image-badge">{index + 1}/{images.length}</i>
      <Image loading="lazy" src={image.url} fallback={invalidSelectionImage} onError={() => imageError(image.url)} alt={failedImages.has(image.url) ? "无效图片，链接无法加载" : labelImages ? "洗唛/吊牌图" : image.color || "款式图片"} width="100%" height="100%" preview={failedImages.has(image.url) ? false : { mask: false }} />
      {image.color && <span className="selection-image-color">{image.color}</span>}
      {!disabled && <Button className="selection-image-remove" type="text" size="small" aria-label="移除图片" icon={<DeleteOutlined />} onClick={() => onChange(images.filter((item) => item.id !== image.id))} />}
      {config.colors && <Select className="selection-image-color-select" size="small" disabled={disabled} allowClear value={image.color || undefined} placeholder="命名颜色" options={colors.map((color) => ({ value: color, label: color }))} onChange={(color) => onChange(images.map((item) => item.id === image.id ? { ...item, color: color || "" } : item))} />}
    </div>)}</div></Image.PreviewGroup>
    {!disabled && <div className="selection-image-adders">
      {config.mobile && <SelectionPhotoQr rowId={mobileId} disabled={!mobileId} labelImages={labelImages} field={field?.custom?field:undefined} />}
      {config.links && <Popover trigger="click" open={linkOpen} onOpenChange={setLinkOpen} title="添加图片链接" content={<Space.Compact className="selection-image-url"><Input size="small" aria-label="图片网址" value={url} placeholder="粘贴图片网址" onChange={(event) => setUrl(event.target.value)} onPressEnter={addUrl} /><Button size="small" onClick={addUrl}>添加</Button></Space.Compact>}>
        <Button className="selection-mini-tag" size="small" icon={<LinkOutlined />}>链接</Button>
      </Popover>}
      {config.upload && <Tooltip title="上传或在单元格粘贴图片；每张压缩至 500 KB 以下，支持多选">
        <Button className="selection-mini-tag" size="small" icon={<UploadOutlined />} loading={busy} onClick={() => uploadInput.current?.click()}>上传</Button>
      </Tooltip>}
      <input ref={uploadInput} hidden type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(event) => { const files = Array.from(event.target.files || []); event.currentTarget.value = ""; void addFiles(files); }} />
    </div>}
  </div>;
  const gallery = allOpen && <Modal title={`${labelImages ? "洗唛/吊牌图" : "全部图片"} · ${images.length} 张`} open={allOpen} onCancel={() => setAllOpen(false)} footer={null} width={560}><div className="selection-image-gallery">{editor}{!images.length && <Empty description="暂无图片，可添加链接、上传或粘贴图片" />}</div></Modal>;
  const all = <><Button className="selection-mini-tag" size="small" onClick={() => setAllOpen(true)}>全部</Button>{gallery}</>;
  if (!images.length) return <div className="selection-image-empty" tabIndex={0} aria-label={`${labelImages ? "洗唛/吊牌图" : "图片"}，支持粘贴链接或图片`} onPaste={paste}><button className="selection-image-placeholder" type="button" disabled={disabled} onClick={() => setAllOpen(true)}>+ 图片</button>{gallery}</div>;
  return <div ref={summaryRef} className="selection-image-summary" data-selection-image-url={images[currentImageIndex].url} data-selection-image-index={currentImageIndex + 1} tabIndex={0} aria-label="图片轮播，点击图片放大" onMouseEnter={() => setCarouselPaused(true)} onMouseLeave={() => setCarouselPaused(false)} onFocus={() => setCarouselPaused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setCarouselPaused(false); }} onPaste={paste}>
    <div className="selection-image-slide">{hasBeenVisible && <Image loading="lazy" src={images[currentImageIndex].url} fallback={invalidSelectionImage} onError={() => imageError(images[currentImageIndex].url)} alt={failedImages.has(images[currentImageIndex].url) ? "无效图片，链接无法加载" : labelImages ? "洗唛/吊牌图" : images[currentImageIndex].color || "款式图片"} width="100%" height="100%" preview={failedImages.has(images[currentImageIndex].url) ? false : { mask: false, open: previewOpen, onOpenChange: setPreviewOpen, closeIcon: false, imageRender: (node, info) => previewOpen ? <ImagePreviewClose onClose={() => setPreviewOpen(false)} imageUrl={info.image.url} imageName={`${labelImages ? "洗唛吊牌图" : "款式图片"}-${currentImageIndex + 1}`}>{node}</ImagePreviewClose> : node }} />}
      <i className="selection-image-badge">{currentImageIndex + 1}/{images.length}</i>
      {images[currentImageIndex].color && <span className="selection-slide-color">{images[currentImageIndex].color}</span>}
      {images.length > 1 && <div className="selection-carousel-controls"><button type="button" aria-label="上一张图片" onClick={() => setImageIndex((currentImageIndex + images.length - 1) % images.length)}>‹</button><button type="button" aria-label="下一张图片" onClick={() => setImageIndex((currentImageIndex + 1) % images.length)}>›</button></div>}
      <div className="selection-image-actions">{all}</div>
    </div>
  </div>;
}

export function StyleSelectionsPage() {
  const canEdit = useCan("selection.manage");
  const user = useUser();
  const { message } = App.useApp();
  const [filterOpen, setFilterOpen] = useState(false);
  const [columns, setColumns] = useState<Column[]>(initialColumns);
  const [visible, setVisible] = useState<string[]>(() => {const keys=initialColumns().map(column=>column.key);try{const hidden=JSON.parse(localStorage.getItem("selection-hidden-fields-v1") || "[]");return keys.filter(key=>!Array.isArray(hidden) || !hidden.includes(key));}catch{return keys;}});
  useEffect(()=>{localStorage.setItem("selection-hidden-fields-v1",JSON.stringify(columns.filter(column=>!visible.includes(column.key)).map(column=>column.key)));},[columns,visible]);
  const [search, setSearch] = useState("");
  const [columnFilters, setColumnFilters] = useState<SelectionFilters>({});
  const [columnSort, setColumnSort] = useState<SelectionView["sort"]>(null);
  const [filterColumn, setFilterColumn] = useState<string | null>(null);
  const [filterSession, setFilterSession] = useState(0);
  const [filterRevision, setFilterRevision] = useState(0);
  const [followShared, setFollowShared] = useState(true);
  const [groupBy, setGroupBy] = useState<"none" | "batch" | "supplier" | "color">("none");
  const [sort, setSort] = useState("sortOrder");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [rowHeight, setRowHeight] = useState<"compact" | "normal" | "loose" | "extra">("extra");
  const [rows, setRows] = useState<Row[]>([]);
  const [addCount, setAddCount] = useState(10);
  const [pageSize, setPageSize] = useState(() => {
    const stored = Number(localStorage.getItem(pageSizeKey));
    return pageSizes.includes(stored) ? stored : 20;
  });
  const [page, setPage] = useState(1);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [copiedCells, setCopiedCells] = useState<Set<string>>(new Set());
  const copiedSingleValue = useRef<string | null>(null);
  const [focusedCell, setFocusedCell] = useState<string | null>(null);
  const [formatTarget, setFormatTarget] = useState<{ ids: Set<string>; sample: unknown; initial: FormatPatch } | null>(null);
  const [cellTextEditing, setCellTextEditing] = useState(false);
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const [cellAnchor, setCellAnchor] = useState<{ rowKey: string; columnKey: string } | null>(null);
  const contextImage = useRef<{ url: string; name: string } | null>(null);
  const [selectingCells, setSelectingCells] = useState(false);
  const axisSelection = useRef<{ type: "row" | "column"; key: string } | null>(null);
  const shiftDrag=useRef<{type:"row"|"column";key:string}|null>(null);
  const [shiftTarget,setShiftTarget]=useState<string|null>(null);
  const [draggedRow, setDraggedRow] = useState<string | null>(null);
  const [resizingColumn, setResizingColumn] = useState<{ key: string; startX: number; startWidth: number } | null>(null);
  const editingId = cellAnchor ? String(rows.find(row => row._key === cellAnchor.rowKey)?.id || "") || null : null;
  const editingColumn = editingId ? cellAnchor?.columnKey || null : null;
  const presenceWrites = useRef<Promise<unknown>>(Promise.resolve());
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const attempts = useRef(new SelectionSaveAttempts());
  const saveLock = useRef(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const original = useRef(new Map<string, Row>());
  const appliedSnapshot = useRef("");
  const queryString = new URLSearchParams({ page: "1", pageSize: "100", ...(search ? { q: search } : {}), sort, direction }).toString();
  const data = useQuery({ queryKey: ["style-selections", queryString], queryFn: () => fetchSelectionRows(search, sort, direction, queryClient.getQueryData(["style-selections", queryString])), refetchInterval: saving ? false : 10000, refetchOnWindowFocus: !saving });
  const styleCounts = useQuery({ queryKey: ["style-selection-style-counts"], queryFn: () => api("/style-selections/style-counts"), refetchInterval: 30000 });
  const presence = useQuery({ queryKey: ["style-selection-presence"], queryFn: () => api("/style-selections/presence"), refetchInterval: 2000 });

  const collaborators = (presence.data?.data || []).filter((person: Row) => String(person.userId) !== String(user.id || ""));
  const remoteCells = new Map<string, Row[]>();
  for (const person of collaborators) if (person.editingId && person.editingColumn) {
    const key = cellId(String(person.editingId), person.editingColumn);
    remoteCells.set(key, [...(remoteCells.get(key) || []), person]);
  }
  const sharedView = useQuery({ queryKey: ["selection-shared-view"], queryFn: () => api("/style-selections/shared-view"), refetchInterval: 10000 });
  const sharedSnapshot = JSON.stringify(sharedView.data?.data);
  useEffect(() => {
    if (!followShared || filterColumn || !sharedView.data?.data) return;
    setColumnFilters(sharedView.data.data.view.filters);
    setColumnSort(sharedView.data.data.view.sort);
  }, [sharedSnapshot, followShared, filterColumn]);
  const snapshot = useMemo(() => JSON.stringify(data.data?.data || []), [data.data]);
  useEffect(()=>{localStorage.setItem("selection-field-config-v1",JSON.stringify(Object.fromEntries(columns.map(column=>[column.key,column]))));},[columns]);
  useEffect(() => { localStorage.setItem(customColumnsKey, JSON.stringify(columns.filter((column) => column.custom))); }, [columns]);
  useEffect(() => { localStorage.setItem(columnLabelsKey, JSON.stringify(Object.fromEntries(columns.map(column => [column.key, column.label])))); }, [columns]);
  useEffect(() => { localStorage.setItem(pageSizeKey, String(pageSize)); }, [pageSize]);
  useEffect(() => {
    const stop = () => { setSelectingCells(false); axisSelection.current = null; };
    window.addEventListener("mouseup", stop); window.addEventListener("blur", stop);
    return () => { window.removeEventListener("mouseup", stop); window.removeEventListener("blur", stop); };
  }, []);
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!resizingColumn) return;
      setColumns((current) => current.map((column) => column.key === resizingColumn.key ? { ...column, width: Math.max(80, resizingColumn.startWidth + event.clientX - resizingColumn.startX) } : column));
    };
    const stop = () => setResizingColumn(null);
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", stop);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", stop); };
  }, [resizingColumn]);
  useEffect(() => {
    const publish = () => {
      const body = document.hidden ? { editingId: null, editingColumn: null } : { editingId, editingColumn };
      presenceWrites.current = presenceWrites.current.then(() => api("/style-selections/presence", "POST", body)).catch(() => undefined);
    };
    const debounce = window.setTimeout(publish, 200);
    const timer = window.setInterval(() => { if (!document.hidden) publish(); }, 12000);
    document.addEventListener("visibilitychange", publish);
    return () => { window.clearTimeout(debounce); window.clearInterval(timer); document.removeEventListener("visibilitychange", publish); };
  }, [editingId, editingColumn]);
  useEffect(() => () => {
    presenceWrites.current = presenceWrites.current.then(() => api("/style-selections/presence", "POST", { editingId: null, editingColumn: null })).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!data.data || appliedSnapshot.current === snapshot || saving || rows.some((row) => !row.id || !sameRow(row, original.current.get(row._key) || {}))) return;
    const next = (data.data.data || []).map((row: Row) => ({ ...normalizeSelection(row), _key: rows.find((current) => current.id === row.id)?._key || String(row.id) }));
    setRows(next); setErrors({});
    original.current = new Map(next.map((row: Row) => [row._key, { ...row }])); appliedSnapshot.current = snapshot;
  }, [data.data, saving, snapshot, rows]);

  const activeColumns = columns.filter((column) => visible.includes(column.key));
  const repeatedStyles = useMemo(() => duplicateStyleCounts(rows, styleCounts.data?.data, original.current), [rows, styleCounts.data]);
  const colorSuggestions = useMemo(() => [...new Set(rows.flatMap((row) => splitTags(row.color)))], [rows]);
  const filteredRows = useMemo(() => sortSelectionRows(rows.filter(row => matchesSelectionFilters(row, columnFilters)), columnSort), [rows, columnFilters, columnSort]);
  const allGrouped = useMemo(() => {
    const label = (row: Row) => groupBy === "batch" ? row.registrationBatch || "未填写登记批次" : groupBy === "supplier" ? row.supplierCode || "未填写供应商编码" : row.color || "未填写颜色";
    if (groupBy === "none") return [{ label: "", rows: filteredRows }];
    return filteredRows.reduce<{ label: string; rows: Row[] }[]>((result, row) => { const key = label(row); const target = result.find((item) => item.label === key); if (target) target.rows.push(row); else result.push({ label: key, rows: [row] }); return result; }, []);
  }, [groupBy, filteredRows]);
  const allDisplayedRows = useMemo(() => allGrouped.flatMap(group => group.rows), [allGrouped]);
  const pageCount = Math.max(1, Math.ceil(allDisplayedRows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const displayedRows = useMemo(() => allDisplayedRows.slice(pageStart, pageStart + pageSize), [allDisplayedRows, pageStart, pageSize]);
  const pageRowKeys = useMemo(() => new Set(displayedRows.map(row => row._key)), [displayedRows]);
  const rowNumberByKey = useMemo(() => new Map(displayedRows.map((row, index) => [row._key, pageStart + index + 1])), [displayedRows, pageStart]);
  const grouped = useMemo(() => {
    return allGrouped.map(group => ({...group, rows: group.rows.filter(row => pageRowKeys.has(row._key))})).filter(group => group.rows.length);
  }, [allGrouped, pageRowKeys]);
  useEffect(() => { setPage(1); }, [search, columnFilters, columnSort, groupBy]);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  useEffect(() => { setCellAnchor(null); setFocusedCell(null); setCopiedCells(new Set()); setCellTextEditing(false); }, [currentPage, pageSize]);
  useEffect(() => {
    const rowKeys = new Set(filteredRows.map(row => row._key));
    setSelectedRows(current => { const next = current.filter(key => rowKeys.has(key)); return next.length === current.length ? current : next; });
    setSelectedCells(current => { const next = new Set([...current].filter(id => { const [rowKey, columnKey] = id.split("::"); return pageRowKeys.has(rowKey) && visible.includes(columnKey); })); return next.size === current.size ? current : next; });
  }, [filteredRows, pageRowKeys, visible]);
  const dirtyCount = rows.filter((row) => !row.id || !sameRow(row, original.current.get(row._key) || {})).length;

  const update = (key: string, column: Column, value: unknown) => {
    setCopiedCells(new Set());
    setRows((current) => current.map((row) => row._key === key ? withValue(row, column, value) : row));
    setErrors((current) => { const next = { ...current }; delete next[`${key}:${column.key}`]; return next; });
  };
  const add = (count = 1) => {
    if (!canEdit) return;
    const nextOrder = Math.max(0, ...rows.map((row) => Number(row.sortOrder || 0))) + 1;
    const next = Array.from({ length: count }, (_, index) => ({ _key: crypto.randomUUID(), images: [], labelImages: [], cellColors: {}, extraFields: {}, sortOrder: nextOrder + index, rowColor: "NONE" }));
    setRows(current => [...current, ...next]); setSelectedRows(next.map(row => row._key));
  };
  const deleteRows = async () => {
    if (!canEdit || !selectedRows.length || deleting) return message.warning("请先勾选需要删除的行");
    setDeleting(true);
    try {
      const current = rows.filter((row) => selectedRows.includes(row._key));
      for (const row of current.filter((row) => row.id)) await api(`/style-selections/${row.id}`, "DELETE", undefined, row._key);
      setRows((items) => items.filter((row) => !selectedRows.includes(row._key))); setSelectedRows([]); setSelectedCells(new Set()); appliedSnapshot.current = "";
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["style-selections"] }), queryClient.invalidateQueries({ queryKey: ["style-selection-style-counts"] })]); message.success(`已删除 ${current.length} 行`);
    } catch (error) { message.error((error as Error).message); } finally { setDeleting(false); }
  };
  const applyColor = (color: string) => {
    if (!canEdit || !selectedCells.size) return message.warning("请单击或拖动选择需要填色的单元格");
    setRows((current) => current.map((row) => {
      const matches = activeColumns.filter((column) => selectedCells.has(cellId(row._key, column.key)));
      if (!matches.length) return row;
      const cellColors = { ...(row.cellColors || {}) };
      for (const column of matches) { if (color === "NONE") delete cellColors[column.key]; else cellColors[column.key] = color; }
      return { ...row, cellColors };
    }));
  };
  const moveRow = (fromKey: string, toKey: string) => {
    if (!canEdit || fromKey === toKey) return;
    setRows((current) => { const copy = [...current]; const from = copy.findIndex((row) => row._key === fromKey), to = copy.findIndex((row) => row._key === toKey); if (from < 0 || to < 0) return current; const [row] = copy.splice(from, 1); copy.splice(to, 0, row); return copy.map((item, index) => ({ ...item, sortOrder: index + 1 })); });
  };
  const moveColumn = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    setColumns((current) => { const copy = [...current]; const from = copy.findIndex((column) => column.key === fromKey), to = copy.findIndex((column) => column.key === toKey); if (from < 0 || to < 0) return current; const [column] = copy.splice(from, 1); copy.splice(to, 0, column); return copy; });
  };
  useEffect(()=>{
    const cancel=()=>{shiftDrag.current=null;setShiftTarget(null);};
    const drop=(event:MouseEvent)=>{
      const drag=shiftDrag.current;
      const target=event.target instanceof Element?event.target.closest<HTMLElement>("[data-reorder-axis]"):null;
      if(drag && target?.dataset.reorderAxis===drag.type && target.dataset.reorderKey){
        if(drag.type==="row")moveRow(drag.key,target.dataset.reorderKey);else moveColumn(drag.key,target.dataset.reorderKey);
      }
      cancel();
    };
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")cancel();};
    window.addEventListener("mouseup",drop);window.addEventListener("blur",cancel);window.addEventListener("keydown",escape);
    return()=>{window.removeEventListener("mouseup",drop);window.removeEventListener("blur",cancel);window.removeEventListener("keydown",escape);};
  },[canEdit]);
  const selectRectangle = (from: { rowKey: string; columnKey: string }, to: { rowKey: string; columnKey: string }) => {
    const r1 = displayedRows.findIndex((row) => row._key === from.rowKey), r2 = displayedRows.findIndex((row) => row._key === to.rowKey);
    const c1 = activeColumns.findIndex((column) => column.key === from.columnKey), c2 = activeColumns.findIndex((column) => column.key === to.columnKey);
    if (r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return;
    const next = new Set<string>();
    for (let row = Math.min(r1, r2); row <= Math.max(r1, r2); row++) for (let column = Math.min(c1, c2); column <= Math.max(c1, c2); column++) next.add(cellId(displayedRows[row]._key, activeColumns[column].key));
    setSelectedCells(next);
  };
  const selectAxis = (type: "row" | "column", from: string, to: string) => {
    const keys = type === "row" ? displayedRows.map(row => row._key) : activeColumns.map(column => column.key);
    const first = keys.indexOf(from), last = keys.indexOf(to);
    if (first < 0 || last < 0) return;
    const range = new Set(keys.slice(Math.min(first, last), Math.max(first, last) + 1));
    const chosenRows = type === "row" ? displayedRows.filter(row => range.has(row._key)) : displayedRows;
    const chosenColumns = type === "column" ? activeColumns.filter(column => range.has(column.key)) : activeColumns;
    setSelectedCells(new Set(chosenRows.flatMap(row => chosenColumns.map(column => cellId(row._key, column.key)))));
    setSelectedRows(type === "row" ? chosenRows.map(row => row._key) : []);
    if (chosenRows.length && chosenColumns.length) setCellAnchor({ rowKey: chosenRows[0]._key, columnKey: chosenColumns[0].key });
  };
  const axisMouseDown = (event: React.MouseEvent<HTMLElement>, type: "row" | "column", key: string) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.currentTarget.focus();
    setCellTextEditing(false); setSelectingCells(false); setCellAnchor(null);
    if(event.shiftKey){
      axisSelection.current=null;
      if(type==="row" && (!canEdit || saving || deleting))return;
      if(type==="row" && (sort!=="sortOrder" || direction!=="asc" || columnSort || groupBy!=="none")){message.info("请先切换到手动排序并取消分组，再拖动行");return;}
      shiftDrag.current={type,key};setShiftTarget(type+":"+key);return;
    }
    axisSelection.current = { type, key }; selectAxis(type, key, key);
  };
  const axisMouseEnter = (type: "row" | "column", key: string) => {
    if(shiftDrag.current){if(shiftDrag.current.type===type)setShiftTarget(type+":"+key);return;}
    const anchor = axisSelection.current;
    if (anchor?.type === type) selectAxis(type, anchor.key, key);
  };
  const cellMouseDown = (rowKey: string, columnKey: string) => { axisSelection.current = null; setSelectedRows([]); setCellTextEditing(false); const point = { rowKey, columnKey }; setCellAnchor(point); setSelectingCells(true); setSelectedCells(new Set([cellId(rowKey, columnKey)])); };
  const cellMouseEnter = (rowKey: string, columnKey: string) => { if (selectingCells && cellAnchor) selectRectangle(cellAnchor, { rowKey, columnKey }); };
  const copyValue = (row: Row, column: Column) => {
    const value = imageKeys.has(column.key) ? (column.key === "images" ? rowImages(row) : rowLabelImages(row)).map(image => image.url).join("; ") : column.key === "collectionInventory" ? (row.collectionInventory || []).reduce((sum:number,item:Row)=>sum+item.available+item.production,0) : valueAt(row,column);
    return String(value ?? "");
  };
  const copyCells = (event: ClipboardEvent<HTMLElement>, rowKey: string, columnKey: string) => {
    if (!event.currentTarget.contains(event.target as Node) || (cellTextEditing && selectedCells.size <= 1)) return;
    const selected = selectedCells.size ? selectedCells : new Set([cellId(rowKey, columnKey)]);
    const positions = [...selected].map((value) => { const [r, c] = value.split("::"); return { r: displayedRows.findIndex((row) => row._key === r), c: activeColumns.findIndex((column) => column.key === c) }; }).filter((item) => item.r >= 0 && item.c >= 0);
    if (!positions.length) return;
    const minRow = Math.min(...positions.map((item) => item.r)), maxRow = Math.max(...positions.map((item) => item.r)), minCol = Math.min(...positions.map((item) => item.c)), maxCol = Math.max(...positions.map((item) => item.c));
    const text = positions.length === 1
      ? copyValue(displayedRows[minRow], activeColumns[minCol])
      : Array.from({ length: maxRow - minRow + 1 }, (_, r) => Array.from({ length: maxCol - minCol + 1 }, (_, c) => {
        const value = copyValue(displayedRows[minRow + r], activeColumns[minCol + c]);
        return /[\t\n\r"]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
      }).join("\t")).join("\n");
    copiedSingleValue.current = positions.length === 1 ? text : null;
    event.preventDefault(); event.clipboardData.setData("text/plain", text); setCopiedCells(new Set(selected));
  };
  const pasteCells = (event: ClipboardEvent<HTMLTableCellElement>, rowKey: string, columnKey: string) => {
    if (!canEdit || event.defaultPrevented) return;
    const editingText = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
    const text = event.clipboardData.getData("text/plain"); if (!text && copiedSingleValue.current !== "") return;
    const copiedSingle = copiedSingleValue.current !== null && copiedSingleValue.current.replace(/\r/g, "") === text.replace(/\r/g, "");
    const matrix = copiedSingle ? [[text]] : parseSelectionClipboard(text);
    const grid = matrix.length > 1 || matrix[0].length > 1;
    if (editingText && (cellTextEditing || (!grid && matrix[0][0] === text && selectedCells.size <= 1))) return;
    if (selectedCells.size > 1 && !grid) {
      event.preventDefault(); setCopiedCells(new Set()); copiedSingleValue.current = null;
      setRows(current => current.map(row => {
        let next = row;
        for (const column of activeColumns) {
          if (!imageKeys.has(column.key) && !collectionKeys.has(column.key) && selectedCells.has(cellId(row._key, column.key))) next = withValue(next, column, matrix[0][0]);
        }
        return next;
      }));
      return;
    }
    if (imageKeys.has(columnKey)) {
      event.preventDefault(); setCopiedCells(new Set()); copiedSingleValue.current = null;
      const links = selectionImageLinks(text);
      if (!links.length) { message.warning("请粘贴完整的 http(s) 图片链接，多张图片每行一个链接"); return; }
      setRows(current => current.map(row => row._key === rowKey ? { ...row, [columnKey]: [...(columnKey === "images" ? rowImages(row) : rowLabelImages(row)), ...links.map(url => ({ id: crypto.randomUUID(), url, color: columnKey === "images" ? splitTags(row.color)[0] || "" : "" }))] } : row));
      return;
    }

    const rowStart = allDisplayedRows.findIndex((row) => row._key === rowKey), columnStart = activeColumns.findIndex((column) => column.key === columnKey); if (rowStart < 0 || columnStart < 0) return;
    if (!activeColumns.slice(columnStart, columnStart + Math.max(...matrix.map(row => row.length))).some(column => !imageKeys.has(column.key) && !collectionKeys.has(column.key))) return;
    event.preventDefault(); setCopiedCells(new Set()); copiedSingleValue.current = null;
    setRows((current) => {
      const missing = Math.max(0, rowStart + matrix.length - allDisplayedRows.length);
      const nextOrder = Math.max(0, ...current.map(row => Number(row.sortOrder || 0))) + 1;
      const added = Array.from({ length: missing }, (_, index) => ({ _key: crypto.randomUUID(), images: [], labelImages: [], cellColors: {}, extraFields: {}, sortOrder: nextOrder + index, rowColor: "NONE" }));
      const targets = [...allDisplayedRows, ...added];
      const sourceByKey = new Map(targets.slice(rowStart, rowStart + matrix.length).map((row, index) => [row._key, matrix[index]]));
      return [...current, ...added].map(row => {
        const source = sourceByKey.get(row._key);
        if (!source) return row;
        let next = row;
        source.forEach((value, offset) => { const column = activeColumns[columnStart + offset]; if (!column || imageKeys.has(column.key) || collectionKeys.has(column.key)) return; next = withValue(next, column, value); });
        return next;
      });
    });
  };
  const save = async () => {
    if (!canEdit || saveLock.current) return;
    const changed = rows.filter((row) => attempts.current.eligible(row) && (!row.id || !sameRow(row, original.current.get(row._key) || {})));
    if (!changed.length) return;
    saveLock.current = true;
    setSaving(true);
    // A read started before this write must not replace the successful response.
    await queryClient.cancelQueries({ queryKey: ["style-selections"] });
    const failed: Record<string, string> = {};
    const savedRows: Record<string, { sent: Row; saved: Row }> = {};
    try {
      for (const row of changed) {
        const body: Row = Object.fromEntries(baseKeys.map((key) => [key, clean(row[key])]));
        body.registrationBatch = normalizeSelection(row).registrationBatch;
        body.images = rowImages(row); body.labelImages = rowLabelImages(row); body.cellColors = row.cellColors || {}; body.cellAlignments = row.cellAlignments || {}; body.cellVerticalAlignments = row.cellVerticalAlignments || {}; body.cellTextColors = row.cellTextColors || {}; body.cellNumberFormats = row.cellNumberFormats || {}; body.extraFields = row.extraFields || {}; body.sortOrder = Number(row.sortOrder || 0); body.rowColor = row.rowColor || "NONE";
        if (row.id) body.expectedUpdatedAt = row.updatedAt;
        const attempt = attempts.current.start(row, body);
        try {
          for(const column of columns.filter(column=>column.custom)){const issue=fieldValueError(column,attempt.body.extraFields?.[column.key]);if(issue)throw Object.assign(new Error(column.label+"："+issue),{status:400});}
          const colors = new Set(splitTags(attempt.body.color));
          if (attempt.body.images.some((image: SelectionImage) => image.color && !colors.has(image.color))) throw Object.assign(new Error("图片颜色必须来自颜色字段"), { status: 400 });
          for (const key of moneyKeys) if (attempt.body[key] && !/^\d+(\.\d{1,2})?$/.test(String(attempt.body[key]))) throw Object.assign(new Error("金额最多两位小数且不能为负数"), { status: 400 });
          const result = await api(attempt.sent.id ? `/style-selections/${attempt.sent.id}` : "/style-selections", attempt.sent.id ? "PATCH" : "POST", attempt.body, attempt.key);
          const saved = { ...attempt.sent, ...normalizeSelection(result.data), _key: row._key };
          savedRows[row._key] = { sent: attempt.sent, saved };
          original.current.set(row._key, saved);
          attempts.current.succeed(row._key);
        } catch (error) {
          const fieldErrors = (error as { details?: { fieldErrors?: Record<string, string[]> } }).details?.fieldErrors;
          const knownFields = Object.entries(fieldErrors || {}).filter(([field, messages]) => baseKeys.includes(field) && messages.length);
          if (knownFields.length) for (const [field, messages] of knownFields) failed[`${row._key}:${field}`] = messages.join("；");
          else if ((error as Error).message.includes("序缇款号已存在")) failed[`${row._key}:xutiStyleNo`] = (error as Error).message;
          else failed[`${row._key}:save`] = (error as Error).message;
          attempts.current.fail(row._key, row, (error as { status?: number }).status);
        }
      }
      setErrors((current) => {
        const next = { ...current };
        for (const row of changed) for (const key of Object.keys(next)) if (key.startsWith(`${row._key}:`)) delete next[key];
        for (const [key, value] of Object.entries(failed)) next[key] = value;
        return next;
      });
      if (Object.keys(savedRows).length) {
        setRows((current) => current.map((row) => savedRows[row._key] ? mergeSelectionSave(row, savedRows[row._key].sent, savedRows[row._key].saved) : row));
        // Ignore the old cached list until a new read completes.
        appliedSnapshot.current = snapshot;
        await Promise.all([queryClient.invalidateQueries({ queryKey: ["style-selections"] }), queryClient.invalidateQueries({ queryKey: ["style-selection-style-counts"] })]);
      }
    } finally { saveLock.current = false; setSaving(false); }
  };
  useEffect(() => {
    if (!canEdit || !dirtyCount || saving || deleting) return;
    const timer = window.setTimeout(() => { void save(); }, 900);
    return () => window.clearTimeout(timer);
  }, [canEdit, dirtyCount, saving, deleting, rows, retryVersion]);
  const cellEdges = (set: Set<string>, rowKey: string, columnKey: string) => {
    if (!set.has(cellId(rowKey,columnKey))) return "";
    const r=displayedRows.findIndex(row=>row._key===rowKey), c=activeColumns.findIndex(column=>column.key===columnKey);
    const group=grouped.find(group=>group.rows.some(row=>row._key===rowKey));
    const has=(ri:number,ci:number)=>!!displayedRows[ri] && !!activeColumns[ci] && !!group?.rows.some(row=>row._key===displayedRows[ri]._key) && set.has(cellId(displayedRows[ri]._key,activeColumns[ci].key));
    return [!has(r-1,c)?"top":"",!has(r+1,c)?"bottom":"",!has(r,c-1)?"left":"",!has(r,c+1)?"right":""].filter(Boolean).join(" ");
  };
  const renderCell = (row: Row, column: Column) => {
    const observers = row.id ? remoteCells.get(cellId(String(row.id), column.key)) || [] : [];
    const observerNames = observers.map(person => person.displayName || "协作者").join("、");
    const disabled = !canEdit || collectionKeys.has(column.key), error = errors[`${row._key}:${column.key}`] || errors[`${row._key}:save`], selected = selectedCells.has(cellId(row._key, column.key));
    const duplicateCount = column.key === "xutiStyleNo" ? repeatedStyles.get(selectionStyleKey(row.xutiStyleNo)) || 0 : 0;
    const common = { "data-selection-edges": cellEdges(selectedCells,row._key,column.key), "data-copy-edges": cellEdges(copiedCells,row._key,column.key), "data-duplicate-count": duplicateCount || undefined, tabIndex: 0, onDoubleClick: () => setCellTextEditing(true), onFocusCapture: () => { setCellAnchor({ rowKey: row._key, columnKey: column.key }); if (!selectedCells.has(cellId(row._key, column.key))) setSelectedCells(new Set([cellId(row._key, column.key)])); }, className: `${error ? "selection-cell-error " : ""}${duplicateCount ? "selection-cell-duplicate " : ""}${selected ? "selection-cell-active" : ""}${copiedCells.has(cellId(row._key, column.key)) ? " selection-cell-copied" : ""}`, title: error || (duplicateCount ? `序缇款号重复，共 ${duplicateCount} 行` : undefined), onMouseDown: (event: React.MouseEvent) => { if (event.button === 0) cellMouseDown(row._key, column.key); else if (event.button === 2) { event.preventDefault(); if (!selected) { setSelectedCells(new Set([cellId(row._key, column.key)])); setCellAnchor({ rowKey: row._key, columnKey: column.key }); } } }, onDragStart: (event: React.DragEvent) => { if (selectingCells) event.preventDefault(); }, onMouseEnter: () => cellMouseEnter(row._key, column.key), onPaste: (event: ClipboardEvent<HTMLTableCellElement>) => pasteCells(event, row._key, column.key) };
    const openFormat = () => {
      const ids = selectedCells.has(cellId(row._key, column.key)) ? new Set(selectedCells) : new Set([cellId(row._key, column.key)]);
      setFormatTarget({ ids, sample: valueAt(row, column), initial: ids.size === 1 ? Object.fromEntries(["cellNumberFormats", "cellAlignments", "cellVerticalAlignments", "cellColors", "cellTextColors"].map(key => [key, row[key]?.[column.key]])) : {} });
      setSelectingCells(false);
    };
    const hasImage = imageKeys.has(column.key) && (column.key === "images" ? rowImages(row) : rowLabelImages(row)).length > 0;
    const cell = (content: React.ReactNode) => <Dropdown key={column.key} trigger={["contextMenu"]} menu={{ items: [...(hasImage ? [
      ...imageContextItems,
      { type: "divider" as const },
    ] : []), { key: "format", label: "设置单元格格式", icon: <SettingOutlined />, disabled: !canEdit }], onClick: ({ key }) => {
      if (key === "format") { openFormat(); return; }
      const image = contextImage.current;
      if (!image) return message.error("未找到当前图片，请重新右键单元格");
      if (key === "copy-image") void copySelectionImage(image.url).then(() => message.success("图片已复制")).catch(() => message.error("无法复制图片；外部图片可能禁止跨域读取，可尝试复制图片地址"));
      if (key === "download-image") void downloadSelectionImage(image.url, image.name).then(() => message.success("图片已下载")).catch(() => message.error("无法下载图片；外部图片可能禁止跨域读取，可复制图片地址后打开保存"));
      if (key === "copy-image-url") void copySelectionImageAddress(image.url).then(() => message.success("图片地址已复制")).catch(() => message.error("无法复制图片地址"));
    } }}><td {...common} onContextMenu={event => {
      const summary = event.currentTarget.querySelector<HTMLElement>("[data-selection-image-url]");
      contextImage.current = summary?.dataset.selectionImageUrl ? { url: summary.dataset.selectionImageUrl, name: `${row.xutiStyleNo || row.supplierStyleNo || "选款"}-${column.label}-${summary.dataset.selectionImageIndex || "1"}` } : null;
    }} data-vertical-align={row.cellVerticalAlignments?.[column.key] || "middle"} data-text-color={row.cellTextColors?.[column.key]} style={{ color: row.cellTextColors?.[column.key], textAlign: row.cellAlignments?.[column.key] || "left", backgroundColor: colorOptions.find(option => option.value === (row.cellColors?.[column.key] || row.rowColor))?.color }}><div className="selection-cell-content">{content}</div>{!!observers.length && <span className="selection-remote-cell" style={{ borderColor: collaboratorColor(String(observers[0].userId)) }} aria-label={`${observerNames}正在选中此单元格`}><span className="selection-remote-names" style={{ backgroundColor: collaboratorColor(String(observers[0].userId)) }}>{observerNames}</span></span>}</td></Dropdown>;
    if(column.custom && column.type==="image")return cell(<ImageCell field={column} mobileId={row.id && sameRow(row,original.current.get(row._key) || {})?String(row.id):undefined} images={fieldImages(valueAt(row,column))} colors={splitTags(row.color)} disabled={disabled} onChange={images=>update(row._key,column,JSON.stringify(images))}/>);
    if(column.custom && column.type==="tags"){const tags=orderedFieldTags(column,valueAt(row,column));return cell(<div className="selection-custom-tags">{tags.length?tags.map(tag=><Tag key={tag} color={{...defaultTagConfig,...column.tagConfig}.color}>{tag}</Tag>):<span className="selection-tag-empty">+ {column.label}</span>}</div>);}
    if(column.custom && column.type && column.type!=="text")return cell(<SelectionFieldInput field={column} value={String(valueAt(row,column) ?? "")} disabled={disabled} onChange={value=>update(row._key,column,value)}/>);
    if (column.key === "images") return cell(<ImageCell field={column} mobileId={row.id && sameRow(row, original.current.get(row._key) || {}) ? String(row.id) : undefined} images={rowImages(row)} colors={splitTags(row.color)} disabled={disabled} onChange={(value) => update(row._key, column, value)} />);
    if (column.key === "labelImages") return cell(<ImageCell field={column} labelImages mobileId={row.id && sameRow(row, original.current.get(row._key) || {}) ? String(row.id) : undefined} images={rowLabelImages(row)} colors={[]} disabled={disabled} onChange={(value) => update(row._key, column, value)} />);
    if (column.key === "color") return cell(<TagCell value={row.color} disabled={disabled} placeholder="+ 颜色"  />);
    if (column.key === "sizeRange") return cell(<TagCell value={row.sizeRange} disabled={disabled} placeholder="+ 尺码"  />);
    const numberFormat = row.cellNumberFormats?.[column.key];
    const displayValue = String(valueAt(row, column) ?? "");
    if (numberFormat && !["general", "text"].includes(numberFormat.type) && focusedCell !== cellId(row._key, column.key)) return cell(<div className="selection-formatted-value" tabIndex={0} role="textbox" aria-label={column.label} aria-readonly={!canEdit} onFocus={() => { if (canEdit) setFocusedCell(cellId(row._key, column.key)); }}>{formatSelectionValue(displayValue, numberFormat) || (column.key === "registrationBatch" ? "+ 日期" : "")}</div>);
    const focusProps = { autoFocus: !!numberFormat && focusedCell === cellId(row._key, column.key), onFocus: () => setFocusedCell(cellId(row._key, column.key)), onBlur: () => setFocusedCell(null) };
    if (column.key === "collectionInventory") return cell(<CollectionStockEditor readOnly inventory={row.collectionInventory || []} onChange={()=>{}}/>);
    if (collectionKeys.has(column.key)) return cell(<span title="由产品信息收集表内部确认后更新">{row[column.key] ?? "—"}</span>);
    if (column.key === "registrationBatch") return cell(<input className="selection-date-input" aria-label="登记批次日期" title="输入日期 YYYY-MM-DD，也可在顶部编辑栏选择" placeholder="+ 日期" maxLength={10} readOnly={disabled} {...focusProps} value={displayValue} onChange={event => update(row._key, column, event.target.value)} />);
    if (moneyKeys.has(column.key)) return cell(<div className="selection-money-input">{(!numberFormat || numberFormat.type === "general") && <span>￥</span>}<input {...focusProps} disabled={disabled} inputMode="decimal" placeholder="0.00" value={displayValue} onChange={(event) => update(row._key, column, event.target.value)} /></div>);
    return cell(<textarea {...focusProps} className="selection-text-input" aria-label={column.label} readOnly={disabled} value={displayValue} onChange={(event) => update(row._key, column, event.target.value)} />);
  };
  const applyAlignment = (alignment: "left" | "center" | "right" | "top" | "middle" | "bottom", vertical = false) => {
    const field = vertical ? "cellVerticalAlignments" : "cellAlignments";
    if (!canEdit || !selectedCells.size) return;
    setRows(current => current.map(row => {
      const selected = activeColumns.filter(column => selectedCells.has(cellId(row._key, column.key)));
      return selected.length ? { ...row, [field]: { ...(row[field] || {}), ...Object.fromEntries(selected.map(column => [column.key, alignment])) } } : row;
    }));
  };
  const applyTextColor = (color: string) => {
    if (!canEdit || !selectedCells.size) return;
    setRows(current => current.map(row => {
      const selected = activeColumns.filter(column => selectedCells.has(cellId(row._key, column.key)));
      if (!selected.length) return row;
      const cellTextColors = { ...(row.cellTextColors || {}) };
      for (const column of selected) { if (color) cellTextColors[column.key] = color; else delete cellTextColors[column.key]; }
      return { ...row, cellTextColors };
    }));
  };
  const applyView = async (view: SelectionView, shared: boolean, revision = filterRevision) => {
    if (shared) {
      try {
        const result = await api("/style-selections/shared-view", "POST", { view, revision });
        queryClient.setQueryData(["selection-shared-view"], result);
      } catch (error) { void queryClient.invalidateQueries({ queryKey: ["selection-shared-view"] }); throw error; }
    }
    setFollowShared(shared); setColumnFilters(view.filters); setColumnSort(view.sort); setFilterColumn(null);
  };
  const columnFilterEditor = (column: Column) => <SelectionFilterPanel key={`${column.key}:${filterSession}`} column={column} rows={rows} view={{ filters: columnFilters, sort: columnSort }} shared={followShared && (sharedView.data?.data?.revision || 0) > 0} canShare={canEdit && !!sharedView.data?.data} onCancel={() => setFilterColumn(null)} onApply={applyView} />;
  const editorRow = filteredRows.find((row) => row._key === cellAnchor?.rowKey);
  const editorColumn = activeColumns.find((column) => column.key === cellAnchor?.columnKey);
  const editorEnabled = !!editorRow && !!editorColumn && !imageKeys.has(editorColumn.key);
  const editorValue = editorEnabled ? String(valueAt(editorRow!, editorColumn!) ?? "") : "";
  const editCurrent = (value: string) => { if (canEdit && editorEnabled) update(editorRow!._key, editorColumn!, value); };
  const editorError = editorRow && editorColumn ? errors[`${editorRow._key}:${editorColumn.key}`] || errors[`${editorRow._key}:save`] : undefined;
  const editorDuplicateCount = editorColumn?.key === "xutiStyleNo" ? repeatedStyles.get(selectionStyleKey(editorRow?.xutiStyleNo)) || 0 : 0;
  const statisticsValues=displayedRows.flatMap(row=>activeColumns.filter(column=>selectedCells.has(cellId(row._key,column.key))).map(column=>imageKeys.has(column.key)?((column.key==="images"?rowImages(row):rowLabelImages(row)).length?"图片":null):column.key==="collectionInventory"?(row.collectionInventory || []).reduce((sum:number,item:Row)=>sum+item.available+item.production,0):column.custom && column.type==="image"?(fieldImages(row.extraFields?.[column.key]).length?"图片":null):column.custom?row.extraFields?.[column.key]:valueAt(row,column)));
  const editor = <div className="selection-editor-bar" role="group" aria-label="单元格编辑栏">
    <span className="selection-editor-label" title={editorColumn?.label}>{editorRow && editorColumn ? `${rows.indexOf(editorRow) + 1} · ${editorColumn.label}` : "单元格"}</span>
    {!!editorDuplicateCount && <span className="selection-duplicate-note" role="status">重复 {editorDuplicateCount} 行</span>}
    {editorColumn?.custom && editorColumn.type && editorColumn.type!=="text" && editorColumn.type!=="image" ? <SelectionFieldInput field={editorColumn} value={editorValue} disabled={!canEdit} onChange={editCurrent}/> : editorColumn?.custom && editorColumn.type==="image" ? <span>点击图片单元格管理图片</span> : editorColumn?.key === "registrationBatch" && editorRow ? <input aria-label="编辑登记批次" type="date" value={editorValue.slice(0, 10)} disabled={!canEdit} onChange={(event) => editCurrent(event.target.value)} /> :
      editorColumn?.key === "sizeRange" && editorRow ? <SizeEditor key={editorRow._key} value={editorValue} disabled={!canEdit} onChange={editCurrent} /> :
      editorColumn?.key === "color" && editorRow ? <Select aria-label={`编辑${editorColumn.label}`} mode="tags" className="selection-editor-tags" value={splitTags(editorValue)} disabled={!canEdit} tokenSeparators={["/"]} placeholder="输入后按 Enter 添加，多项用 / 分隔" options={colorSuggestions.map(value => ({ value, label: value }))} onChange={(value) => editCurrent(joinTags(value))} /> :
      <Input.TextArea aria-label="编辑当前单元格" autoSize={{ minRows: 1, maxRows: 3 }} value={editorValue} disabled={!editorEnabled} readOnly={!canEdit || !!editorColumn && collectionKeys.has(editorColumn.key)} placeholder={editorColumn && imageKeys.has(editorColumn.key) ? "图片请在单元格内上传或查看" : "点击单元格，在此编辑内容"} onChange={(event) => editCurrent(event.target.value)} />}
    {editorError && <span className="selection-editor-error" role="status">{editorError}</span>}
  </div>;
  const filterContent = <div className="selection-popover"><Input.Search autoFocus allowClear placeholder="搜索批次、款号、供应商、颜色或材质" value={search} onChange={(event) => setSearch(event.target.value)} /><Button onClick={() => { setSearch(""); setFilterOpen(false); }}>清除筛选</Button></div>;


  const applyFormat = (patch: FormatPatch) => {
    if (!canEdit || !formatTarget) return;
    setRows(current => current.map(row => {
      const targets = columns.filter(column => formatTarget.ids.has(cellId(row._key, column.key)));
      if (!targets.length) return row;
      const next = { ...row };
      for (const [field, value] of Object.entries(patch)) {
        next[field] = { ...(row[field] || {}) };
        for (const column of targets) {
          if (field === "cellNumberFormats" && ["images", "labelImages", "color", "sizeRange"].includes(column.key)) continue;
          if (value === "") delete next[field][column.key]; else next[field][column.key] = value;
        }
      }
      return next;
    }));
    setFormatTarget(null);
  };
  return <>{formatTarget && <SelectionFormatModal count={formatTarget.ids.size} sample={formatTarget.sample} initial={formatTarget.initial} onCancel={() => setFormatTarget(null)} onApply={applyFormat} />}<Header title="选款登记" subtitle="集中登记候选款的图片、款号、供应商、颜色、材质与定价信息。" />
    <Card className="selection-card"><div className="selection-toolbar" aria-label="选款登记表格工具栏"><Space wrap size={4}>
      {canEdit && <SelectionCollections selectedRows={filteredRows.filter(row => selectedRows.includes(row._key))} blocked={!!dirtyCount || saving || deleting}/>} {canEdit && <SelectionPhotoQr />}<Button type="link" icon={<PlusOutlined />} disabled={!canEdit} onClick={() => add()}>添加一行</Button><Button type="link" danger icon={<DeleteOutlined />} disabled={!canEdit || !selectedRows.length || saving} loading={deleting} onClick={deleteRows}>删除行</Button>
      <SelectionFieldManager columns={columns} visible={visible} canEdit={canEdit} onVisible={key=>setVisible(current=>current.includes(key)?current.filter(item=>item!==key):[...current,key])} onMove={moveColumn} onSave={field=>{if(imageKeys.has(field.key) && rows.some(row=>(row[field.key]?.length || 0)>(field.imageConfig?.max || 30))){message.error("已有图片超过新上限，请先移除部分图片");return false;}if(field.custom){const issue=rows.map(row=>fieldValueError(field,row.extraFields?.[field.key])).find(Boolean);if(issue){message.error("现有内容与设置不兼容："+issue);return false;}}const exists=columns.some(column=>column.key===field.key);setColumns(current=>exists?current.map(column=>column.key===field.key?field:column):[...current,field]);if(!exists)setVisible(current=>[...current,field.key]);}}/><Popover trigger="click" open={filterOpen} onOpenChange={setFilterOpen} content={filterContent}><Button type="text" icon={<FilterOutlined />}>筛选</Button></Popover>
      <Select className="selection-tool-select" value={groupBy} suffixIcon={<TeamOutlined />} options={[{ value: "none", label: "不分组" }, { value: "batch", label: "按登记批次分组" }, { value: "supplier", label: "按供应商编码分组" }, { value: "color", label: "按颜色分组" }]} onChange={setGroupBy} />
      <Select className="selection-tool-select" value={columnSort ? "column" : `${sort}:${direction}`} suffixIcon={<SortAscendingOutlined />} options={[...(columnSort ? [{ value: "column", label: `${columns.find(column => column.key === columnSort.key)?.label || "当前列"}${columnSort.direction === "asc" ? "升序" : "降序"}` }] : []),{ value: "sortOrder:asc", label: "手动排序" }, { value: "updatedAt:desc", label: "最近修改" }, { value: "createdAt:desc", label: "最新登记" }, { value: "registrationBatch:desc", label: "登记批次" }, { value: "xutiStyleNo:asc", label: "序缇款号" }, { value: "supplierCode:asc", label: "供应商编码" }, { value: "supplyPriceExclTax:asc", label: "供货价" }, { value: "vipPrice:asc", label: "唯品价" }]} onChange={(value) => { if (value === "column") return; setColumnSort(null); setFollowShared(false); const [nextSort, nextDirection] = value.split(":"); setSort(nextSort); setDirection(nextDirection as "asc" | "desc"); }} />
      <Select className="selection-tool-select" value={rowHeight} suffixIcon={<UnorderedListOutlined />} options={[{ value: "compact", label: "紧凑行高" }, { value: "normal", label: "标准行高" }, { value: "loose", label: "宽松行高" }, { value: "extra", label: "超宽行高" }]} onChange={setRowHeight} />

    <Space.Compact>{([{ value: "left", label: "左对齐", icon: <AlignLeftOutlined /> }, { value: "center", label: "居中对齐", icon: <AlignCenterOutlined /> }, { value: "right", label: "右对齐", icon: <AlignRightOutlined /> }] as const).map(item => <Tooltip key={item.value} title={item.label}><Button aria-label={item.label} disabled={!canEdit || !selectedCells.size} icon={item.icon} onClick={() => applyAlignment(item.value)} /></Tooltip>)}</Space.Compact>
    <Dropdown trigger={["click"]} menu={{ selectable: true, selectedKeys: editorRow && editorColumn ? [editorRow.cellVerticalAlignments?.[editorColumn.key] || "middle"] : [], items: [{ key: "top", label: "顶端对齐", icon: <VerticalAlignTopOutlined /> }, { key: "middle", label: "垂直居中", icon: <VerticalAlignMiddleOutlined /> }, { key: "bottom", label: "底端对齐", icon: <VerticalAlignBottomOutlined /> }], onClick: ({ key }) => applyAlignment(key as "top" | "middle" | "bottom", true) }}><Button aria-label="垂直对齐" title="垂直对齐" disabled={!canEdit || !selectedCells.size} icon={<VerticalAlignMiddleOutlined />} /></Dropdown>
      <Popover trigger="click" content={<div className="selection-color-menu">{colorOptions.map((option) => <Button key={option.value} type="text" onClick={() => applyColor(option.value)}><span className="selection-color-dot" style={{ background: option.color }} />{option.label}</Button>)}</div>}><Button aria-label="填色" title="填色" disabled={!canEdit || !selectedCells.size} icon={<BgColorsOutlined />} /></Popover>
    <Dropdown trigger={["click"]} menu={{ selectable: true, selectedKeys: editorRow && editorColumn ? [editorRow.cellTextColors?.[editorColumn.key] || "default"] : [], items: textColorOptions.map(option => ({ key: option.value || "default", label: option.label, icon: <span className="selection-color-dot" style={{ background: option.value || "#46352a" }} /> })), onClick: ({ key }) => applyTextColor(key === "default" ? "" : key) }}><Button aria-label="字体颜色" title="字体颜色" disabled={!canEdit || !selectedCells.size} icon={<FontColorsOutlined />} /></Dropdown>
    {!!Object.keys(columnFilters).length && <Button type="text" onClick={() => { void applyView({ filters: {}, sort: columnSort }, followShared && canEdit && !!sharedView.data?.data?.revision, sharedView.data?.data?.revision || 0).catch(error => message.error((error as Error).message)); }}>清除列筛选 ({Object.keys(columnFilters).length})</Button>}
    {!followShared && !!sharedView.data?.data?.revision && <Button type="text" onClick={() => setFollowShared(true)}>使用共享筛选</Button>}
    <SelectionTransfer filteredRows={Object.keys(columnFilters).length || columnSort ? filteredRows : undefined} canEdit={canEdit} blocked={!!dirtyCount || saving || deleting} selectedRows={filteredRows.filter(row => selectedRows.includes(row._key))} query={search} onImported={() => { appliedSnapshot.current = ""; void queryClient.invalidateQueries({ queryKey: ["style-selections"] }); void queryClient.invalidateQueries({ queryKey: ["style-selection-style-counts"] }); }} />
    </Space><span className="selection-record-count">{!!Object.keys(errors).length && <Tooltip title="修改尚未保存；悬停红色单元格查看原因，修正后重试"><Button type="text" size="small" danger disabled={saving} onClick={() => { attempts.current.retry(); setRetryVersion((value) => value + 1); }}>未保存 · 重试</Button></Tooltip>}</span></div>
    {!!collaborators.length && <div className="selection-collaborators" aria-label="在线协作者">{collaborators.map((person: Row) => <span key={person.userId} style={{ color: collaboratorColor(String(person.userId)) }} title={person.editingId ? `正在选中：${rows.find(row => String(row.id) === String(person.editingId))?.xutiStyleNo || "未填款号"} · ${columns.find(column => column.key === person.editingColumn)?.label || "单元格"}` : "在线"}><i>{String(person.displayName || "协").slice(0, 1)}</i>{person.displayName}{person.editingId ? ` · ${columns.find(column => column.key === person.editingColumn)?.label || "选中中"}` : " · 在线"}</span>)}</div>}
      {editor}
      <QueryState error={data.error || presence.error || sharedView.error} reload={() => { data.refetch(); presence.refetch(); sharedView.refetch(); }} /><div className={`selection-sheet row-${rowHeight}`}><table tabIndex={0} onCopy={event => { const point = cellAnchor || (displayedRows[0] && activeColumns[0] ? {rowKey:displayedRows[0]._key,columnKey:activeColumns[0].key} : null); if (point) copyCells(event,point.rowKey,point.columnKey); }} onKeyDown={event => {
        if (!event.currentTarget.contains(event.target as Node) || event.nativeEvent.isComposing) return;
        if (event.key === "Escape") { setCopiedCells(new Set()); setCellTextEditing(false); return; }
        if (event.key === "Delete" && (!cellTextEditing || selectedCells.size > 1)) {
          event.preventDefault();
          if (canEdit && selectedCells.size) { setRows(current => clearSelectionCells(current, selectedCells)); setCopiedCells(new Set()); }
          return;
        }
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) setCellTextEditing(true);
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !event.altKey) {
          event.preventDefault(); event.stopPropagation();
          setSelectedRows(displayedRows.map(row => row._key));
          setSelectedCells(selectionAllCells(displayedRows, activeColumns)); setCellTextEditing(false);
          setSelectingCells(false);
        }
      }} aria-label="选款登记在线智能表格" style={{ width: activeColumns.reduce((width, column) => width + column.width, 96) }}><colgroup><col style={{ width: 48 }} /><col style={{ width: 48 }} />{activeColumns.map((column) => <col key={column.key} style={{ width: column.width }} />)}</colgroup><thead><tr><th className="selection-check"><Checkbox aria-label="选择全部可见行" checked={!!displayedRows.length && displayedRows.every(row => selectedRows.includes(row._key))} indeterminate={displayedRows.some(row => selectedRows.includes(row._key)) && !displayedRows.every(row => selectedRows.includes(row._key))} onChange={(event) => setSelectedRows(current => event.target.checked ? [...new Set([...current, ...displayedRows.map(row => row._key)])] : current.filter(key => !pageRowKeys.has(key)))} /></th><th className="selection-index">#</th>{activeColumns.map((column) => <th key={column.key} data-reorder-axis="column" data-reorder-key={column.key} data-reorder-target={shiftTarget==="column:"+column.key || undefined} title="按住 Shift 拖动调整列顺序" tabIndex={0} aria-label={`选择整列：${column.label}`} onMouseDown={event => axisMouseDown(event, "column", column.key)} onMouseEnter={() => axisMouseEnter("column", column.key)} style={{ width: column.width, minWidth: column.width }}><span>{column.label}{columnSort?.key === column.key ? columnSort.direction === "asc" ? " ↑" : " ↓" : ""}</span><Popover destroyOnHidden trigger="click" open={filterColumn === column.key} onOpenChange={open => { setFilterColumn(open ? column.key : null); if (open) { setFilterRevision(sharedView.data?.data?.revision || 0); setFilterSession(value => value + 1); } }} content={columnFilterEditor(column)}><Button className="selection-column-filter-button" type="text" size="small" aria-label={`筛选${column.label}`} title={`筛选${column.label}`} icon={<FilterOutlined />} style={{ color: columnFilters[column.key] ? "#d3540b" : undefined }} onMouseDown={event => event.stopPropagation()} /></Popover><i className="selection-column-resize" aria-label={`调整 ${column.label} 列宽`} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); setResizingColumn({ key: column.key, startX: event.clientX, startWidth: column.width }); }} /></th>)}</tr></thead><tbody>
        {data.isLoading && <tr><td colSpan={activeColumns.length + 2} className="selection-placeholder">正在读取选款登记…</td></tr>}{!data.isLoading && !filteredRows.length && <tr><td colSpan={activeColumns.length + 2} className="selection-placeholder"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无选款登记，点击添加一行开始录入" /></td></tr>}
        {grouped.map((group) => <Fragment key={group.label || "all"}>{group.label && <tr className="selection-group-row"><td colSpan={activeColumns.length + 2}>{group.label}<span>{group.rows.length} 条</span></td></tr>}{group.rows.map((row) => <tr key={row._key}><td className="selection-check"><Checkbox aria-label={`选择 ${row.xutiStyleNo || "未填写序缇款号"}`} checked={selectedRows.includes(row._key)} onChange={(event) => setSelectedRows((current) => event.target.checked ? [...current, row._key] : current.filter((key) => key !== row._key))} /></td><td data-reorder-axis="row" data-reorder-key={row._key} data-reorder-target={shiftTarget==="row:"+row._key || undefined} title="按住 Shift 拖动调整行顺序" className={`selection-index selection-row-drag ${selectedRows.includes(row._key) ? "selection-axis-active" : ""}`} tabIndex={0} aria-label={`选择第${rowNumberByKey.get(row._key)}行`} onMouseDown={event => axisMouseDown(event, "row", row._key)} onMouseEnter={() => axisMouseEnter("row", row._key)} onDragOver={(event: DragEvent) => event.preventDefault()} onDrop={() => { if (draggedRow) moveRow(draggedRow, row._key); setDraggedRow(null); }}>{rowNumberByKey.get(row._key)}<span className="selection-row-reorder" title="拖动调整行顺序" draggable onMouseDown={event => event.stopPropagation()} onDragStart={() => setDraggedRow(row._key)} onDragEnd={() => setDraggedRow(null)}>⋮⋮</span></td>{activeColumns.map((column) => renderCell(row, column))}</tr>)}</Fragment>)}
      </tbody></table></div><div className="selection-bulk-add"><Select aria-label="批量添加行数" value={addCount} onChange={setAddCount} options={[10, 20, 50, 100, 200].map(value => ({ value, label: `${value} 行` }))} /><Button icon={<PlusOutlined />} disabled={!canEdit} onClick={() => add(addCount)}>添加 {addCount} 行</Button><span>空白行自动保存</span><Pagination className="selection-pagination" current={currentPage} pageSize={pageSize} total={allDisplayedRows.length} pageSizeOptions={pageSizes} showSizeChanger showTotal={total => `共 ${total} 条`} onChange={(nextPage, nextPageSize) => { if (nextPageSize !== pageSize) { setPageSize(nextPageSize); setPage(1); } else setPage(nextPage); }} /><SelectionStatistics values={statisticsValues}/></div><div className="selection-bottom-bar"><span>拖动可选择多个单元格后填色；Ctrl/Cmd+C 复制、Ctrl/Cmd+V 粘贴；点击或拖动行号/表头选择整行整列；按住 Shift 拖动行号或表头调整行列顺序。</span><span>{canEdit ? "图片支持网址、本地上传和粘贴。" : "当前账号仅可查看。"}</span></div></Card></>;
}
