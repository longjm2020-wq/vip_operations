import {
  extractCertificateFields,
  mergeCertificateFields,
  expectedFields,
  type CertificateKind,
  type CertificateFields,
} from "../../../packages/contracts/src/certificate-fields";
import type { Worker } from "tesseract.js";
let cached: Worker | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve();
function prepare(bitmap: ImageBitmap, rotation: number, contrast = false) {
  const scale = Math.min(contrast ? 2 : 1, 2000 / Math.max(bitmap.width, bitmap.height));
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
  if (contrast) ctx.filter = "grayscale(1) contrast(1.25)";
  ctx.drawImage(bitmap, -width / 2, -height / 2, width, height);
  return canvas;
}
async function run(
  file: Blob,
  kind: CertificateKind,
  signal?: AbortSignal,
  onFields?: (f: CertificateFields) => void,
): Promise<CertificateFields> {
  if (signal?.aborted) throw Error("识别已取消");
  if (idleTimer) clearTimeout(idleTimer);
  let bitmap: ImageBitmap | undefined,
    worker: Worker | undefined,
    stopped = false;
  let fields: CertificateFields = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      (async () => {
        const { createWorker, PSM } = await import("tesseract.js");
        worker =
          cached ||
          (await createWorker(["chi_sim", "eng"], 1, {
            workerPath: location.origin + "/ocr/worker.min.js",
            corePath: location.origin + "/ocr/core",
            langPath: location.origin + "/ocr",
          }));
        if (stopped) {
          await worker.terminate();
          throw Error("识别已取消");
        }
        cached = worker;
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
        bitmap = await createImageBitmap(file);
        if (stopped) {bitmap.close();throw Error("识别已取消");}
        const rotations =
          kind === "idFront" && bitmap.height > bitmap.width
            ? [90, 270, 0, 180]
            : [0, 90, 270, 180];
        for (const rotation of rotations) {
          if (stopped) throw Error("识别已取消");
          const { data } = await worker.recognize(prepare(bitmap, rotation));
          if (stopped) throw Error("识别已取消");
          fields = mergeCertificateFields(
            fields,
            extractCertificateFields(data.text, kind),
          );
          onFields?.(fields);
          if (expectedFields[kind].every((f) => fields[f]?.length)) break;
          // A valid identifier gives us the orientation; one contrast retry is enough.
          if (fields[kind === "idFront" ? "legalId" : "creditCode"]?.length) {
            const retry = await worker.recognize(
              prepare(bitmap, rotation, true),
            );
            if (stopped) throw Error("识别已取消");
            fields = mergeCertificateFields(
              fields,
              extractCertificateFields(retry.data.text, kind),
            );
            onFields?.(fields);
            break;
          }
        }
        return fields;
      })(),
      new Promise<CertificateFields>((resolve, reject) => {
        abort = () => {
          stopped = true;
          reject(Error("识别已取消"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          stopped = true;
          if (Object.keys(fields).length) resolve(fields);
          else
            reject(Error("未可靠识别，请使用清晰、完整的证件照片或手动填写"));
        }, 45000);
      }),
    ]);
  } catch(e) {
    stopped=true;throw e;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    bitmap?.close();
    if (stopped && worker) {
      if (cached === worker) cached = undefined;
      await worker.terminate();
    } else if (cached)
      idleTimer = setTimeout(() => {
        const old = cached;
        cached = undefined;
        void old?.terminate();
      }, 60000);
  }
}
export function recognizeCertificate(
  file: Blob,
  kind: CertificateKind,
  _progress: (message: string) => void = () => {},
  signal?: AbortSignal,
  onFields?: (f: CertificateFields) => void,
) {
  const result = queue.then(() => run(file, kind, signal, onFields));
  queue = result.catch(() => {});
  return result;
}
