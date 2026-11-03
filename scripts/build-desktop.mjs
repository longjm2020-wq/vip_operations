import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";
import sharp from "sharp";
import {
  root,
  sha256,
  sourceFiles,
  desktopSourceHashes,
} from "./desktop-artifact.mjs";

if (process.platform !== "win32")
  throw new Error(
    "Build the Windows client on Windows; web builds use the verified release bundle.",
  );
const config = JSON.parse(
  await fs.readFile(path.join(root, "apps/desktop/version.json"), "utf8"),
);
const buildRoot = path.join(root, ".local/desktop-client-build");
const build = path.join(buildRoot, `run-${Date.now()}`);
await fs.mkdir(build, { recursive: true });
const sdkFile = path.join(buildRoot, "webview2.nupkg");
let sdk;
try {
  sdk = await fs.readFile(sdkFile);
} catch {
  /* Download once; verify before extraction. */
}
if (!sdk || sha256(sdk) !== config.sdkSha256) {
  const response = await fetch(
    `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${config.sdk}/microsoft.web.webview2.${config.sdk}.nupkg`,
    { signal: AbortSignal.timeout(90000) },
  );
  if (!response.ok)
    throw new Error(`WebView2 SDK download failed: ${response.status}`);
  sdk = Buffer.from(await response.arrayBuffer());
  if (sha256(sdk) !== config.sdkSha256)
    throw new Error("WebView2 SDK checksum mismatch");
  await fs.writeFile(sdkFile, sdk);
}
const archive = await JSZip.loadAsync(sdk);
const libraries = [
  "lib/net462/Microsoft.Web.WebView2.Core.dll",
  "lib/net462/Microsoft.Web.WebView2.WinForms.dll",
  "runtimes/win-x64/native/WebView2Loader.dll",
  "LICENSE.txt",
];
for (const name of libraries)
  await fs.writeFile(
    path.join(build, path.basename(name)),
    await archive.file(name).async("nodebuffer"),
  );
const iconPng = await sharp(
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" rx="56" fill="#4658ef"/><path d="M62 68L128 128L194 68M62 188L128 128L194 188" fill="none" stroke="white" stroke-width="22" stroke-linejoin="round"/></svg>',
  ),
)
  .png()
  .toBuffer();
const iconHeader = Buffer.alloc(22);
iconHeader.writeUInt16LE(1, 2);
iconHeader.writeUInt16LE(1, 4);
iconHeader.writeUInt16LE(1, 10);
iconHeader.writeUInt16LE(32, 12);
iconHeader.writeUInt32LE(iconPng.length, 14);
iconHeader.writeUInt32LE(22, 18);
await fs.writeFile(
  path.join(build, "xuti.ico"),
  Buffer.concat([iconHeader, iconPng]),
);
const framework = path.join(
  process.env.WINDIR || "C:/Windows",
  "Microsoft.NET/Framework64/v4.0.30319",
);
const exe = path.join(build, "XutiDesktop.exe");
const args = [
  "/nologo",
  "/target:winexe",
  "/platform:x64",
  "/optimize+",
  "/utf8output",
  `/win32manifest:${path.join(root, "apps/desktop/app.manifest")}`,
  `/win32icon:${path.join(build, "xuti.ico")}`,
  `/out:${exe}`,
  ...[
    "System.Net.Http.dll",
    "System.Web.Extensions.dll",
    "System.Security.dll",
    "System.Drawing.dll",
    "System.Windows.Forms.dll",
    ...[
      "WindowsBase.dll",
      "UIAutomationClient.dll",
      "UIAutomationTypes.dll",
    ].map((n) => path.join(framework, "WPF", n)),
    path.join(build, "Microsoft.Web.WebView2.Core.dll"),
    path.join(build, "Microsoft.Web.WebView2.WinForms.dll"),
  ].map((n) => `/reference:${n}`),
  path.join(root, "apps/desktop/XutiDesktop.cs"),
  path.join(root, "apps/desktop/DesktopShell.cs"),
];
const result = spawnSync(path.join(framework, "csc.exe"), args, {
  stdio: "inherit",
  windowsHide: true,
});
if (result.error || result.status !== 0)
  throw new Error("Desktop compilation failed");
const test = spawnSync(exe, ["--self-test"], {
  stdio: "inherit",
  windowsHide: true,
});
if (test.error || test.status !== 0)
  throw new Error("Desktop self-test failed");
const sources = await desktopSourceHashes();
const zip = new JSZip();
const add = (name, bytes) =>
  zip.file(name, bytes, { date: new Date("2026-11-03T00:00:00Z") });
for (const name of [
  "XutiDesktop.exe",
  ...libraries.filter((n) => n.endsWith(".dll")).map((n) => path.basename(n)),
])
  add(name, await fs.readFile(path.join(build, name)));
add(
  "licenses/Microsoft.Web.WebView2.txt",
  await fs.readFile(path.join(build, "LICENSE.txt")),
);
add(
  "启动小序.cmd",
  (
    await fs.readFile(path.join(root, "apps/desktop/启动小序.cmd"), "utf8")
  ).replace(/\r?\n/g, "\r\n"),
);
add(
  "使用说明.txt",
  await fs.readFile(path.join(root, "apps/desktop/README.txt")),
);
for (const file of sourceFiles.filter(
  (n) => n.startsWith("apps/desktop/") && !n.endsWith(".cmd"),
))
  add(
    "source/" + path.basename(file),
    (await fs.readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n"),
  );
const bytes = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
});
const release = path.join(root, "apps/desktop/release");
await fs.mkdir(release, { recursive: true });
await fs.writeFile(path.join(release, "xuti-desktop-win-x64.zip"), bytes);
await fs.writeFile(
  path.join(release, "manifest.json"),
  JSON.stringify(
    {
      version: config.version,
      platform: "win-x64",
      sha256: sha256(bytes),
      sources,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Windows desktop ${config.version}: ${bytes.length} bytes, compiled and self-tested.`,
);
await fs.writeFile(
  path.join(buildRoot, "latest.json"),
  JSON.stringify({ executable: exe }),
);
console.log(`Executable: ${exe}`);
