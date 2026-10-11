import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Modal, Progress, Space, Switch, Tag } from "antd";
import { CloudDownloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api, queryClient } from "./api";
import { CompassBrowserLogin } from "./compass-browser-login";
import { when } from "./shared";
import {
  compassDimensions,
  compassLabels,
} from "../../../packages/contracts/src/compass-analytics";
import {
  compassUpdateActive,
  type CompassUpdateStatusView,
  type CompassUpdateJob,
} from "../../../packages/contracts/src/compass-update";
import "./compass-update-data.css";

const endpoint = "/analytics/compass/updates";
const updateLabels: Record<string, [string, string]> = {
  QUEUED: ["等待后台执行", "processing"],
  RUNNING: ["正在下载并导入", "processing"],
  LOGIN_REQUIRED: ["需要登录罗盘", "warning"],
  VERIFICATION_REQUIRED: ["需要平台验证", "warning"],
  COMPLETE: ["三张报表已核验", "success"],
  PARTIAL: ["部分更新完成", "warning"],
  FAILED: ["更新未完成", "error"],
};
const sessionLabels: Record<string, string> = {
  DISCONNECTED: "服务器未登录罗盘",
  READY: "服务器罗盘会话已保存",
  LOGIN_REQUIRED: "罗盘会话需重新登录",
  VERIFICATION_REQUIRED: "罗盘会话需要验证",
  ERROR: "罗盘会话异常",
};

export function CompassUpdateData({ manage }: { manage: boolean }) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [savingSchedule, setSavingSchedule] = useState(false),
    [error, setError] = useState("");
  const completed = useRef(""),
    watched = useRef(""),
    requested = useRef(false),
    imported = useRef("");
  const status = useQuery<CompassUpdateStatusView>({
    queryKey: ["compass-update-status"],
    queryFn: async () => (await api(endpoint)).data,
    refetchInterval: (query) =>
      ["QUEUED", "RUNNING"].includes(query.state.data?.job?.status || "")
        ? 2000
        : open
          ? 5000
          : 60000,
  });
  const job = status.data?.job,
    session = status.data?.session,
    running = ["QUEUED", "RUNNING"].includes(job?.status || ""),
    waitingLogin = ["LOGIN_REQUIRED", "VERIFICATION_REQUIRED"].includes(
      job?.status || "",
    ),
    unavailable = !session?.encryptionReady || !session.workerOnline;
  const schedule = useQuery<{
    enabled: boolean;
    dailyHour: number;
    lastScheduledDay: string | null;
    eligible: boolean;
  }>({
    queryKey: ["compass-auto-update-settings"],
    enabled: open && manage,
    queryFn: async () =>
      (await api("/analytics/compass/auto-update-settings")).data,
  });
  useEffect(() => {
    if (job && compassUpdateActive.includes(job.status))
      watched.current = job.id;
    const sourceKey = job?.completedDimensions.length
      ? JSON.stringify(job.sourceIds)
      : "";
    if (sourceKey && imported.current !== sourceKey) {
      imported.current = sourceKey;
      void queryClient.invalidateQueries({ queryKey: ["compass-dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["compass-ai-report"] });
    }
    if (job?.status !== "COMPLETE" || completed.current === job.id) return;
    completed.current = job.id;
    requested.current = false;
    void queryClient.invalidateQueries({ queryKey: ["compass-dashboard"] });
    void queryClient.invalidateQueries({ queryKey: ["compass-ai-report"] });
    void queryClient.invalidateQueries({
      queryKey: ["compass-auto-update-settings"],
    });
    if (watched.current === job.id)
      message.success("罗盘三张报表已核验，经营分析已刷新");
  }, [
    job?.id,
    job?.status,
    job?.sourceIds,
    job?.completedDimensions.length,
    message,
  ]);

  async function start() {
    setOpen(true);
    setError("");
    if (busy || running) return;
    requested.current = true;
    setBusy(true);
    try {
      const result = await api(endpoint, "POST", {}),
        next = result.data.job as CompassUpdateJob;
      watched.current = next.id;
      queryClient.setQueryData<CompassUpdateStatusView>(
        ["compass-update-status"],
        (old) => (old ? { ...old, job: next } : old),
      );
      await status.refetch();
    } catch (e) {
      setError((e as Error).message);
      void status.refetch();
    } finally {
      setBusy(false);
    }
  }
  async function connected() {
    const refreshed = await status.refetch();
    void schedule.refetch();
    if (
      requested.current ||
      ["LOGIN_REQUIRED", "VERIFICATION_REQUIRED"].includes(
        refreshed.data?.job?.status || "",
      )
    )
      await start();
  }
  async function saveSchedule(enabled: boolean) {
    if (savingSchedule) return;
    setSavingSchedule(true);
    setError("");
    try {
      const result = await api(
        "/analytics/compass/auto-update-settings",
        "POST",
        { enabled },
      );
      queryClient.setQueryData(["compass-auto-update-settings"], result.data);
      message.success(
        enabled
          ? "已开启每天08:00服务器更新，保存不会立即执行"
          : "已关闭每日服务器更新",
      );
    } catch (e) {
      setError((e as Error).message);
      void schedule.refetch();
    } finally {
      setSavingSchedule(false);
    }
  }
  const [label, color] = updateLabels[job?.status || ""] || [
    "尚未开始更新",
    "default",
  ];
  const connectionNote = !session?.encryptionReady
    ? "服务器登录加密尚未配置，暂时不能保存会话或开始下载。"
    : !session.workerOnline
      ? "服务器下载程序离线，当前无法执行更新；已有报表继续保留。"
      : !session.enabled || session.status === "DISCONNECTED"
        ? "服务器尚未保存罗盘会话，请点击「扫码登录罗盘」建立独立登录。"
        : "";
  return (
    <>
      <Button
        type={manage ? "primary" : "default"}
        icon={<CloudDownloadOutlined aria-hidden="true" />}
        loading={busy}
        onClick={() => (manage ? void start() : setOpen(true))}
      >
        {manage ? (running ? "查看更新进度" : "更新数据") : "更新状态"}
      </Button>
      <Modal
        title="更新罗盘数据"
        open={open}
        onCancel={() => setOpen(false)}
        width={720}
        footer={
          <Space wrap>
            {manage && (
              <CompassBrowserLogin
                session={session}
                onConnected={() => void connected()}
                onDisconnected={() => void status.refetch()}
              />
            )}
            {manage && !running && (
              <Button
                type="primary"
                loading={busy}
                onClick={() => void start()}
              >
                {job?.status === "FAILED" || job?.status === "PARTIAL"
                  ? "重试更新"
                  : "开始更新"}
              </Button>
            )}
            <Button onClick={() => setOpen(false)}>关闭</Button>
          </Space>
        }
      >
        <p>
          服务器复用已保存的魔方罗盘会话，下载并导入截至昨日的近30天款号、货号、条码报表。关闭此窗口不影响已启动的后台任务，电脑可以关机。
        </p>
        {(error || status.error) && (
          <Alert type="error" showIcon title={error || status.error?.message} />
        )}
        {session && connectionNote && (
          <Alert type="warning" showIcon title={connectionNote} />
        )}
        {session && (
          <p className="compass-update-session">
            <Tag color={session.status === "READY" ? "success" : "warning"}>
              {sessionLabels[session.status] || "服务器会话待核验"}
            </Tag>
            {session.savedAt && <span>保存于 {when(session.savedAt)}</span>}
          </p>
        )}
        {session?.note && <p className="secondary">{session.note}</p>}
        {job ? (
          <div className="compass-update-job" aria-live="polite">
            <p>
              <Tag color={color}>{label}</Tag> {job.targetStartDate} —{" "}
              {job.targetEndDate}
            </p>
            <Progress
              percent={Math.round((job.completedDimensions.length / 3) * 100)}
              status={
                job.status === "FAILED"
                  ? "exception"
                  : running
                    ? "active"
                    : job.status === "COMPLETE"
                      ? "success"
                      : "normal"
              }
            />
            <div className="compass-update-dimensions">
              {compassDimensions.map((dimension) => (
                <div key={dimension}>
                  <strong>按{compassLabels[dimension]}报表</strong>
                  <Tag
                    color={
                      job.completedDimensions.includes(dimension)
                        ? "success"
                        : "default"
                    }
                  >
                    {job.completedDimensions.includes(dimension)
                      ? "已导入并核验"
                      : "待完成"}
                  </Tag>
                </div>
              ))}
            </div>
            {job.note && <p role="status">{job.note}</p>}
            <p className="secondary">
              发起于 {when(job.requestedAt)}
              {job.completedAt ? ` · 结束于 ${when(job.completedAt)}` : ""}
            </p>
          </div>
        ) : (
          <p>尚无服务器更新记录。</p>
        )}
        {waitingLogin && manage && !unavailable && (
          <Alert
            type="warning"
            showIcon
            title="请在此扫码或完成平台验证"
            description="点击「扫码登录罗盘」，核验并保存后继续当前更新。已完成的维度不会重复累计。"
          />
        )}
        {!manage && (
          <Alert
            type="info"
            showIcon
            title="当前账号可查看更新状态"
            description="启动更新、扫码及管理服务器会话需要经营分析导入与邮件配置权限。"
          />
        )}
        {manage && (
          <div className="compass-update-schedule">
            <Space wrap>
              <strong>每日08:00自动更新</strong>
              <Switch
                aria-label="每日08:00自动更新"
                checked={!!schedule.data?.enabled}
                loading={savingSchedule || schedule.isLoading}
                disabled={
                  savingSchedule ||
                  !schedule.data ||
                  (!schedule.data.enabled && !schedule.data.eligible)
                }
                onChange={(enabled) => void saveSchedule(enabled)}
              />
              <span className="secondary">北京时间</span>
            </Space>
            {schedule.error && (
              <Alert type="error" title={schedule.error.message} />
            )}
            <p className="secondary">
              默认关闭。先保存罗盘登录并完成一次三张报表更新，再开启；保存设置不会立即下载。服务器准备好后，请暂停旧的
              Dot 同类定时任务，避免重复执行。
            </p>
            {schedule.data?.lastScheduledDay && (
              <p className="secondary">
                最近定时发起日期：{schedule.data.lastScheduledDay}
                ，实际结果以更新记录为准。
              </p>
            )}
          </div>
        )}
        <p className="secondary">
          下载或导入失败时保留已有报表；只有完整导入并核验的维度才替换来源。重复点击会复用正在执行的任务，当天三张报表已齐备时直接显示核验结果。
        </p>
      </Modal>
    </>
  );
}
