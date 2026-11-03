import fs from "node:fs/promises";
import path from "node:path";
import { root, verifyDesktopArtifact } from "./desktop-artifact.mjs";
const { bytes, manifest } = await verifyDesktopArtifact();
const destination = path.join(root, "apps/web/public/downloads");
await fs.mkdir(destination, { recursive: true });
await fs.writeFile(path.join(destination, "xuti-desktop.zip"), bytes);
console.log(`Prepared verified Windows desktop ${manifest.version} download`);
