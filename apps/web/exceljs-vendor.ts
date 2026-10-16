import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);
const { version } = JSON.parse(readFileSync(require.resolve("exceljs/package.json"), "utf8")) as { version: string };
const vendorPath = `/vendor/exceljs/${version}/exceljs-browser.js`;
const compatibilityPath = "/vendor/exceljs-compat.js";
const source = readFileSync(require.resolve("exceljs/dist/exceljs.min.js"), "utf8")
  .replace(/^\/\/# sourceMappingURL=.*$/gm, "");
const browserModule = `${source}\nconst exceljs = globalThis.ExcelJS;\nexport const Workbook = exceljs.Workbook;\nexport const e = Object.freeze({ ...exceljs, default: exceljs });\nexport default exceljs;\n`;
// Old Vite chunks used both (await import()).default and .e.default. Keep both
// namespaces available without importing any application-specific hashed chunk.
// Keep this self-contained too: importing the version URL again would reuse a
// failed native module-map entry instead of issuing a fresh recovery request.
const compatibilityModule = browserModule;
const legacyAsset = /^\/assets\/exceljs\.min-[A-Za-z0-9_-]+\.js$/;

export function excelJsVendorPlugin(): Plugin {
  return {
    name: "exceljs-stable-browser-vendor",
    config: () => ({ define: { __EXCELJS_VENDOR_PATH__: JSON.stringify(vendorPath) } }),
    generateBundle() {
      this.emitFile({ type: "asset", fileName: vendorPath.slice(1), source: browserModule });
      this.emitFile({ type: "asset", fileName: compatibilityPath.slice(1), source: compatibilityModule });
      this.emitFile({ type: "asset", fileName: `vendor/exceljs/${version}/LICENSE.txt`,
        source: readFileSync(require.resolve("exceljs/LICENSE"), "utf8") });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || "/", "http://localhost").pathname;
        const stable = pathname === vendorPath;
        if (!stable && pathname !== compatibilityPath && !legacyAsset.test(pathname)) return next();
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.setHeader("Cache-Control", stable ? "public, max-age=31536000, immutable" : "no-store");
        response.end(stable ? browserModule : compatibilityModule);
      });
    },
  };
}
