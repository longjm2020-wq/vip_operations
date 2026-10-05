import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Form,
  Modal,
  Progress,
  Select,
  Space,
  Switch,
  Tag,
} from "antd";
import { api } from "./api";
import { when } from "./shared";
import type { CompetitorBrand } from "../../../packages/contracts/src/competitor-analysis";
import { competitorCrawlProgress } from "../../../packages/contracts/src/competitor-crawl-progress";
import { CompetitorBrowserLogin } from "./competitor-browser-login";

export type CompetitorCrawlStatus = {
  settings: { enabled: boolean; dailyHour: number; version: number };
  jobs: {
    id: string;
    brandId: string;
    status: string;
    requestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    capturedCount: number;
    detailCount: number;
    note: string;
  }[];
};
const labels: Record<string, [string, string]> = {
  QUEUED: ["待采集", "default"],
  RUNNING: ["采集中", "processing"],
  READY: ["已完成", "success"],
  PARTIAL: ["部分完成", "warning"],
  FAILED: ["未完成", "error"],
  VERIFICATION_REQUIRED: ["需要验证", "warning"],
  LOGIN_REQUIRED: ["需要登录", "warning"],
};
export function CompetitorCrawlPanel({
  data,
  brands,
  open,
  manage,
  onClose,
  onRefresh,
  onCapture,
  localLoginSource,
}: {
  data?: CompetitorCrawlStatus;
  brands: CompetitorBrand[];
  open: boolean;
  manage: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onCapture: () => void;
  localLoginSource?: string;
}) {
  const [enabled, setEnabled] = useState(true),
    [hour, setHour] = useState(8),
    [version, setVersion] = useState(1),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const { message } = App.useApp();
  useEffect(() => {
    if (open && data) {
      setEnabled(data.settings.enabled);
      setHour(data.settings.dailyHour);
      setVersion(data.settings.version);
      setError("");
    }
  }, [open]);
  async function save() {
    setSaving(true);
    setError("");
    try {
      await api("/analytics/competitors/crawl-settings", "POST", {
        enabled,
        dailyHour: hour,
        version,
      });
      message.success("采集设置已保存");
      onRefresh();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      onRefresh();
    } finally {
      setSaving(false);
    }
  }
  if (!data) return null;
  const active = data.jobs.filter((j) =>
    ["QUEUED", "RUNNING"].includes(j.status),
  ).length;
  const rows = brands.map((b) => ({
    brand: b,
    job: data.jobs.find((j) => j.brandId === b.id),
  }));
  return (
    <>
      <div className="competitor-crawl-line">
        <span>
          <i className={data.settings.enabled ? "enabled" : ""} />
          {data.settings.enabled
            ? `后台自动采集 · 每天 ${String(data.settings.dailyHour).padStart(2, "0")}:00`
            : "后台自动采集已暂停"}
        </span>
        {!!active && <Tag color="processing">{active} 个品牌待更新</Tag>}
        <details className="competitor-crawl-status">
          <summary>采集状态</summary>
          <div className="competitor-crawl-jobs">
            {rows.map(({ brand, job }) => {
              const [label, color] = labels[job?.status || ""] || [
                "待首次采集",
                "default",
              ];
              const progress = competitorCrawlProgress(job);
              const strokeColor =
                job?.status === "FAILED"
                  ? "#ff4d4f"
                  : job?.status === "READY"
                    ? "#527761"
                    : "#f47b38";
              return (
                <div className="competitor-crawl-job" key={brand.id}>
                  <strong>{brand.name}</strong>
                  <Tag color={color}>{label}</Tag>
                  <div className="competitor-crawl-progress">
                    <Progress
                      aria-label={`${brand.name}采集进度`}
                      aria-valuetext={
                        progress.captured
                          ? `榜单 ${progress.captured} 款，详情 ${progress.details} / ${progress.captured} 款`
                          : "尚未取得榜单，目标最多50款"
                      }
                      percent={progress.percent}
                      size="small"
                      showInfo={false}
                      strokeColor={strokeColor}
                      status={job?.status === "RUNNING" ? "active" : "normal"}
                    />
                    <span className="competitor-crawl-counts">
                      {progress.captured
                        ? `榜单 ${progress.captured} 款 · 详情 ${progress.details} / ${progress.captured} 款`
                        : "榜单 0 / 50 款 · 详情待开始"}
                      <b>{progress.percent}%</b>
                    </span>
                  </div>
                  {job && (
                    <small>
                      {when(
                        job.completedAt || job.startedAt || job.requestedAt,
                      )}
                    </small>
                  )}
                  {job?.note && <p>{job.note}</p>}
                </div>
              );
            })}
          </div>
        </details>
      </div>
      <Modal
        title="后台采集设置"
        open={open}
        onCancel={() => !saving && onClose()}
        onOk={() => void save()}
        confirmLoading={saving}
        okText="保存设置"
        destroyOnHidden
      >
        <p>
          在后台更新所有已添加品牌的公开销量排名、特卖价及规格参数，完成后自动更新对比数据。
        </p>
        <Form layout="vertical">
          <Form.Item label="自动采集">
            <Switch
              aria-label="自动采集"
              checked={enabled}
              disabled={!manage || saving}
              onChange={setEnabled}
            />
          </Form.Item>
          <Form.Item label="每天采集时间（北京时间）">
            <Select
              aria-label="每天采集时间"
              value={hour}
              disabled={!manage || saving}
              onChange={setHour}
              options={Array.from({ length: 24 }, (_, i) => ({
                value: i,
                label: `${String(i).padStart(2, "0")}:00`,
              }))}
            />
          </Form.Item>
        </Form>
        <Alert
          type="info"
          showIcon
          title="采集失败保留已有数据"
          description="云端扫码并核验后，后台复用加密保存的会话，无需保持电脑或 Codex 在线。新品牌会进入首次采集；已有品牌每天更新一次。暂停后，正在执行的任务会继续完成。平台要求登录或验证时，请打开云端登录处理后核验。"
        />
        <Space style={{ marginTop: 16 }}>
          <Button
            onClick={() => {
              onClose();
              onCapture();
            }}
          >
            浏览器补充数据
          </Button>
        </Space>
        {localLoginSource && (
          <div style={{ marginTop: 12 }}>
            <CompetitorBrowserLogin sourceUrl={localLoginSource} />
          </div>
        )}
        {error && (
          <Alert
            type="error"
            showIcon
            title={error}
            style={{ marginTop: 12 }}
          />
        )}
      </Modal>
    </>
  );
}
