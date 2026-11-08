import { z } from "zod";

// Wire contract: bytedance/deer-flow v2.2.0 (58fc5bd), native Gateway /api routes.
// The privileged internal credential must only be used between trusted services.
const JSON_LIMIT = 2 * 1024 * 1024;
const FILE_LIMIT = 30 * 1024 * 1024;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const runSchema = z.object({
  run_id: z.string().regex(identifier),
  thread_id: z.string().regex(identifier),
  status: z.enum([
    "pending",
    "running",
    "success",
    "error",
    "timeout",
    "interrupted",
  ]),
  stop_reason: z.string().nullable().optional(),
});
export type DeerFlowRun = z.infer<typeof runSchema>;
export type DeerFlowUpload = {
  filename: string;
  size: number;
  virtualPath: string;
};
export type DeerFlowState = {
  text: string;
  artifacts: string[];
  interrupted: boolean;
};

export class DeerFlowError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DeerFlowError";
  }
}

export function deerFlowEnabled() {
  return !!process.env.DEER_FLOW_URL?.trim();
}

function configuration() {
  try {
    const url = new URL(process.env.DEER_FLOW_URL?.trim() || "");
    const token = process.env.DEER_FLOW_INTERNAL_AUTH_TOKEN?.trim();
    if (
      !token ||
      /[\r\n]/.test(token) ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw Error();
    return { base: url.origin, token };
  } catch {
    throw new DeerFlowError(
      "DEER_FLOW_NOT_CONFIGURED",
      "DeerFlow 服务尚未配置完成，请管理员检查服务地址和内部凭证",
    );
  }
}

export function deerFlowConfigured() {
  try {
    configuration();
    return true;
  } catch {
    return false;
  }
}

function segment(value: string) {
  if (!identifier.test(value))
    throw new DeerFlowError("DEER_FLOW_INVALID_ID", "DeerFlow 任务标识无效");
  return value;
}

function artifactPath(value: string, directory: "outputs" | "uploads") {
  const prefix = `/mnt/user-data/${directory}/`;
  if (
    value.length > 2000 ||
    !value.startsWith(prefix) ||
    /[\\\u0000-\u001f\u007f%?#]/.test(value) ||
    value
      .slice(prefix.length)
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  ) {
    throw new DeerFlowError(
      "DEER_FLOW_INVALID_FILE",
      "DeerFlow 返回的文件路径无效",
    );
  }
  return value;
}

async function boundedBody(response: Response, limit: number) {
  const length = Number(response.headers.get("content-length"));
  if (length > limit) {
    await response.body?.cancel();
    throw new DeerFlowError(
      "DEER_FLOW_RESPONSE_TOO_LARGE",
      "DeerFlow 返回内容超过接入大小限制",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new DeerFlowError(
          "DEER_FLOW_RESPONSE_TOO_LARGE",
          "DeerFlow 返回内容超过接入大小限制",
        );
      }
      chunks.push(result.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

/** One client belongs to one authenticated ERP user. Never take the owner from HTTP input. */
export function createDeerFlowClient(userId: string, signal?: AbortSignal) {
  if (!/^[1-9][0-9]{0,19}$/.test(userId))
    throw new DeerFlowError("DEER_FLOW_INVALID_OWNER", "DeerFlow 用户标识无效");
  const { base, token } = configuration();

  async function request(
    path: string,
    init: RequestInit = {},
    limit = JSON_LIMIT,
  ) {
    const timeout = AbortSignal.timeout(60_000);
    try {
      const headers = new Headers(init.headers);
      headers.set("X-DeerFlow-Internal-Token", token);
      headers.set("X-DeerFlow-Owner-User-Id", `erp-${userId}`);
      const response = await fetch(base + path, {
        ...init,
        headers,
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Upstream error bodies can contain credentials, local paths or model prompts.
        throw new DeerFlowError(
          "DEER_FLOW_HTTP_ERROR",
          `DeerFlow 服务请求失败（HTTP ${response.status}）`,
          response.status,
        );
      }
      return {
        body: await boundedBody(response, limit),
        mime:
          response.headers.get("content-type") || "application/octet-stream",
      };
    } catch (error) {
      if (error instanceof DeerFlowError) throw error;
      if (signal?.aborted)
        throw new DeerFlowError("DEER_FLOW_ABORTED", "DeerFlow 请求已停止");
      if (timeout.aborted)
        throw new DeerFlowError(
          "DEER_FLOW_TIMEOUT",
          "DeerFlow 服务响应超时，请核对任务状态后继续",
        );
      throw new DeerFlowError(
        "DEER_FLOW_UNAVAILABLE",
        "DeerFlow 服务暂时无法连接，请管理员检查服务状态",
      );
    }
  }

  async function json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await request(path, init);
    try {
      return JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new DeerFlowError(
        "DEER_FLOW_INVALID_RESPONSE",
        "DeerFlow 返回了无效的数据",
      );
    }
  }

  function parse<T>(schema: z.ZodType<T>, data: unknown): T {
    const result = schema.safeParse(data);
    if (!result.success)
      throw new DeerFlowError(
        "DEER_FLOW_INVALID_RESPONSE",
        "DeerFlow 返回了不兼容的数据",
      );
    return result.data;
  }

  function jsonPost(
    body: unknown,
    headers?: Record<string, string>,
  ): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    };
  }

  return {
    async createThread(threadId: string): Promise<void> {
      segment(threadId);
      const data = parse(
        z.object({ thread_id: z.literal(threadId) }),
        await json(
          "/api/threads",
          jsonPost({ thread_id: threadId, assistant_id: "lead_agent" }),
        ),
      );
      if (data.thread_id !== threadId)
        throw new DeerFlowError(
          "DEER_FLOW_INVALID_RESPONSE",
          "DeerFlow 会话标识不一致",
        );
    },

    async upload(
      threadId: string,
      file: { name: string; mime: string; content: Buffer },
    ): Promise<DeerFlowUpload> {
      if (
        !file.name ||
        file.name.length > 200 ||
        /[/\\\u0000-\u001f\u007f]/.test(file.name) ||
        file.content.byteLength > FILE_LIMIT
      ) {
        throw new DeerFlowError(
          "DEER_FLOW_INVALID_UPLOAD",
          "附件名称无效或超过 30 MB 接入限制",
        );
      }
      const body = new FormData();
      body.append(
        "files",
        new Blob([new Uint8Array(file.content)], { type: file.mime }),
        file.name,
      );
      const data = parse(
        z.object({
          success: z.boolean(),
          files: z.array(
            z.object({
              filename: z.string().min(1).max(255),
              size: z.number().int().nonnegative(),
              virtual_path: z.string(),
            }),
          ),
          skipped_files: z.array(z.string()).optional(),
        }),
        await json(`/api/threads/${segment(threadId)}/uploads`, {
          method: "POST",
          body,
        }),
      );
      if (
        !data.success ||
        data.files.length !== 1 ||
        data.skipped_files?.length
      )
        throw new DeerFlowError(
          "DEER_FLOW_UPLOAD_REJECTED",
          "DeerFlow 未完整接收附件，任务尚未开始",
        );
      const uploaded = data.files[0];
      return {
        filename: uploaded.filename,
        size: uploaded.size,
        virtualPath: artifactPath(uploaded.virtual_path, "uploads"),
      };
    },

    async startRun(
      threadId: string,
      goal: string,
      files: DeerFlowUpload[] = [],
      options: { model?: string; idempotencyKey?: string } = {},
    ): Promise<DeerFlowRun> {
      segment(threadId);
      if (!goal.trim() || goal.length > 120000 || files.length > 10)
        throw new DeerFlowError(
          "DEER_FLOW_INVALID_INPUT",
          "DeerFlow 任务内容或附件数量超出限制",
        );
      const key = options.idempotencyKey || `erp-team-${threadId}`;
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(key))
        throw new DeerFlowError(
          "DEER_FLOW_INVALID_ID",
          "DeerFlow 请求标识无效",
        );
      const data = parse(
        runSchema,
        await json(
          `/api/threads/${threadId}/runs`,
          jsonPost(
            {
              assistant_id: "lead_agent",
              input: {
                messages: [
                  {
                    type: "human",
                    content: [{ type: "text", text: goal }],
                    additional_kwargs: {
                      files: files.map((file) => ({
                        filename: file.filename,
                        size: file.size,
                        path: artifactPath(file.virtualPath, "uploads"),
                        status: "uploaded",
                      })),
                    },
                  },
                ],
              },
              context: {
                subagent_enabled: true,
                is_plan_mode: true,
                locale: "zh-CN",
                ...(options.model ? { model_name: options.model } : {}),
              },
              on_disconnect: "continue",
              multitask_strategy: "reject",
            },
            { "Idempotency-Key": key },
          ),
        ),
      );
      if (data.thread_id !== threadId)
        throw new DeerFlowError(
          "DEER_FLOW_INVALID_RESPONSE",
          "DeerFlow 返回了其他会话的任务",
        );
      return data;
    },

    async getRun(threadId: string, runId: string): Promise<DeerFlowRun> {
      const data = parse(
        runSchema,
        await json(`/api/threads/${segment(threadId)}/runs/${segment(runId)}`),
      );
      if (data.thread_id !== threadId || data.run_id !== runId)
        throw new DeerFlowError(
          "DEER_FLOW_INVALID_RESPONSE",
          "DeerFlow 返回了其他会话的任务",
        );
      return data;
    },

    async listRuns(threadId: string): Promise<DeerFlowRun[]> {
      const data = parse(
        z.array(runSchema).max(1000),
        await json(`/api/threads/${segment(threadId)}/runs`),
      );
      if (data.some((run) => run.thread_id !== threadId))
        throw new DeerFlowError(
          "DEER_FLOW_INVALID_RESPONSE",
          "DeerFlow 返回了其他会话的任务",
        );
      return data;
    },

    async getState(threadId: string): Promise<DeerFlowState> {
      const data = parse(
        z.object({
          values: z
            .object({
              messages: z.array(z.unknown()).optional(),
              artifacts: z.array(z.string()).optional(),
            })
            .passthrough(),
          next: z.array(z.string()).optional(),
        }),
        await json(`/api/threads/${segment(threadId)}/state`),
      );
      let text = "";
      let clarification = false;
      for (const candidate of data.values.messages || []) {
        if (!candidate || typeof candidate !== "object") continue;
        const message = candidate as Record<string, unknown>;
        const metadata = message.additional_kwargs;
        if (
          metadata &&
          typeof metadata === "object" &&
          (metadata as Record<string, unknown>).hide_from_ui === true
        )
          continue;
        // ClarificationMiddleware ends the run with a public ToolMessage, not a
        // LangGraph interrupt; a "success" run can still need a human answer.
        const asksHuman =
          message.type === "tool" && message.name === "ask_clarification";
        if (
          !asksHuman &&
          ((message.type !== "ai" && message.role !== "assistant") ||
            (Array.isArray(message.tool_calls) && message.tool_calls.length))
        )
          continue;
        const content =
          typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                  .flatMap((part: unknown) =>
                    part &&
                    typeof part === "object" &&
                    (part as Record<string, unknown>).type === "text" &&
                    typeof (part as Record<string, unknown>).text === "string"
                      ? [(part as { text: string }).text]
                      : [],
                  )
                  .join("\n")
              : "";
        if (content.trim()) {
          text = content.slice(0, 120000);
          clarification = asksHuman;
        }
      }
      const artifacts = [...new Set(data.values.artifacts || [])];
      if (artifacts.length > 30)
        throw new DeerFlowError(
          "DEER_FLOW_TOO_MANY_FILES",
          "DeerFlow 交付文件超过 30 份，请缩小任务范围后重试",
        );
      return {
        text,
        artifacts: artifacts.map((path) => artifactPath(path, "outputs")),
        interrupted: clarification || !!data.next?.length,
      };
    },

    async cancel(threadId: string, runId: string): Promise<void> {
      await request(
        `/api/threads/${segment(threadId)}/runs/${segment(runId)}/cancel?wait=false&action=interrupt`,
        { method: "POST" },
      );
    },

    async downloadFile(
      threadId: string,
      path: string,
    ): Promise<{ content: Buffer; mime: string; name: string }> {
      const safe = artifactPath(path, "outputs");
      const response = await request(
        `/api/threads/${segment(threadId)}/artifacts/${safe.slice(1).split("/").map(encodeURIComponent).join("/")}?download=true`,
        {},
        FILE_LIMIT,
      );
      return {
        content: response.body,
        mime: response.mime.split(";")[0].trim(),
        name: safe.split("/").at(-1)!,
      };
    },
  };
}
