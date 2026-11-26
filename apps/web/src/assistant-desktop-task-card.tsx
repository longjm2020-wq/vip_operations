import { useRef, useState } from "react";
import { Alert, Button, Space, Tag } from "antd";
import { PauseOutlined, StopOutlined } from "@ant-design/icons";
import {
  desktopMissingAttachmentDirectory,
  desktopStatusLabels,
  type DesktopDevice,
  type DesktopTask,
} from "../../../packages/contracts/src/assistant-desktop";
import { desktopExplorerIntent } from "../../../packages/contracts/src/assistant-execution";
import { desktopFolderAttachmentTargetPolicy } from "../../../packages/contracts/src/desktop-folder-creation";
import { api } from "./api";
import { desktopClientRequest, isDesktopClient } from "./desktop-client";
import { desktopReceiverProblem } from "./desktop-setup";

export const isActiveDesktopTask = (task: DesktopTask) =>
  ["WAITING", "RUNNING", "PAUSED", "NEEDS_USER"].includes(task.status);

const backgroundTaskLabels: Partial<Record<NonNullable<DesktopTask["nativeAction"]>, string>> = {
  copy_folder_attachment: "后台分发附件",
  copy_folder_attachments: "后台分发附件",
  create_folders_with_attachments: "后台建目录并分发附件",
  create_desktop_folders: "后台批量建文件夹",
  create_folder_notes: "后台批量建文本",
  create_folders_with_notes: "后台批量建目录和文本",
};

const folderStepLabels: Record<NonNullable<DesktopTask["folderSteps"]>[number], string> = {
  copy_attachment: "按附件原名复制到每个指定子目录",
  copy_attachments: "将每个附件按原名复制到每个指定子目录",
  ensure_directories: "按名称清单补齐父目录和子目录",
  ensure_same_name_text: "在每个子目录中补齐同名 .txt 文件",
  verify: "核对清单中的所有目标并返回结果",
};

type StepReceipt = NonNullable<DesktopTask["recentSteps"]>[number];
const actionLabels: Record<StepReceipt["action"], string> = {
  locate_wecom: "定位企业微信",
  file_copy: "后台复制文件",
  copy_attachment: "复制并核验附件",
  copy_attachments: "复制并核验各目录中的全部附件",
  create_folders: "批量创建文件夹",
  create_notes: "核对同名文本文件",
  create_folders_and_notes: "创建并核验目录和同名文本",
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

function receiptAction(receipt: StepReceipt) {
  if (receipt.action === "key" && receipt.fileShortcut === "copy") return "复制文件";
  if (receipt.action === "key" && receipt.fileShortcut === "paste") return "粘贴文件";
  return actionLabels[receipt.action];
}

function receiptResult(receipt: StepReceipt) {
  if (receipt.action === "key" && receipt.fileShortcut === "paste" && receipt.verifiedAfterPaste)
    return "事后已核验";
  if (["file_copy", "copy_attachment", "copy_attachments", "create_folders", "create_notes", "create_folders_and_notes"].includes(receipt.action) && receipt.result === "ok") return "已核验";
  return resultLabels[receipt.result];
}

function missingAttachmentDirectory(task: DesktopTask) {
  if (task.status === "NEEDS_USER" && (task.nativeAction === "copy_folder_attachment" || task.nativeAction === "copy_folder_attachments"))
    return desktopMissingAttachmentDirectory(task.stage, task.folderCreation);
}

function handoffHint(task: DesktopTask, device?: DesktopDevice, missingDirectory?: string) {
  if (task.status !== "NEEDS_USER" && task.status !== "PAUSED") return;
  if (missingDirectory) {
    if (desktopFolderAttachmentTargetPolicy(task.instruction) === "create-missing")
      return "在 Windows 小序 1.2.20 或更高版本点击「继续当前任务」，会自动补齐清单中缺少的目录，使用原附件继续分发。";
    return "这条指令限制了可用目录。请核对并备齐原清单中的目录，再点击「继续当前任务」，已提交的附件会继续使用。";
  }
  if (task.folderAttachment || task.folderAttachments?.length)
    return "请按任务提示核对目标目录和同名文件，再继续补齐附件。";
  if (task.nativeAction === "create_folders_with_notes")
    return "请核对任务提示中的目录或文件，处理后继续，客户端会补齐缺少的目录和同名文本。";
  if (task.nativeAction === "create_folder_notes")
    return "请在执行电脑核对提示中的目录或文件，处理后可继续补齐缺少的同名文本。";
  if (task.nativeAction === "create_desktop_folders")
    return "请在执行电脑的桌面核对目标文件夹，处理任务提示后可继续，已有的普通目录会再次核验。";
  if (task.nativeAction === "copy_finder_files")
    return "请在 Mac 核对源文件和目标文件夹，确认 Finder 助手正在接单，再点「继续当前任务」。";
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
  const backgroundLabel = task.fileCopyMode === "background" ? "后台文件复制" :
    task.nativeAction && backgroundTaskLabels[task.nativeAction];
  const attachments = task.folderAttachments ?? (task.folderAttachment ? [task.folderAttachment] : []);
  const folderCount = task.folderCreation?.folderNames.length ?? 0;
  const awaitingVerification = task.status === "NEEDS_USER" && task.fileCopyProgress === "awaiting_verification";
  const retrying = task.status === "WAITING" && task.fileCopyProgress === "retrying";
  const verified = task.status === "DONE" && (task.fileCopyProgress === "verified" ||
    (task.fileCopyMode === "background" && task.recentSteps?.some(receipt => receipt.action === "file_copy" && receipt.result === "ok")));
  const statusLabel = awaitingVerification ? "等待自动核验" : retrying ? "等待自动重试" :
    verified ? "复制已核验" : desktopStatusLabels[task.status];
  const missingDirectory = missingAttachmentDirectory(task);
  const hint = awaitingVerification ? undefined : handoffHint(task, device, missingDirectory);
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
            task.status === "RUNNING" || awaitingVerification || retrying
              ? "processing"
              : ["PAUSED", "NEEDS_USER"].includes(task.status)
                ? "warning"
                : task.status === "DONE"
                  ? "success"
                  : undefined
          }
        >
          {statusLabel}
        </Tag>
        <strong>{task.instruction}</strong>
      </div>
      {attachments.length > 0 && (
        <div className="assistant-desktop-attachments">
          <p>{attachments.map(file => file.name).join("、")}</p>
          {folderCount > 0 && <p>{attachments.length} 个附件 × {folderCount} 个子目录，共 {attachments.length * folderCount} 份</p>}
        </div>
      )}
      <p role="status">{awaitingVerification
        ? "请保持所选电脑的最新版桌面端连接。接单后会自动检查目标文件，无需再次粘贴。"
        : missingDirectory ? `找不到目标目录「${missingDirectory}」。` : task.stage}</p>
      <div className="assistant-desktop-task-meta">
        {task.localBrowser && "本地浏览器 · "}
        {backgroundLabel && `${backgroundLabel} · `}
        {task.deviceName || device?.name || "所选电脑"} · 步骤回执 {task.step}{" "}
        次
        {typeof task.confirmedSteps === "number" &&
          ` · 已确认执行 ${task.confirmedSteps} 步`}
        {!backgroundLabel && (task.window ? ` · ${task.window}` : " · 暂无窗口记录")}
        <time dateTime={task.updatedAt}>
          更新于 {new Date(task.updatedAt).toLocaleTimeString("zh-CN")}
        </time>
      </div>
      {!!task.folderSteps?.length && (
        <details className="assistant-desktop-plan">
          <summary>后台执行计划</summary>
          <ol>{task.folderSteps.map(step => <li key={step}>{folderStepLabels[step]}</li>)}</ol>
        </details>
      )}
      {!!task.recentSteps?.length && (
        <details className="assistant-desktop-receipts">
          <summary>最近步骤回执</summary>
          <ol aria-label="最近步骤回执">
            {task.recentSteps.map((receipt) => (
              <li key={receipt.step}>
                <span>第 {receipt.step} 步</span>
                <span>{receiptAction(receipt)}</span>
                <span>{receiptResult(receipt)}</span>
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
      {(task.status === "WAITING" || awaitingVerification) && receiverProblem && (
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
          {(task.status === "RUNNING" || awaitingVerification || retrying) && (
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
          {["PAUSED", "NEEDS_USER"].includes(task.status) && !awaitingVerification && (
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
