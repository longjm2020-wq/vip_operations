import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
export const root = path.resolve(import.meta.dirname, "..");
export const sourceFiles = [
  "apps/desktop/XutiDesktop.cs",
  "apps/desktop/DesktopShell.cs",
  "apps/desktop/app.manifest",
  "apps/desktop/启动小序.cmd",
  "apps/desktop/README.txt",
  "apps/desktop/version.json",
  "scripts/build-desktop.mjs",
  "scripts/desktop-artifact.mjs",
];
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export async function desktopSourceHashes() {
  return Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        sha256(
          (await fs.readFile(path.join(root, file), "utf8")).replace(
            /\r\n/g,
            "\n",
          ),
        ),
      ]),
    ),
  );
}
export async function verifyDesktopArtifact() {
  const release = path.join(root, "apps/desktop/release");
  const manifest = JSON.parse(
    await fs.readFile(path.join(release, "manifest.json"), "utf8"),
  );
  const actual = await desktopSourceHashes();
  for (const file of sourceFiles)
    if (manifest.sources[file] !== actual[file])
      throw new Error(
        `Desktop source changed: ${file}. Run pnpm build:desktop on Windows and commit the release bundle.`,
      );
  const bytes = await fs.readFile(
    path.join(release, "xuti-desktop-win-x64.zip"),
  );
  if (sha256(bytes) !== manifest.sha256)
    throw new Error("Desktop release checksum mismatch");
  return { bytes, manifest };
}
