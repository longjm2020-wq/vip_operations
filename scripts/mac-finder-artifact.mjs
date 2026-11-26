import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "apps/desktop-mac");
const release = path.join(source, "release");
const archive = "xuti-finder-macos.zip";
const hash = data => createHash("sha256").update(data).digest("hex");

async function sourceHashes() {
  const names = (await fs.readdir(source)).filter(name =>
    name.endsWith(".swift") || name.endsWith(".plist")
  ).sort();
  const paths = [...names.map(name => "apps/desktop-mac/" + name), "scripts/mac-finder-artifact.mjs"];
  return Object.fromEntries(await Promise.all(paths.map(async name =>
    [name, hash((await fs.readFile(path.join(root, name), "utf8")).replace(/\r\n/g, "\n"))]
  )));
}

export async function prepareMacFinder() {
  const manifest = JSON.parse(await fs.readFile(path.join(release, "manifest.json"), "utf8"));
  const bytes = await fs.readFile(path.join(release, archive));
  if (manifest.platform !== "macos-universal" || hash(bytes) !== manifest.sha256 ||
      !isDeepStrictEqual(await sourceHashes(), manifest.sources))
    throw new Error("The Mac Finder download does not match its release manifest and current sources.");
  const downloads = path.join(root, "apps/web/public/downloads");
  await fs.mkdir(downloads, { recursive: true });
  await fs.writeFile(path.join(downloads, archive), bytes);
  console.log(`Prepared verified Mac Finder download ${manifest.version}`);
}

async function buildMacFinder() {
  if (process.platform !== "darwin") throw new Error("Building the Finder client requires macOS and Xcode.");
  const build = await fs.mkdtemp(path.join(os.tmpdir(), "xuti-finder-build-"));
  const bundle = path.join(build, "XutiFinder.app");
  const contents = path.join(bundle, "Contents");
  const executable = path.join(contents, "MacOS", "XutiFinder");
  const plist = path.join(contents, "Info.plist");
  const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
  try {
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.copyFile(path.join(source, "Info.plist"), plist);
    run("plutil", ["-lint", plist]);
    const sources = await sourceHashes();
    const swift = Object.keys(sources).filter(name => name.endsWith(".swift")).map(name => path.join(root, name));
    for (const arch of ["arm64", "x86_64"]) {
      run("xcrun", ["swiftc", "-O", "-swift-version", "5", "-target", arch + "-apple-macos12.0",
        "-framework", "Cocoa", "-framework", "ApplicationServices", "-framework", "Security",
        ...swift, "-o", path.join(build, arch)]);
    }
    run("xcrun", ["lipo", "-create", path.join(build, "arm64"), path.join(build, "x86_64"), "-output", executable]);
    run("codesign", ["--force", "--sign", "-", bundle]);
    run("codesign", ["--verify", "--strict", "--verbose", bundle]);
    run("xcrun", ["lipo", executable, "-verify_arch", "arm64", "x86_64"]);
    run(executable, ["--self-test"]);
    const version = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist], { encoding: "utf8" }).trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid Finder client version");
    await fs.mkdir(release, { recursive: true });
    const zip = path.join(build, archive);
    run("ditto", ["-c", "-k", "--keepParent", bundle, zip]);
    await fs.copyFile(zip, path.join(release, archive));
    const sha256 = hash(await fs.readFile(zip));
    await fs.writeFile(path.join(release, "manifest.json"), JSON.stringify({
      version, platform: "macos-universal", sha256, sources
    }, null, 2) + "\n");
    console.log(`Mac Finder ${version} ${sha256}`);
  } finally {
    await fs.rm(build, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await buildMacFinder();
