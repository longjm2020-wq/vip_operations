import {
  extractCertificateFields,
  mergeCertificateFields,
  expectedFields,
  type CertificateKind,
  type CertificateFields,
} from "../../../packages/contracts/src/certificate-fields";

async function prepare(file: Blob, rotation: number) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(2, 2600 / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale),
      height = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = rotation % 180 ? height : width;
    canvas.height = rotation % 180 ? width : height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.filter = "grayscale(1) contrast(1.25)";
    ctx.drawImage(bitmap, -width / 2, -height / 2, width, height);
    return canvas;
  } finally {
    bitmap.close();
  }
}

export async function recognizeCertificate(
  file: Blob,
  kind: CertificateKind,
  progress: (message: string) => void,
  signal?: AbortSignal,
): Promise<CertificateFields> {
  const { createWorker, PSM } = await import("tesseract.js");
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let stopped = false;
  let pass = "加载识别资源";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      (async () => {
        progress("加载识别资源，首次识别可能需要较长时间…");
        worker = await createWorker(["chi_sim", "eng"], 1, {
          workerPath: location.origin + "/ocr/worker.min.js",
          corePath: location.origin + "/ocr/core",
          langPath: location.origin + "/ocr",
          logger: (m) => {
            if (!stopped && m.status === "recognizing text")
              progress(`${pass} ${Math.round(m.progress * 100)}%`);
          },
        });
        if (stopped) {
          await worker.terminate();
          throw Error("识别已取消");
        }
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
        let fields: CertificateFields = {};
        for (const rotation of [null, 0, 90, 270, 180]) {
          if (stopped) throw Error("识别已取消");
          pass = rotation ? `尝试旋转${rotation}°识别` : "识别证件文字";
          const canvas =
            rotation === null ? file : await prepare(file, rotation);
          if (stopped) throw Error("识别已取消");
          const { data } = await worker.recognize(canvas);
          fields = mergeCertificateFields(
            fields,
            extractCertificateFields(data.text, kind),
          );
          if (expectedFields[kind].every((f) => fields[f]?.length)) break;
        }
        return fields;
      })(),
      new Promise<never>((_, reject) => {
        abort = () => {
          stopped = true;
          reject(Error("识别已取消"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          stopped = true;
          reject(Error("识别超时，请重试或上传文字清晰、证件占满画面的照片"));
        }, 180000);
      }),
    ]);
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    if (worker) await worker.terminate();
  }
}
