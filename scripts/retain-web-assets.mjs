import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const manifestPath = "/web-assets.json";
const maxAssets = 512;
const maxAssetBytes = 16 * 1024 * 1024;
const assetName =
  /^[A-Za-z0-9][\w.-]*-[\w-]{8}\.(?:js|css|wasm|woff2?|ttf|png|svg|webp|jpe?g|avif|gif)$/;
const assetReference =
  /(?:["'(`])(?:\.?\/)?(?:assets\/)?([A-Za-z0-9][\w.-]*-[\w-]{8}\.(?:js|css|wasm|woff2?|ttf|png|svg|webp|jpe?g|avif|gif))(?=["'`)])/g;

const distinctAssets = (names) =>
  [
    ...new Set(
      names.filter((name) => typeof name === "string" && assetName.test(name)),
    ),
  ].sort();

async function readBytes(origin, path) {
  const response = await fetch(new URL(path, origin), {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok)
    throw Object.assign(Error(`${path} returned HTTP ${response.status}`), {
      status: response.status,
    });
  if (Number(response.headers.get("content-length")) > maxAssetBytes)
    throw Error(`${path} exceeds the asset size limit`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxAssetBytes)
    throw Error(`${path} exceeds the asset size limit`);
  if (
    path.startsWith("/assets/") &&
    /text\/html/i.test(response.headers.get("content-type") || "")
  )
    throw Error(`${path} returned HTML instead of a built asset`);
  return bytes;
}

const references = (text) =>
  distinctAssets(
    Array.from(text.matchAll(assetReference), (match) => match[1]),
  );

// Bootstrap the first retention-enabled release from the preceding Vite build.
// The HTML entry and Vite's generated dependency lists name the immutable files.
async function readPreviousRelease(origin) {
  let manifest;
  try {
    manifest = JSON.parse((await readBytes(origin, manifestPath)).toString());
  } catch (error) {
    if (error.status !== 404 && !(error instanceof SyntaxError)) throw error;
    return {
      pending: references((await readBytes(origin, "/index.html")).toString()),
      scan: true,
    };
  }
  if (!Array.isArray(manifest?.assets) || manifest.assets.length > maxAssets)
    throw Error("Previous web asset list is invalid");
  return { pending: distinctAssets(manifest.assets), scan: false };
}

export async function retainPreviousWebAssets(outDir, previousOrigin = "") {
  const target = join(outDir, "assets");
  const current = distinctAssets(
    (await readdir(target, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );
  // Publish only this release's own assets, so older generations do not accumulate.
  await writeFile(
    join(outDir, "web-assets.json"),
    JSON.stringify({ assets: current }),
  );
  if (!previousOrigin) return [];

  const origin = new URL(previousOrigin);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password
  )
    throw Error(
      "Previous web asset origin must be an HTTP(S) origin without credentials",
    );
  const { pending, scan } = await readPreviousRelease(origin.origin);
  const active = new Set(current);
  const visited = new Set();
  const copied = [];
  const failures = [];
  for (let offset = 0; offset < pending.length;) {
    const batch = [];
    while (batch.length < 8 && offset < pending.length) {
      const name = pending[offset++];
      if (visited.has(name)) continue;
      visited.add(name);
      if (visited.size > maxAssets)
        throw Error("Previous release has too many assets");
      // During bootstrap an unchanged JavaScript file can still identify old dependencies.
      if (!active.has(name) || (scan && /\.(?:js|css)$/.test(name)))
        batch.push(name);
    }
    const results = await Promise.allSettled(
      batch.map(async (name) => {
        const bytes = active.has(name)
          ? await readFile(join(target, name))
          : await readBytes(origin, `/assets/${name}`);
        if (scan && /\.(?:js|css)$/.test(name))
          pending.push(...references(bytes.toString()));
        if (!active.has(name)) {
          await writeFile(join(target, name), bytes, { flag: "wx" });
          copied.push(name);
        }
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason.message);
    }
  }
  if (failures.length)
    console.warn(
      `Could not retain ${failures.length} previous asset(s): ${failures.slice(0, 5).join("; ")}`,
    );
  return copied.sort();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , outDir, previousOrigin] = process.argv;
  if (!outDir)
    throw Error(
      "Usage: node scripts/retain-web-assets.mjs WEB_DIR [PREVIOUS_ORIGIN]",
    );
  try {
    const copied = await retainPreviousWebAssets(outDir, previousOrigin);
    console.log(
      `Retained ${copied.length} assets from the previous web release`,
    );
  } catch (error) {
    // The new build is usable if the previous site is temporarily unavailable.
    console.warn(
      `Could not fully retain the previous web release: ${error.message}`,
    );
  }
}
