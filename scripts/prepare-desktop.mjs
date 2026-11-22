import fs from "node:fs/promises";
import path from "node:path";
import { root, verifyDesktopArtifact } from "./desktop-artifact.mjs";
const { bytes, manifest } = await verifyDesktopArtifact();
const destination = path.join(root, "apps/web/public/downloads");
await fs.mkdir(destination, { recursive: true });
await fs.writeFile(path.join(destination, "xuti-desktop.zip"), bytes);
const { version, platform, sha256 } = manifest;
await fs.writeFile(
  path.join(destination, "xuti-desktop-release.json"),
  JSON.stringify({ version, platform, sha256 }) + "\n",
);
console.log(`Prepared verified Windows desktop ${manifest.version} download`);
