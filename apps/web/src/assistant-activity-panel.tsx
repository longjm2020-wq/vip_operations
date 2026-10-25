import { useState } from "react";
import { Alert, Button, Empty, Segmented, Spin } from "antd";
import {
  ArrowRightOutlined,
  CalendarOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Link } from "react-router-dom";
import {
  activityFingerprint,
  type AssistantActivityFeed,
} from "../../../packages/contracts/src/assistant-activity";

export function AssistantActivityPanel({
  feed,
  loading,
  error,
  seen,
  markSeen,
  refresh,
  onNavigate,
}: {
  feed?: AssistantActivityFeed;
  loading: boolean;
  error: Error | null;
  seen: string[];
  markSeen: (keys: string[]) => void;
  refresh: () => void;
  onNavigate: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const items = feed?.items || [];
  const statuses = {
    upcoming: "即将开始",
    running: "进行中",
    completed: "已结束",
    attention: "需关注",
    info: "动态",
  };
  return (
    <section className="assistant-activity-panel" aria-label="助理动态">
      <div className="assistant-activity-toolbar">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "全部" },
            { value: "schedule", label: "日程" },
            { value: "project", label: "项目" },
            { value: "task", label: "任务" },
          ]}
        />
        <Button
          type="text"
          icon={<ReloadOutlined />}
          aria-label="刷新助理动态"
          onClick={refresh}
          loading={loading}
        />
      </div>
      <p className="assistant-activity-caption">
        站内反馈 · 日程提前 30 分钟提示 · 每 30 秒更新
      </p>
      {error && (
        <Alert
          showIcon
          type="error"
          title="动态读取失败"
          description="已有内容可能已过期，请刷新重试。"
        />
      )}
      {loading && !feed && <Spin />}
      {!loading &&
        !error &&
        !items.filter((item) => filter === "all" || item.kind === filter)
          .length && <Empty description="暂时没有这类动态" />}
      {items
        .filter((item) => filter === "all" || item.kind === filter)
        .map((item) => {
          const fingerprint = activityFingerprint(item),
            unread = !seen.includes(fingerprint);
          return (
            <article
              key={item.id}
              className={`assistant-event${unread ? " is-new" : ""}`}
            >
              <span className="assistant-event-icon" aria-hidden>
                {item.kind === "schedule" ? (
                  <CalendarOutlined />
                ) : item.kind === "project" ? (
                  <TeamOutlined />
                ) : (
                  <ClockCircleOutlined />
                )}
              </span>
              <div className="assistant-event-content">
                <div className="assistant-event-heading">
                  <strong>{item.title}</strong>
                  <span data-status={item.status}>
                    {item.kind === "schedule"
                      ? statuses[item.status]
                      : item.status === "completed"
                        ? "已完成"
                        : statuses[item.status]}
                  </span>
                </div>
                <p>{item.detail}</p>
                {item.progress && item.progress.total > 0 && (
                  <div
                    className="assistant-event-progress"
                    role="progressbar"
                    aria-label={`${item.title}进度`}
                    aria-valuenow={item.progress.done}
                    aria-valuemin={0}
                    aria-valuemax={item.progress.total}
                  >
                    <i
                      style={{
                        width: `${Math.min(100, (item.progress.done / item.progress.total) * 100)}%`,
                      }}
                    />
                  </div>
                )}
                <div className="assistant-event-actions">
                  <time>
                    {new Intl.DateTimeFormat("zh-CN", {
                      timeZone: "Asia/Shanghai",
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    }).format(new Date(item.at))}
                  </time>
                  <Link
                    to={item.href}
                    onClick={() => {
                      markSeen([fingerprint]);
                      onNavigate();
                    }}
                  >
                    查看详情 <ArrowRightOutlined />
                  </Link>
                </div>
              </div>
            </article>
          );
        })}
      {!!items.length && (
        <Button
          block
          type="text"
          icon={<CheckOutlined />}
          onClick={() => markSeen(items.map(activityFingerprint))}
        >
          这些动态我已看过
        </Button>
      )}
      <p className="assistant-activity-caption">
        仅汇集你有权查看的记录。已读标记保存在当前浏览器；查看动态不会调用
        AI，也不会启动、重试或重复发送任务。
      </p>
    </section>
  );
}
