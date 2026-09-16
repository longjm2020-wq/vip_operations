const IMAGE_LIMIT = 1024 * 1024;
const DOCUMENT_LIMIT = 50 * 1024 * 1024;

export async function prepareUpload(file: File): Promise<File> {
  if (!file.size) throw new Error("文件不能为空");
  if (file.type.startsWith("image/")) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      throw new Error("请选择 JPG、PNG 或 WebP 图片");
    if (file.size < IMAGE_LIMIT) return file;
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement("canvas");
      let scale = Math.min(1, 3000 / Math.max(bitmap.width, bitmap.height));
      for (let attempt = 0; attempt < 12; attempt++) {
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("浏览器不支持图片压缩");
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(
            resolve,
            "image/webp",
            Math.max(0.65, 0.9 - attempt * 0.04),
          ),
        );
        if (blob && blob.size < IMAGE_LIMIT)
          return new File(
            [blob],
            file.name.replace(/\.[^.]+$/, "") +
              (blob.type === "image/webp" ? ".webp" : ".png"),
            { type: blob.type },
          );
        scale *= 0.78;
      }
      throw new Error("图片无法压缩至1 MB以下，请缩小尺寸后重试");
    } finally {
      bitmap.close();
    }
  }
  if (file.size < DOCUMENT_LIMIT) return file;
  if (typeof CompressionStream === "undefined")
    throw new Error(
      "当前浏览器不支持文档压缩，请使用新版浏览器或先压缩至50 MB以下",
    );
  const reader = file
    .stream()
    .pipeThrough(new CompressionStream("gzip"))
    .getReader();
  const chunks: BlobPart[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size >= DOCUMENT_LIMIT) {
        await reader.cancel();
        throw new Error("文档压缩后仍超过50 MB，请拆分或优化文档后上传");
      }
      chunks.push(new Uint8Array(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  return new File(chunks, file.name + ".gz", { type: "application/gzip" });
}

export function readUpload(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取文件失败，请重试"));
    reader.readAsDataURL(file);
  });
}
