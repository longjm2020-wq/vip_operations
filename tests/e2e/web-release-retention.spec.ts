import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, resolve, sep } from "node:path";

const dist = resolve(process.env.WEB_RELEASE_E2E_DIST || "dist/web");
const contentTypes: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

test("旧版本打开的运营中心发布后仍能直接切换到库存明细", async ({ page }) => {
  test.skip(
    !existsSync(resolve(dist, "index.html")),
    "需要先构建生产网页到 dist/web",
  );
  const scriptPath = new URL(
    "../../scripts/retain-web-assets.mjs",
    import.meta.url,
  );
  const { retainPreviousWebAssets } = (await import(scriptPath.href)) as {
    retainPreviousWebAssets: (
      outDir: string,
      previousOrigin: string,
    ) => Promise<string[]>;
  };
  const previousHtml = await readFile(resolve(dist, "index.html"), "utf8");
  const previousEntry = previousHtml.match(
    /src="\/assets\/(index-[\w-]+\.js)"/,
  )?.[1];
  expect(previousEntry).toBeTruthy();
  const entry = await readFile(resolve(dist, "assets", previousEntry!), "utf8");
  const inventoryScript = entry.match(
    /\.\/((?:operations-(?!workspace-))[\w-]+\.js)/,
  )?.[1];
  const inventoryCss = entry.match(
    /assets\/((?:operations-(?!workspace-))[\w-]+\.css)/,
  )?.[1];
  expect(inventoryScript).toBeTruthy();
  expect(inventoryCss).toBeTruthy();
  const replacedAssets = [previousEntry!, inventoryScript!, inventoryCss!];
  const nextAssets = [
    "index-nxt01001.js",
    "operations-nxt01001.js",
    "operations-nxt01001.css",
  ];

  const next = await mkdtemp(resolve(tmpdir(), "vip-web-release-"));
  let serving = dist;
  const served: { pathname: string; directory: string; status: number }[] = [];
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    const directory = serving;
    const fileName = extname(pathname) ? pathname.slice(1) : "index.html";
    // All stable public files can be shared; a deployment replaces the versioned
    // assets and the HTML alone. No fallback is allowed for missing hashed assets.
    const root =
      fileName.startsWith("assets/") ||
      fileName === "index.html" ||
      fileName === "web-assets.json"
        ? directory
        : dist;
    const file = resolve(root, fileName);
    const bytes = file.startsWith(root + sep)
      ? await readFile(file).catch(() => null)
      : null;
    const status = bytes === null ? 404 : 200;
    served.push({ pathname, directory, status });
    response.writeHead(status, {
      "Content-Type": contentTypes[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(bytes);
  });

  try {
    await mkdir(resolve(next, "assets"));
    const assets = await readdir(resolve(dist, "assets"), {
      withFileTypes: true,
    });
    await Promise.all(
      assets
        .filter((file) => file.isFile() && !replacedAssets.includes(file.name))
        .map(({ name }) =>
          copyFile(
            resolve(dist, "assets", name),
            resolve(next, "assets", name),
          ),
        ),
    );
    await Promise.all([
      writeFile(
        resolve(next, "index.html"),
        previousHtml.replace(previousEntry!, nextAssets[0]),
      ),
      writeFile(
        resolve(next, "assets", nextAssets[0]),
        entry
          .replaceAll(inventoryScript!, nextAssets[1])
          .replaceAll(inventoryCss!, nextAssets[2]),
      ),
      copyFile(
        resolve(dist, "assets", inventoryScript!),
        resolve(next, "assets", nextAssets[1]),
      ),
      copyFile(
        resolve(dist, "assets", inventoryCss!),
        resolve(next, "assets", nextAssets[2]),
      ),
    ]);
    await new Promise<void>((listen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", listen);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("测试服务器未启动");
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route("**/api/v1/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/v1/auth/me")
        return route.fulfill({
          json: {
            data: {
              id: "release-user",
              displayName: "发布测试",
              roleCodes: [],
              permissions: ["inventory.read"],
              csrfToken: "test-only",
            },
          },
        });
      if (path === "/api/v1/my-workspace/appearance")
        return route.fulfill({ json: { data: { mode: "light", version: 1 } } });
      return route.fulfill({ json: { data: [], total: 0 } });
    });

    const documents: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "document") documents.push(request.url());
    });
    await page.goto(`${origin}/operations`);
    const inventory = page
      .locator(".operations-entry-grid")
      .getByRole("link", { name: "库存明细", exact: true });
    await expect(inventory).toBeVisible();
    expect(
      served.some(({ pathname }) => pathname === `/assets/${inventoryScript}`),
    ).toBe(false);

    expect(existsSync(resolve(next, "assets", inventoryScript!))).toBe(false);
    expect(existsSync(resolve(next, "assets", inventoryCss!))).toBe(false);
    const retained = await retainPreviousWebAssets(next, origin);
    expect(retained).toEqual(
      expect.arrayContaining([inventoryScript, inventoryCss]),
    );
    const manifest = JSON.parse(
      await readFile(resolve(next, "web-assets.json"), "utf8"),
    );
    expect(manifest.assets).toEqual(expect.arrayContaining(nextAssets));
    for (const name of replacedAssets)
      expect(manifest.assets).not.toContain(name);
    serving = next;
    expect(await (await fetch(`${origin}/operations`)).text()).toContain(
      nextAssets[0],
    );
    await inventory.click();
    await expect(page).toHaveURL(`${origin}/operations/vip/inventory`);
    await expect(
      page.getByRole("region", { name: "库存明细", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('.page-resource-state[data-state="error"]'),
    ).toHaveCount(0);
    expect(documents).toEqual([`${origin}/operations`]);
    expect(served).toContainEqual({
      pathname: `/assets/${inventoryScript}`,
      directory: next,
      status: 200,
    });
    expect(served).toContainEqual({
      pathname: `/assets/${inventoryCss}`,
      directory: next,
      status: 200,
    });
  } finally {
    await new Promise<void>((close) => server.close(() => close()));
    await rm(next, { recursive: true, force: true });
  }
});
