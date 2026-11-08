import { one, rows, db } from "../../../../../packages/database/src/index.js";
import {
  bailianVideoProvider,
  submitBailianVideo,
  pollBailianVideo,
  // @ts-expect-error The JavaScript adapter is validated by provider contract tests.
} from "../../../../../packages/aigc-engine/vendor/cloud/bailian-video.mjs";
import { engineConfig, storedSettings } from "./config.js";

const conflict = (message: string) =>
  Object.assign(new Error(message), { statusCode: 409 });
async function persistCheck(revision: number, check: Record<string, unknown>) {
  await rows(
    db,
    "UPDATE aigc_settings SET config=jsonb_set(config,'{bailianVideoCheck}',$1::jsonb,true) WHERE id=1 AND revision=$2",
    JSON.stringify(check),
    revision,
  );
  return check;
}
/** A single durable test task, never a retry loop that creates paid videos. */
export async function startVideoCheck(input: unknown, userId: string) {
  if (!(
    input &&
    typeof input === "object" &&
    "confirmPaid" in input &&
    input.confirmPaid === true
  ))
    throw Object.assign(
      new Error("请确认生成 4 秒 768P 测试视频，刊例约 2 元"),
      { statusCode: 400 },
    );
  const setting = await storedSettings();
  const existing = setting.config.bailianVideoCheck;
  if (existing?.state === "pending") return existing;
  if (["submitting", "uncertain"].includes(existing?.state))
    throw conflict(
      "上次测试提交结果待核实，未创建重复任务；请先在百炼检查请求记录",
    );
  const config = await engineConfig();
  if (!config.bailianWorkspaceId || !config.videoSecrets.BAILIAN_VIDEO_API_KEY)
    throw Object.assign(new Error("请先保存百炼视频连接"), { statusCode: 400 });
  const provider = bailianVideoProvider(config),
    route = { ...provider, model: provider.models[0], resolution: "768P" };
  const check = {
    state: "submitting",
    startedAt: new Date().toISOString(),
    createdBy: userId,
    model: route.model.model,
  };
  const claimed = await one(
    db,
    `UPDATE aigc_settings SET config=jsonb_set(config,'{bailianVideoCheck}',$1::jsonb,true)
    WHERE id=1 AND revision=$2 AND COALESCE(config->'bailianVideoCheck'->>'state','') NOT IN ('submitting','pending','uncertain') RETURNING revision`,
    JSON.stringify(check),
    setting.revision,
  );
  if (!claimed) throw conflict("连接配置或测试状态已变化，请刷新后重试");
  let taskId: string;
  try {
    taskId = await submitBailianVideo(config, route, {
      prompt: "固定镜头，纯色背景下一块蓝色布料随微风轻动，无人物、无文字。",
      duration: 4,
      aspectRatio: "16:9",
      referenceImages: [],
    });
  } catch (error) {
    // Without a task ID even a network error can follow an accepted submission.
    const message =
      error instanceof Error ? error.message : "测试请求结果待核实";
    const notSubmitted =
      error &&
      typeof error === "object" &&
      "notSubmitted" in error &&
      error.notSubmitted === true;
    return persistCheck(setting.revision, {
      ...check,
      state: notSubmitted ? "failed" : "uncertain",
      message,
    });
  }
  return persistCheck(setting.revision, { ...check, state: "pending", taskId });
}
export async function videoCheckStatus() {
  const setting = await storedSettings();
  const check = setting.config.bailianVideoCheck;
  const missingFailureDetails =
    check?.state === "failed" && !check.detailsCheckedAt;
  if (
    !check ||
    (check.state !== "pending" && !missingFailureDetails) ||
    !check.taskId
  )
    return check || null;
  const config = await engineConfig();
  const provider = bailianVideoProvider(config),
    route = { ...provider, model: provider.models[0], resolution: "768P" };
  const result = await pollBailianVideo(config, route, check.taskId);
  if (result.pending) return check;
  return persistCheck(setting.revision, {
    ...check,
    state: result.url ? "succeeded" : "failed",
    completedAt: new Date().toISOString(),
    detailsCheckedAt: new Date().toISOString(),
    ...(result.url
      ? { videoUrl: result.url }
      : {
          errorCode: result.errorCode || null,
          message: `百炼任务结束于 ${result.state}${result.errorCode ? `（${result.errorCode}）` : ""}；${result.errorHint || "未重复提交"}`,
        }),
  });
}
