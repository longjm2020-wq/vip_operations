const requestParameters = "AgentAI 拒绝了本次请求参数，请调整要求后重试";
const authentication = "AgentAI 密钥不可用，请联系管理员核对连接配置";
const permissions = "AgentAI 拒绝了本次调用，请联系管理员核对模型访问权限";
const rateLimit = "AgentAI 请求频率或容量受限，请稍后重试";
const serviceUnavailable = "AgentAI 当前没有可用的服务通道，请稍后重试";
const billingUnavailable = "AgentAI 计费服务暂不可用，请稍后重试";
const timeout = "AgentAI 未在时限内返回结果，请稍后重试";
const payloadTooLarge = "本次请求内容超过 AgentAI 限制，请减少输入或附件后重试";

const namedErrors = new Map([
  ["invalid_request", requestParameters],
  [
    "unsupported_param_combo",
    "当前 AgentAI 模型通道不支持这组请求参数，请联系管理员核对工具与输出格式配置",
  ],
  [
    "reference_image_unreachable",
    "AgentAI 无法读取参考素材，请核对该素材后重试",
  ],
  [
    "reference_media_prep_timeout",
    "AgentAI 处理参考素材超时，请减少素材后重试",
  ],
  ["missing_api_key", authentication],
  ["invalid_api_key", authentication],
  ["api_key_inactive", authentication],
  ["insufficient_funds", "AgentAI 余额不足，请联系管理员核对账户余额"],
  ["api_key_quota_exceeded", "AgentAI 密钥额度已用完，请联系管理员核对用量"],
  ["insufficient_permissions", permissions],
  ["model_not_allowed", permissions],
  ["model_not_available_for_api_key", permissions],
  ["content_policy_violation", "AgentAI 拒绝了本次内容，请调整要求后重试"],
  ["not_found", "AgentAI 未找到本次请求所需资源，请联系管理员核对配置"],
  ["model_not_found", "AgentAI 未找到所选型号，请联系管理员核对模型目录"],
  ["pinned_channel_unavailable", serviceUnavailable],
  ["rate_limit_error", rateLimit],
  ["over_capacity", rateLimit],
  ["ip_rate_limited", rateLimit],
  ["all_vendors_failed", serviceUnavailable],
  ["speed_budget_exhausted", serviceUnavailable],
  ["billing_unavailable", billingUnavailable],
  ["billing_unreachable", billingUnavailable],
  ["billing_timeout", billingUnavailable],
  ["generation_timeout", timeout],
  ["file_too_large", payloadTooLarge],
  ["payload_too_large", payloadTooLarge],
]);

const statusErrors = new Map([
  [400, requestParameters],
  [401, authentication],
  [402, "AgentAI 余额或额度不足，请联系管理员核对账户"],
  [403, permissions],
  [404, "AgentAI 未找到所选型号或资源，请联系管理员核对配置"],
  [408, timeout],
  [413, payloadTooLarge],
  [422, requestParameters],
  [429, rateLimit],
  [500, serviceUnavailable],
  [502, serviceUnavailable],
  [503, serviceUnavailable],
  [504, timeout],
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeStatus(value: unknown): number | undefined {
  const status =
    typeof value === "string" && /^[45]\d{2}$/.test(value)
      ? Number(value)
      : value;
  return typeof status === "number" && statusErrors.has(status)
    ? status
    : undefined;
}

function isFailure(row: Record<string, unknown>): boolean {
  return (
    Boolean(row.error) ||
    row.status === "failed" ||
    row.state === "failed" ||
    (typeof row.code === "number" && row.code !== 0 && row.code !== 200) ||
    (typeof row.code === "string" && namedErrors.has(row.code)) ||
    safeStatus(row.code) !== undefined ||
    safeStatus(row.status) !== undefined ||
    safeStatus(row.status_code) !== undefined
  );
}

/** AgentAI documents error.code and error.type as independent of HTTP status. */
export function agentAiChatError(
  payload: unknown,
): { code: string; message: string } | undefined {
  const root = asRecord(payload);
  const firstChoice = Array.isArray(root.choices)
    ? asRecord(root.choices[0])
    : {};
  const failures = [
    root,
    asRecord(root.response),
    asRecord(root.data),
    firstChoice,
  ].filter(isFailure);
  if (!failures.length) return;

  // Prefer a documented provider code over a generic status wrapper.
  const codes = failures.flatMap((row) => {
    const detail = asRecord(row.error);
    return [detail.code, detail.type, row.code, row.type];
  });
  for (const code of codes) {
    if (typeof code !== "string") continue;
    const message = namedErrors.get(code);
    if (message) return { code: "AGENTAI_" + code.toUpperCase(), message };
  }
  for (const row of failures) {
    const detail = asRecord(row.error);
    const status = [
      detail.code,
      detail.status,
      detail.status_code,
      row.code,
      row.status,
      row.status_code,
    ]
      .map(safeStatus)
      .find((value) => value !== undefined);
    if (status !== undefined)
      return {
        code: "AGENTAI_STATUS_" + status,
        message: statusErrors.get(status)!,
      };
  }
  return {
    code: "AGENTAI_PROVIDER_ERROR",
    message: "AgentAI 本次请求失败，请稍后重试或联系管理员核对调用日志",
  };
}
