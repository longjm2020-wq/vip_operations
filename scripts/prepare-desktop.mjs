import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
const root = path.resolve(import.meta.dirname, "..");
const zip = new JSZip();
for (const name of ["XutiDesktop.cs", "app.manifest", "启动小序.cmd"]) {
  let data = await fs.readFile(path.join(root, "apps/desktop", name));
  if (name.endsWith(".cmd"))
    data = Buffer.from(data.toString("utf8").replace(/\r?\n/g, "\r\n"));
  zip.file(name, data);
}
const destination = path.join(root, "apps/web/public/downloads");
await fs.mkdir(destination, { recursive: true });
await fs.writeFile(
  path.join(destination, "xuti-desktop.zip"),
  await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
);
console.log("Prepared Windows assistant download");
