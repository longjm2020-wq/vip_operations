import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Modal, Progress, Space, Tag, Tooltip } from "antd";
import { SyncOutlined } from "@ant-design/icons";
import { api, queryClient } from "./api";
import { useCan, when } from "./shared";

type Job = {
  namespace: string;
  status: string;
  checked: number | string;
  total: number | string;
  unresolved: number | string;
  heartbeatAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  runId?: string;
  runStartedAt?: string;
  runFinishedAt?: string;
  runTotal?: number | string;
  runCompleted?: number | string;
  runFailed?: number | string;
  fullRun?: boolean;
};
const active = (job: Job) => ["READY", "RUNNING", "CONTINUING"].includes(job.status);
const online = (job: Job) => !!job.heartbeatAt && Date.now() - Date.parse(job.heartbeatAt) < 120000;
const labels: Record<string, string> = {
  READY: "等待同步", RUNNING: "正在核验", CONTINUING: "继续下一批",
  SUCCESS: "同步完成", PARTIAL: "部分条码待处理", FAILED: "同步失败", BLOCKED: "需要处理",
};

export function InventoryPlatformSync() {
  const can = useCan("vip.settings");
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [watching, setWatching] = useState(false);
  const [requestError, setRequestError] = useState("");
  const pending = useRef(new Map<string, { runId?: string; previousSuccess?: string }>());
  const running = useRef(new Set<string>());
  const overview = useQuery({
    queryKey: ["vip-status"],
    queryFn: ({ signal }) => api("/integrations/vip/status", "GET", undefined, undefined, { signal }),
    enabled: can,
    refetchInterval: open || watching ? 3000 : 15000,
  });
  const jobs: Job[] = overview.data?.data?.listing?.jobs ?? [];

  useEffect(() => {
    const current: Job[] = overview.data?.data?.listing?.jobs ?? [];
    let changed = false;
    for (const job of current) {
      const requested = pending.current.has(job.namespace);
      const expected = pending.current.get(job.namespace);
      // Match the acknowledged run, not a recent cache count or an older terminal snapshot.
      if (expected?.runId && job.runId !== expected.runId) continue;
      if (active(job)) { running.current.add(job.namespace); continue; }
      // Backward compatibility while the API and web service roll out separately.
      if (requested && !expected?.runId && job.status === "SUCCESS" && job.lastSuccessAt === expected?.previousSuccess) continue;
      if (job.runId && !job.runFinishedAt) continue;
      if (!requested && !running.current.has(job.namespace)) continue;
      running.current.delete(job.namespace);
      pending.current.delete(job.namespace);
      changed = true;
      if (requested) {
        if (job.status === "SUCCESS") message.success("唯品会平台状态同步完成，已刷新库存明细状态");
        else message.warning(`平台状态${labels[job.status] ?? "尚未完成"}，请查看同步详情`);
      }
    }
    if (changed) {
      void queryClient.invalidateQueries({ queryKey: ["/inventory/summary"] });
      setWatching(pending.current.size > 0);
    }
  }, [overview.data, overview.dataUpdatedAt, message]);

  async function sync() {
    setSubmitting(true);
    setRequestError("");
    try {
      // Recheck current tasks before submitting; another tab may already have started one.
      const fresh = await overview.refetch();
      if (fresh.error) throw fresh.error;
      const available: Job[] = fresh.data?.data?.listing?.jobs ?? [];
      const ready = available.filter((job) => !active(job) && online(job));
      if (!ready.length) throw new Error("当前没有可提交的连接，请查看任务状态或后台服务提示。");
      for (const job of ready) {
        const result = await api("/integrations/vip/listing/sync", "POST", { namespace: job.namespace });
        pending.current.set(job.namespace, { runId: result.data?.runId, previousSuccess: job.lastSuccessAt });
        setWatching(true);
      }
      message.info("已提交平台状态核验，请等待后台完整处理。");
    } catch (error) {
      setRequestError((error as Error).message);
    } finally {
      setSubmitting(false);
      await overview.refetch();
    }
  }

  return <>
    <Tooltip title={can ? "核验唯品会条码与款号上下架状态" : "需要唯品会接入管理权限"}>
      <Button aria-label="同步唯品会状态" icon={<SyncOutlined spin={watching || jobs.some(active)} aria-hidden />} disabled={!can}
        onClick={() => setOpen(true)}>同步唯品会状态</Button>
    </Tooltip>
    <Modal title="唯品会平台状态同步" open={open} onCancel={() => setOpen(false)}
      footer={<Space>
        <Button onClick={() => setOpen(false)}>关闭</Button>
        <Button type="primary" loading={submitting}
          disabled={watching || overview.isFetching || !!overview.error || !jobs.some((job) => online(job) && !active(job))}
          onClick={() => void sync()}>立即同步</Button>
      </Space>}>
      <p>重新查询任务开始时已采集条码的唯品会上下架状态，并汇总款号状态。完成后自动刷新明细与状态数量。</p>
      {(overview.error || requestError) && <Alert showIcon type="error"
        title={requestError || (overview.error as Error).message}
        action={<Button size="small" onClick={() => void overview.refetch()}>重试读取</Button>} />}
      {overview.isLoading && <p>正在读取同步状态…</p>}
      {!overview.isLoading && !overview.error && !jobs.length && <Alert showIcon type="warning" title="尚未配置唯品会平台状态采集连接，请在唯品会接入中检查配置。" />}
      {jobs.map((job) => {
        const expected = pending.current.get(job.namespace);
        if (expected?.runId && job.runId !== expected.runId) return <div key={job.namespace} className="inventory-platform-sync-job">
          <Tag color="processing">等待本轮状态</Tag><p>任务已提交，正在读取本轮进度…</p>
        </div>;
        const total = Number(job.runTotal ?? 0), completed = Number(job.runCompleted ?? 0), failed = Number(job.runFailed ?? 0);
        const elapsed = job.runStartedAt ? Math.max(0, Math.floor(((job.runFinishedAt ? Date.parse(job.runFinishedAt) : Date.now()) - Date.parse(job.runStartedAt)) / 1000)) : 0;
        return <div key={job.namespace} className="inventory-platform-sync-job">
        <Space wrap>
          <strong>唯品会{job.namespace.includes(":") ? ` · 供应商 ${job.namespace.split(":").at(-1)}` : ""}</strong>
          <Tag color={job.status === "SUCCESS" ? "success" : active(job) ? "processing" : "warning"}>
            {labels[job.status] ?? job.status}
          </Tag>
        </Space>
        {job.runId && job.runStartedAt ? <>
          <p>本轮已处理 {completed.toLocaleString()} / {total.toLocaleString()} 个条码{job.fullRun ? " · 全量核验" : " · 到期或异常条码核验"}</p>
          <Progress aria-label="本轮同步进度" percent={total ? Math.floor(completed / total * 100) : 0}
            status={failed || ["FAILED", "BLOCKED", "PARTIAL"].includes(job.status) ? "exception" : active(job) ? "active" : "normal"}
            success={{ percent: total ? (completed - failed) / total * 100 : 0, strokeColor: "var(--ant-color-primary)" }} />
          <p>成功 {Math.max(0, completed - failed).toLocaleString()} · 异常 {failed.toLocaleString()} · 待处理 {Math.max(0, total - completed).toLocaleString()}</p>
          <p className="muted">{job.runFinishedAt ? "本轮完成" : "本轮开始"}：{when(job.runFinishedAt || job.runStartedAt)} · 用时 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒</p>
        </> : <p className="muted">{active(job) ? "等待后台确定本轮条码范围…" : "暂无本轮核验记录，点击立即同步重新查询。"}</p>}
        <p>最近全量成功：{when(job.lastSuccessAt)}</p>
        <p className="muted">近两小时有效状态 {Number(job.checked).toLocaleString()} / {Number(job.total).toLocaleString()} 个条码（含之前核验记录）</p>
        {job.lastError && <Alert showIcon type="warning" title={`核验未完成：${job.lastError}`} />}
        {!online(job) && <Alert showIcon type="warning" title="后台同步服务超过两分钟未报告状态，请检查 Worker。" />}
      </div>; })}
      <p className="muted">每批最多核验50个条码；耗时取决于条码数量与平台响应。可关闭面板继续工作。只读取状态，不执行上下架或库存修改。</p>
    </Modal>
  </>;
}
