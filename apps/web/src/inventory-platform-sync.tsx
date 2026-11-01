import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Modal, Space, Tag, Tooltip } from "antd";
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
  const pending = useRef(new Map<string, string | undefined>());
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
      if (active(job)) { running.current.add(job.namespace); continue; }
      const requested = pending.current.has(job.namespace);
      // A POST acknowledges scheduling only. Never treat the previous SUCCESS
      // snapshot as completion of the newly requested run.
      if (job.status === "SUCCESS" && requested &&
          job.lastSuccessAt === pending.current.get(job.namespace)) continue;
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
        await api("/integrations/vip/listing/sync", "POST", { namespace: job.namespace });
        pending.current.set(job.namespace, job.lastSuccessAt);
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
      <Button aria-label="同步平台状态" icon={<SyncOutlined spin={watching} aria-hidden />} disabled={!can}
        onClick={() => setOpen(true)}>同步平台状态</Button>
    </Tooltip>
    <Modal title="唯品会平台状态同步" open={open} onCancel={() => setOpen(false)}
      footer={<Space>
        <Button onClick={() => setOpen(false)}>关闭</Button>
        <Button type="primary" loading={submitting}
          disabled={watching || overview.isFetching || !!overview.error || !jobs.some((job) => online(job) && !active(job))}
          onClick={() => void sync()}>立即同步</Button>
      </Space>}>
      <p>核验已采集商品的条码与款号上下架状态。同步完成后自动刷新明细与状态数量。</p>
      {(overview.error || requestError) && <Alert showIcon type="error"
        title={requestError || (overview.error as Error).message}
        action={<Button size="small" onClick={() => void overview.refetch()}>重试读取</Button>} />}
      {overview.isLoading && <p>正在读取同步状态…</p>}
      {!overview.isLoading && !overview.error && !jobs.length && <Alert showIcon type="warning" title="尚未配置唯品会平台状态采集连接，请在唯品会接入中检查配置。" />}
      {jobs.map((job) => <div key={job.namespace} className="inventory-platform-sync-job">
        <Space wrap>
          <strong>{job.namespace}</strong>
          <Tag color={job.status === "SUCCESS" ? "success" : active(job) ? "processing" : "warning"}>
            {labels[job.status] ?? job.status}
          </Tag>
        </Space>
        <p>有效状态 {Number(job.checked).toLocaleString()} / {Number(job.total).toLocaleString()} 个条码 · 待处理 {Number(job.unresolved).toLocaleString()} 个</p>
        <p>最近完整核验：{when(job.lastSuccessAt)}</p>
        {job.lastError && <Alert showIcon type="warning" title={`核验未完成：${job.lastError}`} />}
        {!online(job) && <Alert showIcon type="warning" title="后台同步服务超过两分钟未报告状态，请检查 Worker。" />}
      </div>)}
      <p className="muted">有效状态统计最近两小时成功核验的条码，不表示本次任务的完成比例。只读取平台状态，不执行上架、下架或库存修改。</p>
    </Modal>
  </>;
}
