import { useRef, useState } from "react";
import { Alert, Button, Space, Tag } from "antd";
import { PauseOutlined, StopOutlined } from "@ant-design/icons";
import {
  desktopStatusLabels,
  type DesktopDevice,
  type DesktopTask,
} from "../../../packages/contracts/src/assistant-desktop";
import { desktopExplorerIntent } from "../../../packages/contracts/src/assistant-execution";
import { api } from "./api";
import { desktopClientRequest, isDesktopClient } from "./desktop-client";
import { desktopReceiverProblem } from "./desktop-setup";

export const isActiveDesktopTask = (task: DesktopTask) =>
  ["WAITING", "RUNNING", "PAUSED", "NEEDS_USER"].includes(task.status);

type StepReceipt = NonNullable<DesktopTask["recentSteps"]>[number];
const actionLabels: Record<StepReceipt["action"], string> = {
  click: "点击",
  scroll: "滚动",
  type: "输入文字",
  key: "按键",
  switch_window: "切换窗口",
  wait: "等待",
};
const resultLabels: Record<StepReceipt["result"], string> = {
  ok: "已执行",
  blocked: "未执行",
  uncertain: "未确认",
};

function handoffHint(task: DesktopTask, device?: DesktopDevice) {
  if (task.status !== "NEEDS_USER" && task.status !== "PAUSED") return;
  if (task.stage.includes("遮挡") || task.stage.includes("弹出菜单已变化")) {
    if (
      !task.localBrowser &&
      !task.previousTaskId &&
      desktopExplorerIntent(task.instruction)
    ) {
      const resume =
        device?.crossWindowAuthorized === undefined
          ? "按提示继续原任务"
          : device.crossWindowAuthorized
            ? "点击「从此窗口继续」"
            : "点击「允许本次任务」";
      return `在目标电脑的文件资源管理器打开「桌面」，核对已有的文件夹和文件，打开要继续操作的目录。移开遮挡窗口，在本机「电脑任务 → 高级设置」选择这个资源管理器窗口，${resume}。`;
    }
    const target = task.window ? `「${task.window}」` : "原操作窗口";
    const next = task.stage.includes("遮挡") ? "移开遮挡窗口" : "核对当前菜单";
    return `在目标电脑切回${target}，${next}后点击「继续当前任务」。`;
  }
  if (task.stage.includes("手动操作"))
    return "核对刚才操作后的窗口，准备好后点击「继续当前任务」。";
  if (task.status === "NEEDS_USER")
    return "请在目标电脑处理上方提示，核对窗口内容后点击「继续当前任务」。";
  return "核对暂停原因和窗口内容，准备好后点击「继续当前任务」。";
}

export function AssistantDesktopTaskCard({
  task,
  device,
  localDeviceId,
  refresh,
  compact = false,
}: {
  task: DesktopTask;
  device?: DesktopDevice;
  localDeviceId?: string;
  refresh: () => Promise<unknown>;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(false);
  const active = isActiveDesktopTask(task);
  const receiverProblem = device ? desktopReceiverProblem(device) : "";
  const taskLabel = task.localBrowser ? "本地浏览器任务" : "电脑任务";
  const hint = handoffHint(task, device);
  const control = async (action: "pause" | "resume" | "stop") => {
    if (pending.current) return;
    pending.current = true;
    setBusy(action);
    setError("");
    try {
      await api(
        `/my-workspace/assistant/desktop/tasks/${task.id}/control`,
        "POST",
        { action },
      );
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      pending.current = false;
      setBusy("");
    }
  };
  return (
    <section
      className={`assistant-desktop-item assistant-desktop-task${compact ? " assistant-desktop-task-compact" : ""}`}
      aria-label={`${taskLabel}：${task.instruction}`}
      data-desktop-task-id={task.id}
    >
      <div className="assistant-desktop-task-heading">
        <Tag
          color={
            task.status === "RUNNING"
              ? "processing"
              : ["PAUSED", "NEEDS_USER"].includes(task.status)
                ? "warning"
                : task.status === "DONE"
                  ? "success"
                  : undefined
          }
        >
          {desktopStatusLabels[task.status]}
        </Tag>
        <strong>{task.instruction}</strong>
      </div>
      <p role="status">{task.stage}</p>
      <div className="assistant-desktop-task-meta">
        {task.localBrowser && "本地浏览器 · "}
        {task.deviceName || device?.name || "所选电脑"} · 步骤回执 {task.step}{" "}
        次
        {typeof task.confirmedSteps === "number" &&
          ` · 已确认执行 ${task.confirmedSteps} 步`}
        {task.window ? ` · ${task.window}` : " · 暂无窗口记录"}
        <time dateTime={task.updatedAt}>
          更新于 {new Date(task.updatedAt).toLocaleTimeString("zh-CN")}
        </time>
      </div>
      {!!task.recentSteps?.length && (
        <details className="assistant-desktop-receipts">
          <summary>最近步骤回执</summary>
          <ol aria-label="最近步骤回执">
            {task.recentSteps.map((receipt) => (
              <li key={receipt.step}>
                <span>第 {receipt.step} 步</span>
                <span>{actionLabels[receipt.action]}</span>
                <span>{resultLabels[receipt.result]}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
      {hint && <p className="assistant-desktop-task-hint">{hint}</p>}
      {active &&
        device?.purpose === "dedicated" &&
        task.deviceId !== localDeviceId && (
          <p className="assistant-desktop-task-hint">
            手动接管请到所选电脑上操作。这里显示任务进度，不提供实时画面。
          </p>
        )}
      {task.status === "WAITING" && receiverProblem && (
        <p className="assistant-desktop-task-hint">{receiverProblem}</p>
      )}
      {task.status === "WAITING" &&
        !receiverProblem &&
        device &&
        !device.crossWindowAuthorized && (
          <p className="assistant-desktop-task-hint">
            请在该电脑的「电脑任务」选择窗口并允许本次任务。
          </p>
        )}
      {active && (
        <Space wrap className="assistant-desktop-task-actions">
          {task.status === "RUNNING" && (
            <Button
              size="small"
              icon={<PauseOutlined aria-hidden />}
              loading={busy === "pause"}
              disabled={!!busy}
              onClick={() => void control("pause")}
            >
              暂停任务
            </Button>
          )}
          {["PAUSED", "NEEDS_USER"].includes(task.status) && (
            <Button
              type="primary"
              size="small"
              loading={busy === "resume"}
              disabled={!!busy}
              onClick={() => void control("resume")}
            >
              继续当前任务
            </Button>
          )}
          <Button
            size="small"
            icon={<StopOutlined aria-hidden />}
            loading={busy === "stop"}
            disabled={!!busy}
            onClick={() => void control("stop")}
          >
            停止任务
          </Button>
          {isDesktopClient() && task.deviceId === localDeviceId && (
            <Button
              size="small"
              disabled={!!busy}
              onClick={() =>
                void desktopClientRequest("show-tasks").catch((cause) =>
                  setError((cause as Error).message),
                )
              }
            >
              打开本机任务
            </Button>
          )}
        </Space>
      )}
      {error && <Alert type="error" showIcon title={error} />}
    </section>
  );
}
