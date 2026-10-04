import type { Worker } from "tesseract.js";
import { absoluteSelectionImageUrl } from "./selection-image-actions";

export type ImageTextRegion = { left: number; top: number; width: number; height: number };
export type ImageTextView = { rotation: number; flipX: boolean; flipY: boolean; region?: ImageTextRegion };
export type ImageTextProgress = { label: string; percent?: number };

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("识别已取消", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

// Crop in the coordinates of the displayed, rotated/flipped image. Bound the canvas
// so a large source photo does not require a large OCR working image.
function prepare(bitmap: ImageBitmap, view: ImageTextView) {
  const turned = Math.abs(view.rotation % 180) === 90;
  const width = turned ? bitmap.height : bitmap.width, height = turned ? bitmap.width : bitmap.height;
  const region = view.region || { left: 0, top: 0, width: 1, height: 1 };
  const scale = Math.min(2, 2400 / Math.max(width * region.width, height * region.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * region.width * scale));
  canvas.height = Math.max(1, Math.round(height * region.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw Error("浏览器无法处理这张图片");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  context.translate(width / 2 - region.left * width, height / 2 - region.top * height);
  context.rotate(view.rotation * Math.PI / 180);
  context.scale(view.flipX ? -1 : 1, view.flipY ? -1 : 1);
  context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  return canvas;
}

export async function recognizeSelectionImageText(url: string, view: ImageTextView, signal: AbortSignal, progress: (value: ImageTextProgress) => void): Promise<string> {
  let worker: Worker | undefined, bitmap: ImageBitmap | undefined;
  const stop = new AbortController();
  const timeout = setTimeout(() => stop.abort(), 90_000);
  const cancel = () => stop.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) stop.abort();
  try {
    progress({ label: "正在读取图片…" });
    const response = await fetch(absoluteSelectionImageUrl(url), { credentials: "same-origin", signal: stop.signal });
    if (!response.ok) throw Error(`图片读取失败（HTTP ${response.status}）`);
    const file = await response.blob();
    if (!file.type.startsWith("image/")) throw Error("图片地址没有返回可用的图片文件");
    bitmap = await createImageBitmap(file);
    if (stop.signal.aborted) throw new DOMException("识别已取消", "AbortError");
    const canvas = prepare(bitmap, view);
    bitmap.close(); bitmap = undefined;
    progress({ label: "正在准备文字识别…" });
    const { createWorker, PSM } = await import("tesseract.js");
    stop.signal.throwIfAborted();
    const loading = createWorker(["chi_sim", "eng"], 1, {
      workerPath: location.origin + "/ocr/worker.min.js", corePath: location.origin + "/ocr/core", langPath: location.origin + "/ocr",
      logger: value => { if (!stop.signal.aborted && value.status === "recognizing text") progress({ label: "正在识别文字…", percent: Math.round(value.progress * 100) }); },
      errorHandler: () => {},
    });
    // Initialization cannot be interrupted by the library; dispose a late worker
    // even when the user has already closed the preview or changed the picture.
    void loading.then(value => { if (stop.signal.aborted) void value.terminate(); }, () => {});
    worker = await abortable(loading, stop.signal);
    await abortable(worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO }), stop.signal);
    const { data } = await abortable(worker.recognize(canvas), stop.signal);
    const text = data.text.replace(/\r\n?/g, "\n").trim();
    if (!text) throw Error("未识别到文字，请框选文字区域或换一张更清晰的图片");
    return text;
  } catch (error) {
    if (stop.signal.aborted && !signal.aborted) throw Error("识别用时较长，请框选较小的文字区域后重试");
    throw error;
  } finally {
    clearTimeout(timeout); signal.removeEventListener("abort", cancel);
    bitmap?.close();
    await worker?.terminate();
  }
}
