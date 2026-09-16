import { expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { randomFillSync } from "node:crypto";
import { prepareUpload } from "../../apps/web/src/upload-file.js";
it("preserves small documents and losslessly compresses large documents", async () => {
  const small = new File(["hello"], "notes.txt", { type: "text/plain" });
  expect(await prepareUpload(small)).toBe(small);
  const bytes = new Uint8Array(50 * 1024 * 1024).fill(65);
  const result = await prepareUpload(
    new File([bytes], "report.txt", { type: "text/plain" }),
  );
  expect(result.name).toBe("report.txt.gz");
  expect(result.size).toBeLessThan(50 * 1024 * 1024);
  expect(
    Buffer.compare(
      gunzipSync(Buffer.from(await result.arrayBuffer())),
      Buffer.from(bytes),
    ),
  ).toBe(0);
});
it("rejects incompressible documents instead of truncating them", async () => {
  const bytes = randomFillSync(new Uint8Array(50 * 1024 * 1024));
  await expect(
    prepareUpload(
      new File([bytes], "archive.pdf", { type: "application/pdf" }),
    ),
  ).rejects.toThrow("拆分");
}, 15000);
