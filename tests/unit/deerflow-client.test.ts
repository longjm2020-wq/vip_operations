import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeerFlowClient, deerFlowConfigured, deerFlowEnabled } from "../../apps/api/src/modules/workspace/deerflow-client.js";

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;
let handler: Handler;
let base: string;
const seen: { path: string; method: string; owner: string; token: string; body: string; key?: string }[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  seen.push({ path: request.url || "", method: request.method || "", owner: String(request.headers["x-deerflow-owner-user-id"]), token: String(request.headers["x-deerflow-internal-token"]), body, key: request.headers["idempotency-key"] as string | undefined });
  handler(request, response, body);
});
function send(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}
const run = { thread_id: "team-1", run_id: "run-1", status: "running" };

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  seen.length = 0;
  vi.stubEnv("DEER_FLOW_URL", base);
  vi.stubEnv("DEER_FLOW_INTERNAL_AUTH_TOKEN", "internal-test-secret");
  handler = (_request, response) => send(response, run);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe("DeerFlow v2.2 native Gateway adapter", () => {
  it("uses owner-scoped native endpoints for background runs, files and cancellation", async () => {
    handler = (request, response) => {
      switch (request.url) {
        case "/api/threads": return send(response, { thread_id: "team-1" });
        case "/api/threads/team-1/uploads": return send(response, { success: true, skipped_files: [], files: [{ filename: "资料.txt", size: 4, virtual_path: "/mnt/user-data/uploads/资料.txt" }] });
        case "/api/threads/team-1/runs": return send(response, request.method === "GET" ? [run] : run);
        case "/api/threads/team-1/runs/run-1": return send(response, { ...run, status: "success" });
        case "/api/threads/team-1/state": return send(response, { values: { messages: [{ type: "human", content: "private input" }, { type: "ai", content: "working", tool_calls: [{ name: "task" }] }, { type: "ai", content: [{ type: "reasoning", text: "internal reasoning" }, { type: "text", text: "最终结果" }] }], artifacts: ["/mnt/user-data/outputs/报告.md"] }, next: [] });
        case "/api/threads/team-1/artifacts/mnt/user-data/outputs/%E6%8A%A5%E5%91%8A.md?download=true":
          response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }); return response.end("report");
        case "/api/threads/team-1/runs/run-1/cancel?wait=false&action=interrupt": response.writeHead(202); return response.end();
        default: return send(response, {}, 404);
      }
    };
    const client = createDeerFlowClient("42");
    await client.createThread("team-1");
    const file = await client.upload("team-1", { name: "资料.txt", mime: "text/plain", content: Buffer.from("data") });
    expect(file.virtualPath).toBe("/mnt/user-data/uploads/资料.txt");
    expect(await client.startRun("team-1", "生成报告", [file])).toEqual(run);
    const submitted = seen.find(entry => entry.method === "POST" && entry.path.endsWith("/runs"))!;
    expect(submitted.key).toBe("erp-team-team-1");
    expect(JSON.parse(submitted.body)).toMatchObject({ assistant_id: "lead_agent", context: { subagent_enabled: true }, input: { messages: [{ type: "human", additional_kwargs: { files: [{ path: file.virtualPath, status: "uploaded" }] } }] } });
    expect(seen.find(entry => entry.path.endsWith("/uploads"))?.body).toContain('name="files"');
    expect((await client.listRuns("team-1"))[0]).toEqual(run);
    expect((await client.getRun("team-1", "run-1")).status).toBe("success");
    expect(await client.getState("team-1")).toEqual({ text: "最终结果", artifacts: ["/mnt/user-data/outputs/报告.md"], interrupted: false });
    expect(await client.downloadFile("team-1", "/mnt/user-data/outputs/报告.md")).toEqual({ content: Buffer.from("report"), mime: "text/markdown", name: "报告.md" });
    await client.cancel("team-1", "run-1");
    expect(seen.every(entry => entry.owner === "erp-42" && entry.token === "internal-test-secret")).toBe(true);
  });

  it("isolates owner headers and rejects forged identity and configuration", async () => {
    await Promise.all([createDeerFlowClient("1").getRun("team-1", "run-1"), createDeerFlowClient("2").getRun("team-1", "run-1")]);
    expect(seen.map(entry => entry.owner).sort()).toEqual(["erp-1", "erp-2"]);
    expect(() => createDeerFlowClient("1\r\nX-User: 2")).toThrow("用户标识无效");
    expect(deerFlowEnabled()).toBe(true);
    expect(deerFlowConfigured()).toBe(true);
    vi.stubEnv("DEER_FLOW_INTERNAL_AUTH_TOKEN", "");
    expect(deerFlowConfigured()).toBe(false);
    vi.stubEnv("DEER_FLOW_INTERNAL_AUTH_TOKEN", "token");
    for (const invalid of ["https://user:password@example.com", "https://example.com/api", "https://example.com?secret=x", "file:///secret"]) {
      vi.stubEnv("DEER_FLOW_URL", invalid);
      expect(deerFlowConfigured()).toBe(false);
    }
    vi.stubEnv("DEER_FLOW_URL", "");
    expect(deerFlowEnabled()).toBe(false);
  });

  it("does not follow redirects or retry paid requests and hides upstream errors", async () => {
    handler = (_request, response) => { response.writeHead(307, { location: `${base}/stolen` }); response.end("internal-test-secret"); };
    await expect(createDeerFlowClient("1").startRun("team-1", "goal")).rejects.toMatchObject({ code: "DEER_FLOW_HTTP_ERROR", status: 307 });
    expect(seen).toHaveLength(1);
    handler = (_request, response) => send(response, { error: "api_key=private-key /private/server/path" }, 500);
    await expect(createDeerFlowClient("1").startRun("team-1", "goal")).rejects.toThrow("DeerFlow 服务请求失败（HTTP 500）");
    expect(seen).toHaveLength(2);
  });

  it("rejects foreign responses, malformed data and partial attachment uploads", async () => {
    handler = (_request, response) => send(response, { ...run, thread_id: "other-user-thread" });
    await expect(createDeerFlowClient("1").getRun("team-1", "run-1")).rejects.toThrow("其他会话");
    handler = (_request, response) => response.end("not-json secret");
    await expect(createDeerFlowClient("1").getRun("team-1", "run-1")).rejects.toThrow("返回了无效的数据");
    handler = (_request, response) => send(response, { success: true, files: [], skipped_files: ["x.txt"] });
    await expect(createDeerFlowClient("1").upload("team-1", { name: "x.txt", mime: "text/plain", content: Buffer.from("x") })).rejects.toThrow("未完整接收附件");
  });

  it("recognizes DeerFlow's terminal clarification ToolMessage without leaking hidden or reasoning messages", async () => {
    handler = (_request, response) => send(response, { next: [], values: { messages: [
      { type: "ai", content: "开始处理" },
      { type: "ai", content: "internal reasoning", additional_kwargs: { hide_from_ui: true } },
      { type: "ai", content: [{ type: "reasoning", text: "private thoughts" }], tool_calls: [{ name: "ask_clarification" }] },
      { type: "tool", name: "ask_clarification", content: "请补充目标受众。", artifact: { human_input: { kind: "human_input_request" } } },
      { type: "tool", name: "internal_tool", content: "private tool result" },
    ] } });
    expect(await createDeerFlowClient("1").getState("team-1")).toEqual({ text: "请补充目标受众。", artifacts: [], interrupted: true });
    handler = (_request, response) => send(response, { next: [], values: { messages: [
      { type: "ai", content: "最终结果" },
      { type: "ai", content: "internal summary", additional_kwargs: { hide_from_ui: true } },
      { type: "ai", content: [{ type: "reasoning", text: "private thoughts" }] },
    ] } });
    expect(await createDeerFlowClient("1").getState("team-1")).toEqual({ text: "最终结果", artifacts: [], interrupted: false });
  });

  it("bounds streamed JSON and rejects oversized file bodies before buffering", async () => {
    handler = (_request, response) => { response.writeHead(200); response.write(' {"data":"'); response.end("x".repeat(2 * 1024 * 1024)); };
    await expect(createDeerFlowClient("1").getState("team-1")).rejects.toMatchObject({ code: "DEER_FLOW_RESPONSE_TOO_LARGE" });
    handler = (_request, response) => { response.writeHead(200, { "content-length": 31 * 1024 * 1024 }); response.end("x"); };
    await expect(createDeerFlowClient("1").downloadFile("team-1", "/mnt/user-data/outputs/x.txt")).rejects.toMatchObject({ code: "DEER_FLOW_RESPONSE_TOO_LARGE" });
  });

  it("rejects unsafe artifact paths before making requests and honors aborts", async () => {
    const client = createDeerFlowClient("1");
    for (const path of ["https://evil.test/file", "/mnt/user-data/outputs/../secret", "/mnt/user-data/outputs/%2e%2e/secret", "/mnt/user-data/uploads/file", "/mnt/user-data/outputs/a\\..\\b", "/mnt/user-data/outputs/x?token=yes"]) {
      await expect(client.downloadFile("team-1", path)).rejects.toThrow("文件路径无效");
    }
    expect(seen).toHaveLength(0);
    const controller = new AbortController();
    controller.abort("secret reason");
    await expect(createDeerFlowClient("1", controller.signal).startRun("team-1", "goal")).rejects.toMatchObject({ code: "DEER_FLOW_ABORTED", message: "DeerFlow 请求已停止" });
    expect(seen).toHaveLength(0);
  });
});
