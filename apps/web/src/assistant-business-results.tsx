import { Button, Tag } from "antd";
import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { Link } from "react-router-dom";
import type {
  AssistantAction,
  AssistantMessage,
} from "../../../packages/contracts/src/personal-assistant";
import type { AssistantActivityFeed } from "../../../packages/contracts/src/assistant-activity";

const stateLabels: Record<AssistantAction["status"], string> = {
  PROPOSED: "待执行",
  SUBMITTING: "提交中",
  SUBMITTED: "已提交",
  FAILED: "未成功",
  EXPIRED: "已过期",
  CANCELED: "已取消",
};
export function AssistantBusinessResults({
  item,
  feed,
  executing,
  execute,
  remember,
}: {
  item: AssistantMessage;
  feed?: AssistantActivityFeed;
  executing: string | null;
  execute: (action: AssistantAction) => void;
  remember: (value: { title: string; content: string }) => void;
}) {
  return (
    <>
      {item.evidence?.map((evidence) => (
        <details
          key={evidence.id}
          className="assistant-evidence"
          open={!evidence.ok}
        >
          <summary>
            <CheckCircleOutlined /> {evidence.title}
            <Tag>{evidence.ok ? "已查询" : "未完成"}</Tag>
          </summary>
          <p>{evidence.summary}</p>
          {evidence.rows?.map((row, index) => (
            <div className="assistant-evidence-row" key={index}>
              <strong>
                {row.href ? <Link to={row.href}>{row.label}</Link> : row.label}
              </strong>
              <span>{row.value}</span>
            </div>
          ))}
          <small>
            查询于{" "}
            {new Date(evidence.at).toLocaleString("zh-CN", {
              timeZone: "Asia/Shanghai",
              hour12: false,
            })}
          </small>
          {evidence.href && (
            <Link to={evidence.href}>
              查看明细 <ArrowRightOutlined />
            </Link>
          )}
        </details>
      ))}
      {item.actions?.map((action) => {
        const event = feed?.items.find(
          (entry) => entry.id === `${action.kind}:${action.jobId}`,
        );
        const terminal = ["SUBMITTED", "EXPIRED", "CANCELED"].includes(
          action.status,
        );
        return (
          <article
            className="assistant-action"
            key={action.id}
            aria-label={action.title + "操作"}
          >
            <div>
              <strong>{action.title}</strong>
              <Tag>
                {event?.status === "completed"
                  ? "已完成"
                  : event?.status === "running"
                    ? "执行中"
                    : event?.status === "attention"
                      ? "需要关注"
                      : stateLabels[action.status]}
              </Tag>
            </div>
            <p role="status">{event?.detail || action.note}</p>
            {!terminal && (
              <Button
                type="primary"
                size="small"
                icon={<ReloadOutlined />}
                loading={executing === action.id}
                disabled={!!executing || action.canExecute === false}
                onClick={() => execute(action)}
              >
                {action.status === "SUBMITTING"
                  ? "核对提交结果"
                  : action.status === "FAILED"
                    ? "重试提交"
                    : "开始执行"}
              </Button>
            )}
            {action.canExecute === false && !terminal && (
              <small>当前账号没有执行权限</small>
            )}
            <Link to={action.href}>
              查看任务 <ArrowRightOutlined />
            </Link>
          </article>
        );
      })}
      {item.memorySuggestions?.map((entry, index) => (
        <article className="assistant-memory-entry" key={index}>
          <Tag>待保存记忆</Tag>
          <strong>{entry.title}</strong>
          <p>{entry.content}</p>
          <Button size="small" onClick={() => remember(entry)}>
            核对并记住
          </Button>
        </article>
      ))}
    </>
  );
}
