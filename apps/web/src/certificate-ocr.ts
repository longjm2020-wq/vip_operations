import { extractCertificateNumbers } from "../../../packages/contracts/src/qualification-validation";
export async function recognizeCertificate(
  file: File,
  kind: "legalId" | "creditCode",
  progress: (value: number) => void,
): Promise<string[]> {
  const { createWorker, PSM } = await import("tesseract.js");
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        worker = await createWorker(["chi_sim", "eng"], 1, {
          workerPath: location.origin + "/ocr/worker.min.js",
          corePath: location.origin + "/ocr/core",
          langPath: location.origin + "/ocr",
          logger: (m) => {
            if (m.status === "recognizing text")
              progress(Math.round(m.progress * 100));
          },
        });
        if (expired) {
          await worker.terminate();
          throw Error("识别超时");
        }
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
        const { data } = await worker.recognize(file);
        return extractCertificateNumbers(data.text, kind);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(Error("识别超时，请上传清晰正向照片或手动填写"));
        }, 120000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (worker) await worker.terminate();
  }
}
