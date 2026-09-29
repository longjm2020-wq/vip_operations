async function imageBlob(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("图片地址没有返回可用的图片文件");
  return blob;
}

async function pngBlob(url: string): Promise<Blob> {
  const blob = await imageBlob(url);
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法处理这张图片");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("图片转换失败")), "image/png"));
  } finally {
    bitmap.close();
  }
}

export async function copySelectionImage(url: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("当前浏览器不支持复制图片，请改用下载图片");
  // Start the clipboard write in the menu click's user gesture; the image can load asynchronously.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob(url) })]);
}

export async function downloadSelectionImage(url: string, name: string): Promise<void> {
  const blob = await imageBlob(url);
  const extension = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : blob.type === "image/gif" ? "gif" : "jpg";
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `${name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 100) || "图片"}.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
}
