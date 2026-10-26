import { assignImageGroups, naturalCompare, outputPrefix, validFolderName, type BatchImageMetadata, type BatchPlan, type BatchPlanEntry, type DirectoryLayout } from "./image-batch-plan";
import { imagePalette, inferImageColorGroups } from "./image-batch-recognition";

interface LocalWritable { write(data: Blob | string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
export interface LocalImageFileHandle { kind: "file"; name: string; getFile(): Promise<File>; createWritable(): Promise<LocalWritable> }
export interface LocalImageDirectory {
  kind: "directory"; name: string;
  values(): AsyncIterable<LocalImageDirectory | LocalImageFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<LocalImageDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<LocalImageFileHandle>;
  requestPermission(options: { mode: "readwrite" }): Promise<string>;
}
type PickerWindow = Window & { showDirectoryPicker?: (options: { id: string; mode: "readwrite"; startIn: "pictures" }) => Promise<LocalImageDirectory> };
export const supportsImageDirectory = () => typeof (window as PickerWindow).showDirectoryPicker === "function" && window.isSecureContext;
export function chooseImageDirectory() {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker || !window.isSecureContext) throw Error("当前浏览器不支持本地目录读写，请使用桌面版 Chrome 或 Edge 打开 HTTPS 页面");
  return picker.call(window, { id: "xuti-image-naming", mode: "readwrite", startIn: "pictures" });
}
export interface BatchProgress { phase: string; completed: number; total: number; file: string }
export interface ScannedImage extends BatchImageMetadata { sourcePath: string; size: number; file: File; error?: string }
export interface ImageScan { files: ScannedImage[]; ignored: number }
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException("操作已停止", "AbortError"); };
const notFound = (error: unknown) => error instanceof DOMException && error.name === "NotFoundError";
const errorText = (error: unknown) => error instanceof Error ? error.message : "处理失败，请重试";

async function actualFormat(file: Blob) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && String.fromCharCode(...bytes.slice(1, 4)) === "PNG") return "png";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "webp";
  throw Error("图片内容不是 JPG、PNG 或 WebP，请转换格式后重试");
}
function checkDimensions(width: number, height: number) {
  if (width * height > 40_000_000 || Math.max(width, height) > 16000) throw Error("图片过大：最多 4000 万像素、最长边 16000 像素，请缩小后重试");
}
export async function readLocalImageMetadata(file: File): Promise<BatchImageMetadata> {
  if (!file.size || file.size > 50 * 1024 * 1024) throw Error("单张原图须大于 0 且不超过 50 MB");
  const format = await actualFormat(file);
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = bitmap;
    checkDimensions(width, height);
    let transparent = false;
    if (format !== "jpeg") {
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      try {
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw Error("浏览器不能读取图片透明度");
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, width, height).data;
        for (let index = 3; index < pixels.length; index += 4) if (pixels[index] < 255) { transparent = true; break; }
      } finally { canvas.width = canvas.height = 1; }
    }
    const preview = document.createElement("canvas"); preview.width = preview.height = 96;
    try {
      const context = preview.getContext("2d", { willReadFrequently: true });
      if (!context) throw Error("浏览器不能读取图片颜色");
      context.drawImage(bitmap, 0, 0, 96, 96);
      const palette = imagePalette(context.getImageData(0, 0, 96, 96).data, 96, 96);
      return { width, height, format, transparent, palette };
    } finally { preview.width = preview.height = 1; }
  } finally { bitmap.close(); }
}
export async function scanImageDirectory(root: LocalImageDirectory, signal: AbortSignal, onProgress: (progress: BatchProgress) => void): Promise<ImageScan> {
  const handles: { sourcePath: string; handle: LocalImageFileHandle }[] = [];
  let ignored = 0, visited = 0;
  async function walk(directory: LocalImageDirectory, prefix = "", depth = 0) {
    checkAbort(signal);
    if (depth > 10) throw Error("目录超过 10 层，请选择更具体的款号目录");
    for await (const entry of directory.values()) {
      checkAbort(signal);
      if (++visited > 20000) throw Error("目录项目过多，请分批选择（每批最多 20000 个文件及目录）");
      if (entry.name.startsWith(".") || entry.name.startsWith(outputPrefix)) continue;
      const sourcePath = prefix + entry.name;
      if (entry.kind === "directory") await walk(entry, sourcePath + "/", depth + 1);
      else if (/\.(?:jpe?g|png|webp)$/i.test(entry.name)) {
        handles.push({ sourcePath, handle: entry });
        if (handles.length > 3000) throw Error("一次最多处理 3000 张图片，请按款分批选择");
      } else ignored++;
      if (visited % 50 === 0) onProgress({ phase: "查找图片", completed: 0, total: 0, file: `已发现 ${handles.length} 张图片` });
    }
  }
  await walk(root);
  handles.sort((a, b) => naturalCompare(a.sourcePath, b.sourcePath));
  const files: ScannedImage[] = [];
  for (const { sourcePath, handle } of handles) {
    checkAbort(signal);
    onProgress({ phase: "识别尺寸与用途", completed: files.length, total: handles.length, file: sourcePath });
    let file = new File([], handle.name);
    try {
      file = await handle.getFile();
      files.push({ sourcePath, file, size: file.size, ...await readLocalImageMetadata(file) });
    } catch (error) {
      files.push({ sourcePath, file, size: file.size, width: 0, height: 0, format: "", transparent: false, error: errorText(error) });
    }
  }
  checkAbort(signal);
  onProgress({ phase: "预览已就绪", completed: files.length, total: files.length, file: "" });
  return { files, ignored };
}
export function scanToItems(rootName: string, scan: ImageScan, layout: DirectoryLayout) { return inferImageColorGroups(assignImageGroups(rootName, scan.files, layout)); }
function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob?.type === type ? resolve(blob) : reject(Error("浏览器无法生成指定图片格式")), type, quality));
}
export interface PreparedBatchImage { blob: Blob; width: number; height: number; changed: boolean }
export async function prepareBatchImage(file: File, entry: BatchPlanEntry, signal: AbortSignal): Promise<PreparedBatchImage> {
  checkAbort(signal);
  const type = entry.item.kind === "flat" ? "image/png" : "image/jpeg";
  if (entry.item.format === type.slice(6) && (!entry.limit || file.size <= entry.limit)) return { blob: file, width: entry.item.width, height: entry.item.height, changed: false };
  const bitmap = await createImageBitmap(file), canvas = document.createElement("canvas");
  try {
    checkDimensions(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw Error("浏览器不支持图片压缩");
    let scale = 1;
    for (let resize = 0; resize < 18; resize++) {
      checkAbort(signal);
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      if (Math.min(canvas.width, canvas.height) < 128) break;
      if (type === "image/jpeg") { context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); }
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of type === "image/png" ? [undefined] : [0.95, 0.9, 0.85, 0.8, 0.75, 0.7]) {
        checkAbort(signal);
        const blob = await canvasBlob(canvas, type, quality);
        if (!entry.limit || blob.size <= entry.limit) return { blob, width: canvas.width, height: canvas.height, changed: true };
      }
      scale *= 0.85;
    }
    throw Error(`压缩后仍不能满足 ${Math.round((entry.limit || 0) / 1024)} KB 上限，请调整原图后重试`);
  } finally { bitmap.close(); canvas.width = canvas.height = 1; }
}
async function freshOutputDirectory(root: LocalImageDirectory) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const name = `${outputPrefix}${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  try { await root.getDirectoryHandle(name); throw Error("输出目录已存在，请重新开始，避免覆盖文件"); }
  catch (error) { if (!notFound(error)) throw error; }
  return { name, directory: await root.getDirectoryHandle(name, { create: true }) };
}
async function writeNewFile(root: LocalImageDirectory, path: string, blob: Blob | string) {
  const parts = path.split("/");
  if (parts.some(part => !validFolderName(part))) throw Error("输出路径无效");
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
  const name = parts.at(-1)!;
  try { await directory.getFileHandle(name); throw Error(`输出文件已存在：${path}`); }
  catch (error) { if (!notFound(error)) throw error; }
  const handle = await directory.getFileHandle(name, { create: true }), stream = await handle.createWritable();
  try { await stream.write(blob); await stream.close(); }
  catch (error) { await stream.abort().catch(() => {}); throw error; }
}
export interface BatchFileResult { source: string; target: string; status: "success" | "review" | "failed"; beforeBytes: number; afterBytes?: number; width?: number; height?: number; changed?: boolean; error?: string; reasons?: string[]; groupNote?: string }
export interface BatchRunResult { directoryName: string; files: BatchFileResult[]; cancelled: boolean; skipped: number; total: number; reportError?: string }
export async function runImageBatch(root: LocalImageDirectory, plan: BatchPlan, files: Map<string, File>, signal: AbortSignal, onProgress: (progress: BatchProgress) => void): Promise<BatchRunResult> {
  // Invalid images are copied verbatim to review, never released as compliant delivery images.
  const tasks = [...plan.entries.map(entry => ({ ...entry, review: false, reasons: [] as string[] })), ...plan.review.map(entry => ({ ...entry, limit: undefined, review: true }))];
  if (!tasks.length || plan.entries.some(entry => plan.issues[entry.item.id]) || tasks.some(entry => !files.has(entry.item.sourcePath))) throw Error("图片处理计划不完整，请重新选择目录");
  const targetPaths = tasks.map(task => task.target.toLocaleLowerCase());
  if (new Set(targetPaths).size !== targetPaths.length) throw Error("输出路径重复，请调整后重试");
  checkAbort(signal);
  const { name, directory } = await freshOutputDirectory(root);
  const result: BatchRunResult = { directoryName: name, files: [], cancelled: false, skipped: plan.skipped, total: tasks.length };
  for (const entry of tasks) {
    if (signal.aborted) { result.cancelled = true; break; }
    onProgress({ phase: entry.review ? "保存待确认原图" : "压缩并命名", completed: result.files.length, total: tasks.length, file: entry.item.sourcePath });
    try {
      const source = files.get(entry.item.sourcePath)!;
      if (!source.size) throw Error(entry.item.error || "未能读取原图");
      const prepared = entry.review ? { blob: source, width: entry.item.width, height: entry.item.height, changed: false } : await prepareBatchImage(source, entry, signal);
      checkAbort(signal);
      if (entry.limit && prepared.blob.size > entry.limit) throw Error("生成文件超过体积上限");
      await writeNewFile(directory, entry.target, prepared.blob);
      result.files.push({ source: entry.item.sourcePath, target: entry.target, status: entry.review ? "review" : "success", beforeBytes: entry.item.size, afterBytes: prepared.blob.size, width: prepared.width, height: prepared.height, changed: prepared.changed, ...(entry.review ? { reasons: entry.reasons } : {}), ...(entry.item.groupNote ? { groupNote: entry.item.groupNote } : {}) });
    } catch (error) {
      if (signal.aborted) { result.cancelled = true; break; }
      result.files.push({ source: entry.item.sourcePath, target: entry.target, status: "failed", beforeBytes: entry.item.size, error: errorText(error) });
    }
    onProgress({ phase: "压缩并命名", completed: result.files.length, total: tasks.length, file: entry.item.sourcePath });
  }
  result.cancelled ||= signal.aborted;
  try { await writeNewFile(directory, "处理清单.json", JSON.stringify({ ...result, createdAt: new Date().toISOString() }, null, 2)); }
  catch (error) { result.reportError = errorText(error); }
  return result;
}
