import { mkdir, readdir, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const target = "apps/web/public/ocr";
await mkdir(target + "/core", { recursive: true });
const worker = path.dirname(require.resolve("tesseract.js/package.json"));
const core = path.dirname(require.resolve("tesseract.js-core/package.json"));
await copyFile(
  path.join(worker, "dist/worker.min.js"),
  target + "/worker.min.js",
);
await copyFile(
  path.join(worker, "LICENSE.md"),
  target + "/LICENSE-tesseract.txt",
);
for (const file of await readdir(core)) {
  if (/\.wasm(?:\.js)?$/.test(file) || /license/i.test(file))
    await copyFile(path.join(core, file), path.join(target, "core", file));
}
