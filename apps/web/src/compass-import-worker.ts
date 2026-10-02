import { readWorkbook } from "./sheet-excel";
import { normalizeCompassWorkbook } from "../../../packages/contracts/src/compass-analytics";
self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const file = event.data;
    const sheets = await readWorkbook(file, {
      formattedCells: true,
      maxFileSizeMB: 100,
      maxRows: 200000,
    });
    if (sheets.length !== 1)
      throw Error("请上传罗盘下载中心的单工作表原始报表");
    const report = normalizeCompassWorkbook(sheets[0].rows, file.name);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await file.arrayBuffer(),
    );
    const fileHash = Array.from(new Uint8Array(digest))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    self.postMessage({ report, fileHash });
  } catch (e) {
    self.postMessage({ error: (e as Error).message });
  }
};
