import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Body, Controller, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { request as httpRequest } from "node:http";
import { selectionImportBodyParser } from "../../apps/api/src/selection-import-body.js";
import { fail, type Actor } from "../../apps/api/src/core.js";
import { selectionImportLimits } from "../../packages/contracts/src/selection-import-template.js";
import type { Row } from "../../packages/database/src/index.js";

const events: string[] = [];
let actor: Actor;
@Controller("api/v1")
class BodyTestController {
  @Post("style-selections/import/preview") preview(@Body() body: Row) { events.push("handler"); return { bytes: Buffer.byteLength(JSON.stringify(body)) }; }
  @Post("style-selections/import") commit(@Body() body: Row) { events.push("handler"); return { bytes: Buffer.byteLength(JSON.stringify(body)) }; }
  @Post("ordinary") ordinary(@Body() body: Row) { events.push("ordinary-handler"); return { bytes: Buffer.byteLength(JSON.stringify(body)) }; }
}
@Module({ controllers: [BodyTestController] })
class BodyTestModule {}
async function server(limitBytes?: number) {
  const app = await NestFactory.create<NestExpressApplication>(BodyTestModule, { logger: false });
  app.use(cookieParser());
  app.use(selectionImportBodyParser({ limitBytes, origin: () => "https://import.example", authenticate: async token => {
    events.push("authenticate");
    if (token !== "fixture-session") fail("UNAUTHORIZED", "请先登录", 401);
    return actor;
  }, authorizeTable: async (_actor, tableId) => {
    events.push(`table:${tableId}`);
    if (tableId === "10") fail("NOT_FOUND", "表格不存在或无权访问", 404);
    return { can_edit: tableId !== "9", system_key: tableId === "8" ? "PRODUCT_ARCHIVE" : null };
  } }));
  // Exactly the startup order in main.ts, including Nest's automatic parser setup.
  app.useBodyParser("json", { limit: "8mb" });
  await app.listen(0, "127.0.0.1");
  return { app, url: await app.getUrl() };
}
let running: Awaited<ReturnType<typeof server>>;
const headers = { "Content-Type": "application/json", Cookie: "session=fixture-session", Origin: "https://import.example", "X-CSRF-Token": "fixture-csrf" };
const post = (path: string, body = "{}", overrides: Record<string, string> = {}) => fetch(running.url + path, { method: "POST", headers: { ...headers, ...overrides }, body });
beforeAll(async () => { running = await server(); });
beforeEach(() => {
  events.length = 0;
  actor = { id: "7", displayName: "Fixture", username: "fixture", csrfToken: "fixture-csrf", permissions: ["selection.manage", "project.read", "product.update"] };
});
afterAll(async () => { await running.app.close(); });

describe("authenticated large selection import requests", () => {
  it("accepts JSON larger than 8 MB for both internal actions and archive/project scopes before Nest's default parser", async () => {
    const body = JSON.stringify({ blob: "x".repeat(9 * 1024 * 1024) });
    for (const path of ["/api/v1/style-selections/import/preview", "/api/v1/style-selections/import", "/api/v1/style-selections/import/preview?tableId=7", "/api/v1/style-selections/import?tableId=8"]) {
      events.length = 0;
      const response = await post(path, body);
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ bytes: Buffer.byteLength(body) });
      expect(events[0]).toBe("authenticate"); expect(events.at(-1)).toBe("handler");
      if (path.includes("tableId")) expect(events[1]).toMatch(/^table:/);
    }
  });
  it("retains the ordinary 8 MB limit and never grants large parsing to public, lookalike or unrelated routes", async () => {
    const body = JSON.stringify({ blob: "x".repeat(9 * 1024 * 1024) });
    for (const path of ["/api/v1/ordinary", "/api/v1/public/selection-collection", "/api/v1/style-selections/import-more", "/api/v1/style-selections/import/preview/extra"]) {
      expect((await post(path, body)).status).toBe(413);
      expect(events).toEqual([]);
    }
  });
  it("checks session, CSRF, Origin and edit permissions before trying to parse malformed JSON", async () => {
    for (const [overrides, status] of [[{ Cookie: "session=invalid" }, 401], [{ "X-CSRF-Token": "invalid" }, 403], [{ Origin: "https://invalid.example" }, 403]] as const) {
      events.length = 0;
      expect((await post("/api/v1/style-selections/import/preview", "{bad", overrides)).status).toBe(status);
      expect(events).toEqual(["authenticate"]);
    }
    actor.permissions = [];
    expect((await post("/api/v1/style-selections/import/preview", "{bad")).status).toBe(403);
    actor.permissions = ["project.read", "product.update"];
    for (const tableId of ["9", "10"]) expect((await post(`/api/v1/style-selections/import?tableId=${tableId}`, "{bad")).status).toBe(tableId === "9" ? 403 : 404);
    expect((await post("/api/v1/style-selections/import?tableId=7&tableId=8", "{bad")).status).toBe(400);
    expect(events).not.toContain("handler");
  });
  it("rejects an announced request beyond 200 MB immediately with a clear 413 split-file message", async () => {
    const response = await new Promise<{ status: number; body: Row }>((resolve, reject) => {
      const request = httpRequest(running.url + "/api/v1/style-selections/import", { method: "POST", headers: { ...headers, "Content-Length": String(selectionImportLimits.requestBodyBytes + 1) } }, result => {
        let body = ""; result.setEncoding("utf8"); result.on("data", part => body += part); result.on("end", () => resolve({ status: result.statusCode!, body: JSON.parse(body) }));
      });
      request.on("error", reject); request.end("{}");
    });
    expect(response.status).toBe(413);
    expect(response.body.error).toMatchObject({ code: "PAYLOAD_TOO_LARGE", message: expect.stringContaining("拆分") });
    expect(events).toEqual(["authenticate"]);
  });
  it("accepts the exact byte boundary and rejects one additional byte through the real parser", async () => {
    const small = await server(1024);
    try {
      for (const [bytes, status] of [[1024, 201], [1025, 413]]) {
        const body = `{"blob":"${"x".repeat(bytes - 11)}"}`;
        expect(Buffer.byteLength(body)).toBe(bytes);
        const response = await fetch(small.url + "/api/v1/style-selections/import/preview", { method: "POST", headers, body });
        expect(response.status).toBe(status);
      }
      const streamed = await new Promise<{ status: number; body: Row }>((resolve, reject) => {
        const request = httpRequest(small.url + "/api/v1/style-selections/import/preview", { method: "POST", headers: { ...headers, "Transfer-Encoding": "chunked" } }, result => {
          let body = ""; result.setEncoding("utf8"); result.on("data", part => body += part); result.on("end", () => resolve({ status: result.statusCode!, body: JSON.parse(body) }));
        });
        request.on("error", reject); request.write(`{"blob":"${"x".repeat(1014)}`); request.end('"}');
      });
      expect(streamed.status).toBe(413);
      expect(streamed.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    } finally { await small.app.close(); }
  });
});
