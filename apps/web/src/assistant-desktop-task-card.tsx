import { useRef, useState } from "react";
import { Alert, Button, Space, Tag } from "antd";
import { PauseOutlined, StopOutlined } from "@ant-design/icons";
import {
  desktopStatusLabels,
  type DesktopDevice,
  type DesktopTask,
} from "../../../packages/contracts/src/assistant-desktop";
import { api } from "./api";
import { desktopClientRequest, isDesktopClient } from "./desktop-client";

export const isActiveDesktopTask = (task: DesktopTask) =>
  ["WAITING", "RUNNING", "PAUSED", "NEEDS_USER"].includes(task.status);

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
      aria-label={`电脑任务：${task.instruction}`}
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
        {task.deviceName || device?.name || "所选电脑"} · 已执行 {task.step} 步
        {task.window ? ` · ${task.window}` : " · 尚未开始操作窗口"}
        <time dateTime={task.updatedAt}>
          更新于 {new Date(task.updatedAt).toLocaleTimeString("zh-CN")}
        </time>
      </div>
      {task.status === "PAUSED" && (
        <p className="assistant-desktop-task-hint">
          {task.stage.includes("手动操作")
            ? "检测到鼠标或键盘操作后，任务已暂停。确认后点击「继续当前任务」，无需重新发送指令。"
            : "当前任务已暂停。核对上方原因后继续这条任务，无需重新发送指令。"}
        </p>
      )}
      {task.status === "NEEDS_USER" && (
        <p className="assistant-desktop-task-hint">
          请先处理上方提示，再继续当前任务；也可以停止后换一个任务。
        </p>
      )}
      {active &&
        device?.purpose === "dedicated" &&
        task.deviceId !== localDeviceId && (
          <p className="assistant-desktop-task-hint">
            手动接管请打开该专用电脑的远程桌面或云电脑控制台。这里显示任务进度，不提供实时画面。
          </p>
        )}
      {task.status === "WAITING" && device && !device.crossWindowAuthorized && (
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
