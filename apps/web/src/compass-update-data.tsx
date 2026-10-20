import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Modal, Progress, Space, Tag } from "antd";
import { CloudDownloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api, queryClient } from "./api";
import { CompassBrowserLogin } from "./compass-browser-login";
import { when } from "./shared";
import {
  compassDimensions,
  compassLabels,
  type CompassDimension,
} from "../../../packages/contracts/src/compass-analytics";
import {
  compassUpdateActive,
  type CompassUpdateStatusView,
  type CompassUpdateJob,
} from "../../../packages/contracts/src/compass-update";
import {
  compassDimensionProgress,
  compassOverallProgress,
  compassProgressPhase,
  compassProgressSteps,
  isHistoricalCompassUpdate,
} from "./compass-update-progress";
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

function ReportProgress({
  job,
  dimension,
}: {
  job: CompassUpdateJob;
  dimension: CompassDimension;
}) {
  const { label, stage, stageIndex, percent, verified, detail } =
    compassDimensionProgress(job, dimension);
  const active =
    job.status === "RUNNING" && job.progress?.activeDimension === dimension;
  const stopped = [
    "FAILED",
    "PARTIAL",
    "LOGIN_REQUIRED",
    "VERIFICATION_REQUIRED",
  ].includes(job.status);
  const number = (value: number) => value.toLocaleString("zh-CN");
  return (
    <section
      className="compass-update-report"
      aria-label={`${compassLabels[dimension]}报表更新进度`}
    >
      <div className="compass-update-report-heading">
        <strong>按{compassLabels[dimension]}报表</strong>
        <Tag
          color={
            verified
              ? "success"
              : active
                ? "processing"
                : stopped && stage !== "QUEUED"
                  ? "warning"
                  : "default"
          }
        >
          {!detail && !verified ? "阶段明细未记录" : label}
        </Tag>
      </div>
      <Progress
        aria-label={`${compassLabels[dimension]}报表阶段完成度`}
        percent={percent}
        size="small"
        status={verified ? "success" : active && !stopped ? "active" : "normal"}
      />
      {detail && (!verified || detail.parsedRows != null) && (
        <ol
          className="compass-update-steps"
          aria-label={`${compassLabels[dimension]}报表处理阶段`}
        >
          {compassProgressSteps.map((step, index) => (
            <li
              key={step}
              className={
                index < stageIndex
                  ? "is-complete"
                  : index === stageIndex && stage !== "QUEUED"
                    ? "is-current"
                    : ""
              }
              aria-current={
                index === stageIndex && stage !== "QUEUED" ? "step" : undefined
              }
            >
              <span aria-hidden="true">
                {index < stageIndex ? "✓" : index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      )}
      <div className="compass-update-report-counts">
        {detail?.parsedRows != null && (
          <div>已解析 {number(detail.parsedRows)} 行</div>
        )}
        {detail &&
          ["IMPORTING", "VERIFYING", "COMPLETE"].includes(stage) &&
          detail.totalRows != null && (
            <>
              <div>
                已导入 {number(detail.processedRows)} /{" "}
                {number(detail.totalRows)} 行
              </div>
              {detail.totalBatches != null && (
                <div>
                  已提交批次 {detail.batch} / {detail.totalBatches}
                </div>
              )}
            </>
          )}
        {stage === "DOWNLOADING" && <div>等待原始文件下载完成</div>}
        {stage === "PARSING" && detail?.parsedRows == null && (
          <div>正在读取文件，行数待解析确认</div>
        )}
        {stage === "IMPORTING" && detail?.totalRows == null && (
          <div>
            已导入 {number(detail?.processedRows ?? 0)} 行，总行数待确认
          </div>
        )}
        {stage === "QUEUED" && (
          <div>{detail ? "等待前序步骤完成" : "等待服务器返回阶段明细"}</div>
        )}
        {verified && detail?.totalRows == null && (
          <div>目标区间来源已核验，未记录导入行数</div>
        )}
      </div>
      {detail?.note && (
        <p className="compass-update-report-note secondary">{detail.note}</p>
      )}
    </section>
  );
}

export function CompassUpdateData({ manage }: { manage: boolean }) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
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
  const historical =
    !!job && isHistoricalCompassUpdate(job, status.data?.target);
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
        (old) =>
          old
            ? { ...old, job: next, target: result.data.target ?? old.target }
            : old,
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
    if (
      requested.current ||
      ["LOGIN_REQUIRED", "VERIFICATION_REQUIRED"].includes(
        refreshed.data?.job?.status || "",
      )
    )
      await start();
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
        width={880}
        className="compass-update-modal"
        styles={{
          body: { maxHeight: "calc(100dvh - 240px)", overflowY: "auto" },
        }}
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
        {error && <Alert type="error" showIcon title={error} />}
        {status.error && (
          <Alert
            type="warning"
            showIcon
            title="暂时无法获取最新进度"
            description={`${status.error.message}；保留最后确认结果，连接恢复后继续刷新。`}
          />
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
        {status.data?.target && (
          <p className="compass-update-target">
            <strong>本次目标</strong> {status.data.target.startDate} —{" "}
            {status.data.target.endDate}
          </p>
        )}
        {busy && !running && (
          <Alert type="info" showIcon title="正在发起本次更新" />
        )}
        {job ? (
          <div className="compass-update-job">
            {historical && (
              <Alert
                type="info"
                showIcon
                title="上次更新结果"
                description="以下为历史任务的实际结果，本次目标尚未更新。点击「开始更新」处理最新目标区间。"
              />
            )}
            <p>
              <Tag color={color}>{label}</Tag> {job.targetStartDate} —{" "}
              {job.targetEndDate}
            </p>
            {!historical && (
              <>
                <div className="compass-update-overall-heading">
                  <strong>整体阶段完成度</strong>
                  <span>
                    已核验 {job.completedDimensions.length} / 3 张报表
                  </span>
                </div>
                <Progress
                  aria-label="整体阶段完成度"
                  percent={compassOverallProgress(job)}
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
                <p className="compass-update-phase" role="status">
                  {compassProgressPhase(job)}
                </p>
                <p className="secondary compass-update-progress-explanation">
                  进度按准备、下载、解析、导入、校验五个阶段计算；导入阶段按实际成功写入行数推进，不代表预计耗时。
                </p>
              </>
            )}
            <div className="compass-update-dimensions">
              {compassDimensions.map((dimension) => (
                <ReportProgress
                  key={dimension}
                  job={job}
                  dimension={dimension}
                />
              ))}
            </div>
            {!job.progress && (
              <p className="secondary">
                此任务没有保存阶段明细，仅显示已核验维度；新发起的任务提供详细进度。
              </p>
            )}
            {job.note && <p role="status">{job.note}</p>}
            <p className="secondary">
              发起于 {when(job.requestedAt)}
              {job.startedAt ? ` · 开始于 ${when(job.startedAt)}` : ""}
              {job.completedAt ? ` · 结束于 ${when(job.completedAt)}` : ""}
            </p>
            {job.progress?.updatedAt && (
              <p className="secondary">
                最近进展 {when(job.progress.updatedAt)}
              </p>
            )}
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
        <p className="secondary">
          下载或导入失败时保留已有报表；只有完整导入并核验的维度才替换来源。重复点击会复用正在执行的任务，当天三张报表已齐备时直接显示核验结果。
        </p>
      </Modal>
    </>
  );
}
