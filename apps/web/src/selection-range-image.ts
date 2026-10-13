export type RangeImageCell = {
  text: string;
  background?: string;
  color?: string;
  align?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  image?: { url: string; label?: string; badge?: string };
  tags?: { label: string; color: string; background: string }[];
};
export type RangeImageTable = {
  columns: { key: string; label: string; width: number }[];
  rows: { key: string; cells: RangeImageCell[] }[];
  rowHeight: number;
};

const MAX_CELLS = 2000;
const MAX_SIDE = 12000;
const MAX_PIXELS = 24_000_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PADDING = 8;
const LINE_HEIGHT = 20;
const FONT = '14px "Microsoft YaHei", "PingFang SC", Arial, sans-serif';
const GRID_COLOR = "#e9ded7";
type MeasureText = (text: string, bold?: boolean) => number;
type TagLayout = {
  lines: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  lineWidth: number;
};
type CellLayout = {
  lines: string[];
  tags: TagLayout[];
  tagsHeight: number;
  imageHeight: number;
  imageLabelLines: string[];
  imageBadgeLines: string[];
  contentHeight: number;
};
export type RangeImageLayout = {
  width: number;
  height: number;
  scale: 1 | 2;
  headerHeight: number;
  headerLines: string[][];
  rowHeights: number[];
  cells: CellLayout[][];
};

const tooLarge = () => new Error("所选区域生成的图片过大，请减少行列或缩小列宽后重试（最长边 12000 像素、总面积 2400 万像素）。");

/** Wrap by Unicode character so Chinese text and explicit blank lines are kept. */
export function wrapRangeImageText(text: string, width: number, measure: MeasureText, bold = false): string[] {
  if (!text) return [];
  if (!(width > 0)) throw new Error("所选列宽过窄，无法完整显示内容，请加宽后重试。");
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const character of Array.from(paragraph)) {
      if (measure(character, bold) > width)
        throw new Error("所选列宽过窄，无法完整显示内容，请加宽后重试。");
      const next = line + character;
      if (line && measure(next, bold) > width) {
        lines.push(line);
        line = character;
      } else line = next;
      if (lines.length * LINE_HEIGHT > MAX_SIDE) throw tooLarge();
    }
    lines.push(line);
    if (lines.length * LINE_HEIGHT > MAX_SIDE) throw tooLarge();
  }
  return lines;
}

function layoutTags(tags: NonNullable<RangeImageCell["tags"]>, width: number, measure: MeasureText) {
  const result: TagLayout[] = [];
  let line: TagLayout[] = [], lineWidth = 0, y = 0;
  const finishLine = () => {
    if (!line.length) return;
    const lineHeight = Math.max(...line.map(tag => tag.height));
    let x = 0;
    for (const tag of line) {
      tag.x = x;
      tag.y = y;
      tag.lineWidth = lineWidth;
      x += tag.width + 4;
      result.push(tag);
    }
    y += lineHeight + 4;
    line = [];
    lineWidth = 0;
  };
  for (const tag of tags) {
    const lines = wrapRangeImageText(tag.label, width - 12, measure);
    const tagWidth = Math.max(12, ...lines.map(text => measure(text) + 12));
    const layout: TagLayout = { lines, x: 0, y: 0, width: tagWidth, height: Math.max(1, lines.length) * LINE_HEIGHT + 6, lineWidth: 0 };
    if (line.length && lineWidth + 4 + tagWidth > width) finishLine();
    lineWidth += (line.length ? 4 : 0) + tagWidth;
    line.push(layout);
  }
  finishLine();
  return { tags: result, height: Math.max(0, y - 4) };
}

/** Pure geometry; callers supply the same font measurement used to draw. */
export function layoutSelectionRangeImage(table: RangeImageTable, measure: MeasureText): RangeImageLayout {
  if (!table.columns.length) throw new Error("请先选择要复制的单元格或列。");
  if (table.rows.length * table.columns.length > MAX_CELLS)
    throw new Error("每次最多复制 2000 个单元格（另含表头），请缩小选择范围后重试。");
  if (!Number.isFinite(table.rowHeight) || table.rowHeight <= 0 || table.columns.some(column => !Number.isFinite(column.width) || column.width <= 0))
    throw new Error("所选区域的行高或列宽无效，请调整后重试。");
  const width = Math.ceil(table.columns.reduce((sum, column) => sum + column.width, 0));
  if (width > MAX_SIDE) throw tooLarge();
  const headerLines = table.columns.map(column => wrapRangeImageText(column.label, column.width - 2 * PADDING, measure, true));
  const headerHeight = Math.max(40, ...headerLines.map(lines => lines.length * LINE_HEIGHT + 2 * PADDING));
  let height = headerHeight;
  const rowHeights: number[] = [], cells: CellLayout[][] = [];
  for (const row of table.rows) {
    if (row.cells.length !== table.columns.length)
      throw new Error("所选区域的行列数据不一致，请刷新后重新选择。");
    const layouts = row.cells.map((cell, index): CellLayout => {
      const innerWidth = table.columns[index].width - 2 * PADDING;
      const lines = wrapRangeImageText(cell.text, innerWidth, measure);
      const tags = layoutTags(cell.tags || [], innerWidth, measure);
      const imageLabelLines = wrapRangeImageText(cell.image?.label || "", innerWidth - 8, measure);
      const imageBadgeLines = wrapRangeImageText(cell.image?.badge || "", innerWidth - 8, measure);
      // Reserve an actual photo area as well as full labels; labels never replace or crop the photo.
      const placeholderHeight = cell.image ? wrapRangeImageText("图片无法读取", innerWidth - 8, measure).length * LINE_HEIGHT : 0;
      const imageHeight = cell.image ? Math.max(80, Math.max(48, placeholderHeight) + (imageLabelLines.length + imageBadgeLines.length) * LINE_HEIGHT + 8) : 0;
      const blocks = [imageHeight, lines.length * LINE_HEIGHT, tags.height].filter(value => value > 0);
      const contentHeight = blocks.reduce((sum, value) => sum + value, 0) + Math.max(0, blocks.length - 1) * 4;
      return { lines, tags: tags.tags, tagsHeight: tags.height, imageHeight, imageLabelLines, imageBadgeLines, contentHeight };
    });
    const rowHeight = Math.ceil(Math.max(table.rowHeight, ...layouts.map(cell => cell.contentHeight + 2 * PADDING)));
    rowHeights.push(rowHeight);
    cells.push(layouts);
    height += rowHeight;
    if (height > MAX_SIDE || width * height > MAX_PIXELS) throw tooLarge();
  }
  if (height > MAX_SIDE || width * height > MAX_PIXELS) throw tooLarge();
  const scale = width * 2 <= MAX_SIDE && height * 2 <= MAX_SIDE && width * height * 4 <= MAX_PIXELS ? 2 : 1;
  return { width, height, scale, headerHeight, headerLines, rowHeights, cells };
}

export function rangeImageUrl(url: string, base: string): string {
  let value: URL;
  try { value = new URL(url, base); } catch { throw new Error("图片地址无效，请核对商品图片后重试。"); }
  if (value.protocol === "http:" || value.protocol === "https:") {
    if (value.protocol === "http:" && new URL(base).protocol === "https:") value.protocol = "https:";
    return value.href;
  }
  if (value.protocol === "data:" && /^data:image\/(?:png|jpe?g|webp|gif|avif|bmp)(?:;|,)/i.test(url)) {
    if (url.length > MAX_IMAGE_BYTES * 1.4) throw new Error("图片文件超过 20 MB，请更换图片后重试。");
    return value.href;
  }
  throw new Error("图片地址仅支持 HTTP、HTTPS 或常用位图格式，无法生成区域图片。");
}

async function boundedImageBlob(response: Response): Promise<Blob> {
  if (!response.ok || Number(response.headers.get("content-length") || 0) > MAX_IMAGE_BYTES) throw new Error("图片无法读取");
  const type = response.headers.get("content-type") || "";
  if (/image\/svg\+xml/i.test(type)) throw new Error("图片无法读取");
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > MAX_IMAGE_BYTES) throw new Error("图片无法读取");
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw new Error("图片无法读取");
      chunks.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return new Blob(chunks, { type });
}

type ImagePlacement = { width: number; height: number };
export function rangeImageBitmapSize(source: ImagePlacement, placements: ImagePlacement[]): ImagePlacement {
  if (source.width <= 0 || source.height <= 0 || source.width > 16384 || source.height > 16384 || source.width * source.height > 64_000_000)
    throw new Error("图片尺寸过大，无法读取");
  // Every placement has the same source aspect ratio. Keep the largest actual
  // contain size, rather than combining unrelated widest / tallest cells.
  const ratio = Math.min(1, Math.max(...placements.map(box => Math.min(box.width / source.width, box.height / source.height))));
  return { width: Math.max(1, Math.ceil(source.width * ratio)), height: Math.max(1, Math.ceil(source.height * ratio)) };
}

function timedBitmap(source: Blob | ImageBitmap, timeoutMs: number, options?: ImageBitmapOptions): Promise<ImageBitmap> {
  if (timeoutMs <= 0) return Promise.reject(new Error("图片无法读取"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => { settled = true; reject(new Error("图片无法读取")); }, timeoutMs);
    createImageBitmap(source, options).then(value => {
      if (settled) value.close();
      else { settled = true; clearTimeout(timeout); resolve(value); }
    }, error => {
      if (!settled) { settled = true; clearTimeout(timeout); reject(error); }
    });
  });
}

async function loadRangeImages(placements: Map<string, ImagePlacement[]>): Promise<Map<string, ImageBitmap | null>> {
  const urls = [...placements.keys()];
  const loaded = new Map<string, ImageBitmap | null>();
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, async () => {
    for (;;) {
      const url = urls[index++];
      if (url === undefined) return;
      const controller = new AbortController();
      const deadline = Date.now() + 10_000;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(url, { credentials: "same-origin", mode: "cors", signal: controller.signal });
        const blob = await boundedImageBlob(response);
        const original = await timedBitmap(blob, deadline - Date.now());
        let retained = false;
        try {
          const size = rangeImageBitmapSize(original, placements.get(url)!);
          if (size.width === original.width && size.height === original.height) {
            loaded.set(url, original);
            retained = true;
          } else loaded.set(url, await timedBitmap(original, deadline - Date.now(), {
            resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high",
          }));
        } finally { if (!retained) original.close(); }
      } catch { loaded.set(url, null); }
      finally { clearTimeout(timeout); }
    }
  }));
  return loaded;
}

function color(ctx: CanvasRenderingContext2D, value: string | undefined, fallback: string) {
  ctx.fillStyle = fallback;
  if (value) ctx.fillStyle = value;
}
function roundedBox(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 4);
  ctx.fill();
}
function drawLines(ctx: CanvasRenderingContext2D, lines: string[], x: number, y: number, width: number, align: RangeImageCell["align"] = "left") {
  ctx.textAlign = align;
  const textX = x + (align === "center" ? width / 2 : align === "right" ? width : 0);
  lines.forEach((line, index) => ctx.fillText(line, textX, y + index * LINE_HEIGHT));
}
function drawPhoto(ctx: CanvasRenderingContext2D, bitmap: ImageBitmap | null, layout: CellLayout, x: number, y: number, width: number, measure: MeasureText) {
  const height = layout.imageHeight;
  color(ctx, undefined, "#f7f5f3");
  ctx.fillRect(x, y, width, height);
  const badgeHeight = layout.imageBadgeLines.length ? layout.imageBadgeLines.length * LINE_HEIGHT + 4 : 0;
  const labelHeight = layout.imageLabelLines.length ? layout.imageLabelLines.length * LINE_HEIGHT + 4 : 0;
  const photoY = y + badgeHeight, photoHeight = height - badgeHeight - labelHeight;
  if (bitmap) {
    const ratio = Math.min(width / bitmap.width, photoHeight / bitmap.height);
    const photoWidth = bitmap.width * ratio, drawHeight = bitmap.height * ratio;
    ctx.drawImage(bitmap, x + (width - photoWidth) / 2, photoY + (photoHeight - drawHeight) / 2, photoWidth, drawHeight);
  } else {
    color(ctx, undefined, "#8b7f76");
    const lines = wrapRangeImageText("图片无法读取", width - 8, measure);
    drawLines(ctx, lines, x + 4, photoY + (photoHeight - lines.length * LINE_HEIGHT) / 2, width - 8, "center");
  }
  for (const [lines, top, align] of [
    [layout.imageBadgeLines, y, "right"],
    [layout.imageLabelLines, y + height - labelHeight, "left"],
  ] as const) {
    if (!lines.length) continue;
    const boxWidth = Math.max(...lines.map(line => measure(line))) + 8;
    const boxX = align === "right" ? x + width - boxWidth : x;
    color(ctx, undefined, "#5e5046");
    roundedBox(ctx, boxX, top, boxWidth, lines.length * LINE_HEIGHT + 4);
    color(ctx, undefined, "#ffffff");
    drawLines(ctx, [...lines], boxX + 4, top + 2, boxWidth - 8, align);
  }
}

/** Draws selected model rows directly, including rows outside the virtual viewport. */
export async function renderSelectionRangeImage(table: RangeImageTable): Promise<{ blob: Blob; missingImages: number; width: number; height: number }> {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前浏览器无法生成区域图片，请使用最新版 Chrome 或 Edge。");
  ctx.font = FONT;
  const measure: MeasureText = (text, bold = false) => {
    ctx.font = (bold ? "bold " : "") + FONT;
    return ctx.measureText(text).width;
  };
  const layout = layoutSelectionRangeImage(table, measure);
  const base = window.location.href;
  const imageUrls = table.rows.map(row => row.cells.map(cell => {
    if (!cell.image) return null;
    try { return rangeImageUrl(cell.image.url, base); }
    catch { return null; }
  }));
  const placements = new Map<string, ImagePlacement[]>();
  imageUrls.forEach((urls, rowIndex) => urls.forEach((url, columnIndex) => {
    if (!url) return;
    const cell = layout.cells[rowIndex][columnIndex];
    const labelHeight = cell.imageLabelLines.length ? cell.imageLabelLines.length * LINE_HEIGHT + 4 : 0;
    const badgeHeight = cell.imageBadgeLines.length ? cell.imageBadgeLines.length * LINE_HEIGHT + 4 : 0;
    const boxes = placements.get(url) || [];
    boxes.push({ width: (table.columns[columnIndex].width - 2 * PADDING) * layout.scale, height: (cell.imageHeight - labelHeight - badgeHeight) * layout.scale });
    placements.set(url, boxes);
  }));
  const images = await loadRangeImages(placements);
  let missingImages = 0;
  try {
    canvas.width = layout.width * layout.scale;
    canvas.height = layout.height * layout.scale;
    ctx.scale(layout.scale, layout.scale);
    ctx.font = FONT;
    ctx.textBaseline = "top";
    color(ctx, undefined, "#ffffff");
    ctx.fillRect(0, 0, layout.width, layout.height);
    let x = 0;
    table.columns.forEach((column, index) => {
      color(ctx, undefined, "#fff5ea");
      ctx.fillRect(x, 0, column.width, layout.headerHeight);
      color(ctx, undefined, "#5c4435");
      ctx.font = "bold " + FONT;
      drawLines(ctx, layout.headerLines[index], x + PADDING, (layout.headerHeight - layout.headerLines[index].length * LINE_HEIGHT) / 2, column.width - 2 * PADDING, "center");
      x += column.width;
    });
    let y = layout.headerHeight;
    table.rows.forEach((row, rowIndex) => {
      const height = layout.rowHeights[rowIndex];
      x = 0;
      row.cells.forEach((cell, columnIndex) => {
        const width = table.columns[columnIndex].width;
        const cellLayout = layout.cells[rowIndex][columnIndex];
        color(ctx, cell.background, "#ffffff");
        ctx.fillRect(x, y, width, height);
        ctx.font = FONT;
        const spare = height - 2 * PADDING - cellLayout.contentHeight;
        let contentY = y + PADDING + (cell.verticalAlign === "top" ? 0 : cell.verticalAlign === "bottom" ? spare : spare / 2);
        const innerWidth = width - 2 * PADDING;
        const imageUrl = imageUrls[rowIndex][columnIndex];
        if (cell.image) {
          const bitmap = imageUrl ? images.get(imageUrl) || null : null;
          if (!bitmap) missingImages++;
          drawPhoto(ctx, bitmap, cellLayout, x + PADDING, contentY, innerWidth, measure);
          contentY += cellLayout.imageHeight + 4;
        }
        if (cellLayout.lines.length) {
          color(ctx, cell.color, "#3b2d24");
          drawLines(ctx, cellLayout.lines, x + PADDING, contentY, innerWidth, cell.align);
          contentY += cellLayout.lines.length * LINE_HEIGHT + 4;
        }
        cellLayout.tags.forEach((tag, tagIndex) => {
          const style = cell.tags![tagIndex];
          const shift = cell.align === "center" ? (innerWidth - tag.lineWidth) / 2 : cell.align === "right" ? innerWidth - tag.lineWidth : 0;
          const tagX = x + PADDING + tag.x + shift, tagY = contentY + tag.y;
          color(ctx, style.background, "#fff2e8");
          roundedBox(ctx, tagX, tagY, tag.width, tag.height);
          color(ctx, style.color, "#874b28");
          drawLines(ctx, tag.lines, tagX + 6, tagY + 3, tag.width - 12, "center");
        });
        x += width;
      });
      y += height;
    });
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    x = 0;
    ctx.moveTo(0.5, 0); ctx.lineTo(0.5, layout.height);
    for (const column of table.columns) { x += column.width; ctx.moveTo(x - 0.5, 0); ctx.lineTo(x - 0.5, layout.height); }
    y = 0;
    ctx.moveTo(0, 0.5); ctx.lineTo(layout.width, 0.5);
    for (const height of [layout.headerHeight, ...layout.rowHeights]) { y += height; ctx.moveTo(0, y - 0.5); ctx.lineTo(layout.width, y - 0.5); }
    ctx.stroke();
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("区域图片生成失败，请缩小范围后重试。")), "image/png"));
    return { blob, missingImages, width: layout.width, height: layout.height };
  } finally {
    images.forEach(bitmap => bitmap?.close());
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Calls clipboard.write before awaiting image work, preserving the click gesture. */
export async function copySelectionRangeImage(table: RangeImageTable): Promise<{ missingImages: number }> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined" || ClipboardItem.supports?.("image/png") === false)
    throw new Error("当前浏览器不支持复制图片，请使用 HTTPS 页面下的最新版 Chrome 或 Edge。");
  let renderFailure: unknown;
  const rendered = renderSelectionRangeImage(table);
  const png = rendered.then(result => result.blob, error => { renderFailure = error; throw error; });
  // Some browsers reject permission before consuming the Blob promise.
  void png.catch(() => undefined);
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  } catch {
    if (renderFailure) throw renderFailure;
    throw new Error("未能写入图片剪贴板，请允许浏览器剪贴板权限，并重新点击“复制选区为图片”。");
  }
  const { missingImages } = await rendered;
  return { missingImages };
}
