export type OfficeClipboardImage = { rowId: string; columnKey: string; imageId: string };
export type OfficeClipboardCell = { text: string; image?: OfficeClipboardImage; imageLabel?: string };
type ReadyImage = { url: string; width: number; height: number; jpeg?: Blob; png?: Blob };
type ImageLink = { rowId: string; columnKey: string; url: string };
export type OfficeClipboardPayload = { cells: OfficeClipboardCell[][]; text: string; html: string; images: ReadonlyMap<string, ReadyImage>; refreshAfter: number };
const imageKey = (image: Pick<OfficeClipboardImage, "rowId" | "columnKey">) => `${image.rowId}::${image.columnKey}`;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

/** HTML is a cell grid, never a flattened screenshot or a collection of URLs. */
export function officeClipboardHtml(cells: OfficeClipboardCell[][], images: ReadonlyMap<string, ReadyImage> = new Map()) {
  const rows = cells.map(row => {
    const height = row.some(cell => cell.image) ? 100 : undefined;
    return `<tr${height ? ` height="${height}" style="height:${height * .75}pt"` : ""}>${row.map(cell => {
      const picture = cell.image && images.get(imageKey(cell.image));
      const content = picture
        ? `<img src="${escapeHtml(picture.url)}" width="${picture.width}" height="${picture.height}" alt="图片">`
        : escapeHtml(cell.text).replace(/\r\n?|\n/g, '<br style="mso-data-placement:same-cell">');
      return `<td width="120" valign="middle" style="mso-number-format:'\\@';white-space:pre-wrap;vertical-align:middle">${content}</td>`;
    }).join("")}</tr>`;
  }).join("");
  return `<html><head><meta charset="utf-8"></head><body><!--StartFragment--><table border="0" cellpadding="3" cellspacing="0">${rows}</table><!--EndFragment--></body></html>`;
}

async function prepareOfficeImages(
  cells: OfficeClipboardCell[][],
  prepare: (images: OfficeClipboardImage[]) => Promise<ImageLink[]>,
  signal: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
) {
  const entries = cells.flatMap((row, rowIndex) => row.flatMap((cell, columnIndex) => cell.image
    ? [{ image: cell.image, label: cell.imageLabel || `选区第 ${rowIndex + 1} 行，第 ${columnIndex + 1} 列` }] : []));
  const selected = entries.map(entry => entry.image);
  if (selected.length > 500) throw Error("每次最多复制 500 个图片单元格，请分段复制");
  if (selected.some(image => !/^[1-9]\d*$/.test(image.rowId))) throw Error("请先保存图片所在行，再复制到 Excel / WPS");
  const links = await prepare(selected);
  const byKey = new Map(links.map(link => [imageKey(link), link.url]));
  const prepared = new Map<string, ReadyImage>();
  onProgress?.(0, selected.length);
  let next = 0;
  const singleImage = cells.length === 1 && cells[0].length === 1;
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (next < selected.length) {
      const index = next++, { image, label } = entries[index];
      signal.throwIfAborted();
      try {
        const link = byKey.get(imageKey(image));
        if (!link) throw Error("图片复制资料不完整，请刷新后重新复制");
        const url = new URL(link, window.location.origin);
        if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/v1/selection-clipboard/"))
          throw Error("图片复制链接无效，请刷新后重新复制");
        const response = await fetch(url, { signal, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" });
        if (!response.ok) {
          const result = await response.json().catch(() => null);
          throw Error(result?.error?.message || "部分图片无法读取或权限已变化，请刷新后重新复制");
        }
        const blob = await response.blob();
        if (blob.type !== "image/jpeg" || blob.size > 1024 * 1024) throw Error("图片格式或大小异常，请重新上传该图片后复制");
        const bitmap = await createImageBitmap(blob);
        try {
          const scale = Math.min(1, 110 / bitmap.width, 94 / bitmap.height);
          const ready: ReadyImage = { url: url.href, width: Math.max(1, Math.round(bitmap.width * scale)), height: Math.max(1, Math.round(bitmap.height * scale)), jpeg: blob };
          if (singleImage) {
            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            const context = canvas.getContext("2d");
            if (!context) throw Error("浏览器无法复制图片");
            context.drawImage(bitmap, 0, 0);
            ready.png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(Error("图片复制失败")), "image/png"));
          }
          prepared.set(imageKey(image), ready);
          onProgress?.(prepared.size, selected.length);
        } finally { bitmap.close(); }
      } catch (error) {
        signal.throwIfAborted();
        const reason = error instanceof TypeError ? "图片连接中断，请重试" : (error as Error).message || "图片读取失败，请重试";
        throw Error(`${label}（第 ${index + 1}/${selected.length} 张图片）准备失败：${reason}`);
      }
    }
  }));
  signal.throwIfAborted();
  return prepared;
}

export async function prepareOfficeClipboard(
  cells: OfficeClipboardCell[][],
  text: string,
  prepare: (images: OfficeClipboardImage[]) => Promise<ImageLink[]>,
  signal: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
) {
  // Refresh before the server's 15-minute capability expires, including preparation time.
  const refreshAfter = Date.now() + 13 * 60_000;
  const images = await prepareOfficeImages(cells, prepare, signal, onProgress);
  return { cells, text, html: officeClipboardHtml(cells, images), images, refreshAfter };
}

/** All bytes must be ready before touching the clipboard or switching apps. */
export async function writeOfficeClipboard(payload: OfficeClipboardPayload) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
    throw Error("浏览器无法写入图文剪贴板，可在此窗口按 Ctrl+C，或下载带图表格");
  const representations: Record<string, Blob> = {
    "text/html": new Blob([payload.html], { type: "text/html" }),
    "text/plain": new Blob([payload.text], { type: "text/plain" }),
  };
  const png = payload.images.size === 1 && payload.cells.length === 1 && payload.cells[0].length === 1
    ? payload.images.values().next().value?.png : undefined;
  if (png) representations["image/png"] = png;
  await navigator.clipboard.write([new ClipboardItem(representations)]);
}
