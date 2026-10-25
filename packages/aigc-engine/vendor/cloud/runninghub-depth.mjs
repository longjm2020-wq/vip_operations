import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { openAsBlob } from "node:fs";

// Preflight is read-only. Paid calls are made only by the independent DepthJobs
// queue after explicit confirmation and a durable submission-intent record.
export const RUNNINGHUB_DEPTH_WORKFLOW_ID = "2104409348809256962";
const ORIGIN = "https://www.runninghub.cn";
const template = JSON.parse(await readFile(new URL("../workflows/video-depth-anything-small/xuti-vda-small-runninghub.api.json", import.meta.url), "utf8"));
const id = value => typeof value === "string" && /^\d{1,30}$/.test(value);
const fail = message => { throw new Error(message); };

export function validateRunningHubDepthGraph(graph) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)
    || !isDeepStrictEqual(Object.keys(graph).sort(), Object.keys(template).sort())) {
    fail("深度工作流节点数量或 ID 已变化，须重新核对映射");
  }
  for (const [nodeId, expected] of Object.entries(template)) {
    const node = graph[nodeId];
    if (node?.class_type !== expected.class_type || !node.inputs || typeof node.inputs !== "object") fail(`深度节点 ${nodeId} 类型不匹配`);
    for (const [field, expectedValue] of Object.entries(expected.inputs)) {
      let actual = node.inputs[field];
      if (nodeId === "1" && field === "video") {
        if (typeof actual !== "string" || !actual) fail("深度工作流缺少视频输入");
        continue; // Replaced with the provider's upload filename before submission.
      }
      if (Array.isArray(expectedValue) && Array.isArray(actual)) actual = [String(actual[0]), ...actual.slice(1)];
      if (!isDeepStrictEqual(actual, expectedValue)) fail(`深度节点 ${nodeId}.${field} 与已核对模板不同`);
    }
    for (const [field, value] of Object.entries(node.inputs)) if (!(field in expected.inputs)) {
      // Defaults added by RunningHub's older VHS editor, observed on 2026-09-28.
      if (nodeId === "1" && field === "force_size" && value === "Disabled") continue;
      if (nodeId === "6" && field === "no_preview" && value === false) continue;
      fail(`深度节点 ${nodeId} 含未核对输入 ${field}`);
    }
  }
  return { engine: "video-depth-anything-small", inputNodeId: "1", inputField: "video", outputNodeId: "6", nodeCount: 5 };
}

// Pure request construction; deliberately does not submit or include a key.
// Caller must provide a freshly retrieved/validated graph and persist submission
// intent before performing a paid POST. Never retry an ambiguous create response.
export function buildRunningHubDepthRequest({ workflowId, fileName, graph }) {
  if (!id(workflowId)) fail("RunningHub 工作流 ID 无效");
  if (typeof fileName !== "string" || fileName.length > 512
    || !/^[A-Za-z0-9_/-]+\.mp4$/.test(fileName) || fileName.startsWith("/")) {
    fail("请使用 RunningHub 上传接口返回的 MP4 文件名");
  }
  validateRunningHubDepthGraph(graph);
  // Pin the validated graph itself as well as the node override: changing the
  // saved workflow between preflight and execution must not change the model.
  const pinned = structuredClone(graph);
  pinned[1].inputs.video = fileName;
  return {
    workflowId, workflow: JSON.stringify(pinned),
    nodeInfoList: [{ nodeId: "1", fieldName: "video", fieldValue: fileName }],
    instanceType: "default", addMetadata: false,
  };
}

export async function preflightRunningHubDepth({ apiKey, workflowId = RUNNINGHUB_DEPTH_WORKFLOW_ID, signal, fetchImpl = fetch }) {
  if (typeof apiKey !== "string" || !apiKey.trim()) fail("请在服务器配置 RUNNINGHUB_API_KEY，不要发到聊天或前端");
  if (!id(workflowId)) fail("RunningHub 工作流 ID 无效");
  let response, payload;
  try {
    response = await fetchImpl(`${ORIGIN}/api/openapi/getJsonApiFormat`, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ apiKey, workflowId }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    if (!response.ok) fail("http");
    // Bound response memory and avoid logging upstream bodies (may echo secrets).
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024 * 1024) { await reader.cancel(); fail("size"); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("RunningHub 工作流只读核对失败（网络、权限或响应异常）；未创建付费任务");
  }
  if (payload?.code !== 0) fail("RunningHub 未允许读取此工作流，请核对 API 权限和工作流 ID；未创建付费任务");
  let graph;
  try { graph = JSON.parse(payload.data.prompt); } catch { fail("RunningHub 工作流 JSON 无效；未创建付费任务"); }
  const mapping = validateRunningHubDepthGraph(graph);
  return { workflowId, ...mapping, graph, runtimeVerified: false };
}

async function boundedJson(response) {
  if (!response.ok) throw new Error("network");
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error("size"); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class RunningHubDepthClient {
  constructor({ apiKey, workflowId = RUNNINGHUB_DEPTH_WORKFLOW_ID, fetchImpl = fetch }) {
    this.apiKey = apiKey; this.workflowId = workflowId; this.fetch = fetchImpl;
  }
  preflight(signal) { return preflightRunningHubDepth({ apiKey: this.apiKey, workflowId: this.workflowId, fetchImpl: this.fetch, signal }); }
  async call(endpoint, body, signal, multipart = false) {
    if (!this.apiKey) throw new Error("深度服务尚未配置");
    try {
      return await boundedJson(await this.fetch(`${ORIGIN}${endpoint}`, {
        method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${this.apiKey}`, ...(multipart ? {} : { "Content-Type": "application/json" }) },
        body: multipart ? body : JSON.stringify({ ...body, apiKey: this.apiKey }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      }));
    } catch { throw new Error("RunningHub 请求结果未知；请核实原请求，不会自动重提"); }
  }
  async upload(filePath, signal) {
    const form = new FormData(); form.set("file", await openAsBlob(filePath, { type: "video/mp4" }), "depth-input.mp4");
    const result = await this.call("/openapi/v2/media/upload/binary", form, signal, true);
    if (result.code !== 0 || !result.data?.fileName) throw new Error("深度视频上传未成功，尚未提交推理");
    return result.data.fileName;
  }
  async submit(fileName, graph, signal) {
    const result = await this.call("/task/openapi/create", buildRunningHubDepthRequest({ workflowId: this.workflowId, fileName, graph }), signal);
    if (result.code !== 0) {
      const known = { 301: "参数无效", 380: "工作流不存在", 416: "RH 币余额不足", 421: "并发已满", 433: "工作流校验失败", 801: "账号不支持 API", 802: "密钥无效", 803: "节点映射无效", 810: "工作流须先在 RunningHub 保存并手动运行一次" };
      const issue = new Error(`RunningHub ${known[result.code] || "提交结果未知，请核实账务"}`);
      issue.definitelyRejected = Boolean(known[result.code]); throw issue;
    }
    if (!id(result.data?.taskId)) throw new Error("RunningHub 未返回任务编号，不能重复提交");
    return result.data.taskId;
  }
  async poll(taskId, signal) {
    if (!id(taskId)) throw new Error("深度任务编号无效");
    const result = await this.call("/task/openapi/outputs", { taskId }, signal);
    if ([804, 813].includes(result.code)) return { state: "pending" };
    if (result.code === 805) return { state: "failed" };
    if (result.code !== 0 || !Array.isArray(result.data)) throw new Error("深度任务结果暂不可确认");
    const files = result.data.filter(f => String(f.nodeId) === "6" && String(f.fileType).toLowerCase() === "mp4");
    if (files.length !== 1) throw new Error("深度输出节点未返回唯一 MP4");
    const reported = files[0].consumeCoins;
    const coins = reported !== null && reported !== undefined && reported !== "" && Number.isFinite(Number(reported)) && Number(reported)>=0 ? Number(reported) : undefined;
    return { state: "completed", url: files[0].fileUrl, coins };
  }
  async cancel(taskId) {
    if (!id(taskId)) return false;
    return (await this.call("/task/openapi/cancel", { taskId })).code === 0;
  }
}
