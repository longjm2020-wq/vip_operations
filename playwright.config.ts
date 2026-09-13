import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
process.env.E2E_PASSWORD ??= randomUUID();
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  timeout: 60000,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:5174",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "tsx scripts/e2e-server.ts",
    url: "http://127.0.0.1:5174",
    timeout: 60000,
    reuseExistingServer: false,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
