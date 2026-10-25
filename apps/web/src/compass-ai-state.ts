import type { CompassVisuals } from "./compass-ai-view";

export const compassAIStates: Record<string, string> = {
  READY: "已生成",
  PENDING: "生成中",
  FAILED: "生成失败",
  DISABLED: "未开启",
  WAITING_KEY: "待配置密钥",
  WAITING_VERIFICATION: "待验证",
  WAITING_DATA: "等待完整报表",
  NOT_GENERATED: "待生成",
};
export type CompassAIState = {
  id?: string;
  state: string;
  message?: string;
  model?: string;
  responseModel?: string;
  reportDate?: string;
  generatedAt?: string;
  content?: {
    summary: string;
    actions: string[];
    observations: string[];
    risks: string[];
  };
  visuals?: CompassVisuals;
};

/** These are server-observed prerequisites, not simulated model reasoning or percentages. */
export function compassExecutionSteps(report?: CompassAIState, busy = false) {
  const state = report?.state;
  const modelReady = [
    "WAITING_DATA",
    "NOT_GENERATED",
    "PENDING",
    "FAILED",
    "READY",
  ].includes(state || "");
  const dataReady = ["NOT_GENERATED", "PENDING", "FAILED", "READY"].includes(
    state || "",
  );
  return [
    {
      key: "model",
      title: "模型连接",
      status: modelReady ? ("success" as const) : undefined,
      description: modelReady
        ? "已配置并验证"
        : state
          ? compassAIStates[state] || "等待配置"
          : "读取配置状态",
    },
    {
      key: "data",
      title: "来源报表",
      status: dataReady ? ("success" as const) : undefined,
      description: dataReady
        ? `三张报表已就绪${report?.reportDate ? ` · 截至 ${report.reportDate}` : ""}`
        : "等待同一截止日的三张完整报表",
    },
    {
      key: "analysis",
      title: "生成经营分析",
      status:
        busy || state === "PENDING"
          ? ("loading" as const)
          : state === "READY"
            ? ("success" as const)
            : state === "FAILED"
              ? ("error" as const)
              : undefined,
      description:
        busy || state === "PENDING"
          ? "服务器正在生成，完成后自动更新"
          : state === "READY"
            ? "已读取本批报表的分析结果"
            : state === "FAILED"
              ? report?.message || "生成失败，请重试"
              : "由有权限的用户发起生成",
    },
  ];
}
