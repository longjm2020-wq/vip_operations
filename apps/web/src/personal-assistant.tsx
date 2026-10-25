import { useEffect, useRef, useState } from "react";
import { Bubble, Sender } from "@ant-design/x";
import {
  App,
  Alert,
  Button,
  Checkbox,
  Drawer,
  Popconfirm,
  Spin,
  Tag,
} from "antd";
import {
  ArrowRightOutlined,
  CalendarOutlined,
  CommentOutlined,
  DeleteOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "./api";
import { useUser, type Row } from "./shared";
import {
  canUsePersonalAssistant,
  type AssistantConversation,
} from "../../../packages/contracts/src/personal-assistant";
import type { WorkspaceSchedule } from "../../../packages/contracts/src/personal-workspace";
import "./personal-assistant.css";

export function PersonalAssistant({
  available,
  schedule,
  onSchedule,
}: {
  available: Row[];
  schedule: WorkspaceSchedule[];
  onSchedule: (event: WorkspaceSchedule) => void;
}) {
  const user = useUser(),
    { message } = App.useApp();
  const allowed = canUsePersonalAssistant({ permissions: user.permissions });
  const [open, setOpen] = useState(false),
    [text, setText] = useState("");
  const [includeContext, setIncludeContext] = useState(false),
    [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ["personal-assistant", user.id],
    queryFn: () => api("/my-workspace/assistant"),
    enabled: allowed,
    refetchInterval: (query) =>
      sending || query.state.data?.data?.state === "PENDING" ? 3000 : false,
  });
  const data = q.data?.data as AssistantConversation | undefined;
  const busy = sending || data?.state === "PENDING";
  const messages = data?.messages || [];
  useEffect(() => {
    if (open) bottom.current?.scrollIntoView({ block: "end" });
  }, [open, messages.length, busy]);
  const send = async (value: string) => {
    if (!value.trim() || !data?.ready || busy) return;
    setOpen(true);
    setSending(true);
    setError("");
    try {
      await api("/my-workspace/assistant", "POST", {
        message: value.trim(),
        version: data.version,
        requestId: crypto.randomUUID(),
        includePersonalContext: includeContext,
      });
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
      await q.refetch();
    }
  };
  if (!allowed) return null;
  const sender = (inDrawer = false) => (
    <div className="assistant-compose">
      <Sender
        value={text}
        onChange={(value) => setText(value.slice(0, 4000))}
        onSubmit={(value) => void send(value)}
        loading={busy}
        readOnly={busy}
        disabled={!data?.ready || busy}
        submitType="enter"
        suffix={(_, { components }) =>
          busy ? (
            <Button loading disabled shape="circle" aria-label="助理正在回复" />
          ) : (
            <components.SendButton aria-label="发送给个人助理" />
          )
        }
        placeholder={
          data?.ready
            ? "告诉我你想完成什么，例如：安排明天下午3点选款会…"
            : q.isLoading
              ? "正在连接个人助理…"
              : "AI 尚未就绪，点击打开助理查看原因"
        }
        autoSize={{ minRows: inDrawer ? 2 : 1, maxRows: 5 }}
      />
      <div className="assistant-compose-meta">
        <Checkbox
          checked={includeContext}
          onChange={(e) => setIncludeContext(e.target.checked)}
          disabled={busy}
        >
          附带已保存日程与待办
        </Checkbox>
        {!inDrawer && (
          <Button
            type="text"
            size="small"
            icon={<CommentOutlined />}
            aria-label="打开个人助理"
            onClick={() => setOpen(true)}
          >
            打开个人助理
          </Button>
        )}
      </div>
    </div>
  );
  return (
    <>
      {sender()}
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={
          <span>
            <CommentOutlined /> AI 个人助理
          </span>
        }
        size={620}
        rootClassName="personal-assistant-drawer"
        extra={
          <Popconfirm
            title="清空当前账号的助理对话？"
            description="日程、待办和备忘不受影响。"
            okText="清空"
            cancelText="取消"
            onConfirm={async () => {
              try {
                await api("/my-workspace/assistant/clear", "POST", {
                  version: data?.version || 0,
                });
                await q.refetch();
                setError("");
              } catch (e) {
                message.error((e as Error).message);
              }
            }}
          >
            <Button
              type="text"
              icon={<DeleteOutlined />}
              aria-label="清空助理对话"
              disabled={busy || !messages.length}
            />
          </Popconfirm>
        }
        footer={
          <>
            {sender(true)}
            <p className="assistant-privacy">
              发送内容及最近对话将交给已配置的 AI
              服务。勾选后附带已保存日程与待办，私有备忘不发送。Enter 发送 ·
              Shift+Enter 换行
            </p>
          </>
        }
      >
        <div className="assistant-status">
          <Tag>{data?.ready ? "已连接" : "未就绪"}</Tag>
          <span>{data?.model || "读取模型状态"}</span>
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            aria-label="刷新助理状态"
            onClick={() => void q.refetch()}
            loading={q.isFetching}
          />
        </div>
        {q.isLoading && <Spin />}
        {q.error && <Alert type="error" title={(q.error as Error).message} />}
        {!q.isLoading && data && !data.ready && (
          <Alert
            type="warning"
            title={data.availabilityMessage || "请管理员启用并验证 AI 模型连接"}
          />
        )}
        {!messages.length && (
          <div className="assistant-empty">
            <span className="assistant-spark" aria-hidden>
              ✦
            </span>
            <h3>你的工作，从一句话开始。</h3>
            <p>安排日程、拆解任务、拟写文案，或找到需要的工具。</p>
            {[
              "帮我安排明天下午3点的选款会",
              "帮我拆解新品上架前的准备工作",
              "我应该在哪里核对库存？",
            ].map((prompt) => (
              <button
                type="button"
                key={prompt}
                onClick={() => setText(prompt)}
                disabled={busy}
              >
                {prompt}
                <ArrowRightOutlined />
              </button>
            ))}
          </div>
        )}
        <div className="assistant-messages" aria-label="助理对话记录">
          {messages.map((item) => (
            <div
              key={item.id}
              className={`assistant-message assistant-message-${item.role}`}
            >
              <Bubble
                placement={item.role === "user" ? "end" : "start"}
                variant={item.role === "user" ? "filled" : "borderless"}
                header={item.role === "user" ? "你" : "AI 个人助理"}
                content={
                  <div className="assistant-message-text">{item.text}</div>
                }
              />
              {!!item.schedules?.length && (
                <div className="assistant-schedule-proposals">
                  {item.schedules.map((event) => {
                    const added = schedule.some(
                      (existing) => existing.id === event.id,
                    );
                    return (
                      <div
                        key={event.id}
                        className="assistant-schedule-proposal"
                      >
                        <span>
                          <CalendarOutlined /> 待确认日程
                        </span>
                        <strong>{event.title}</strong>
                        <p>
                          {event.date} · {event.startTime || "全天"}
                          {event.endTime ? `–${event.endTime}` : ""}
                        </p>
                        {event.note && <p>{event.note}</p>}
                        <Button
                          size="small"
                          disabled={added || schedule.length >= 500}
                          onClick={() => {
                            onSchedule(event);
                            message.info("已加入日程草稿，请核对并保存工作台");
                          }}
                        >
                          {added ? "已加入日程草稿" : "加入日程草稿"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
              {!!item.tools?.length && (
                <div className="assistant-tool-links">
                  {item.tools.map((id) => {
                    const tool = available.find((entry) => entry.id === id);
                    return tool ? (
                      <Link key={id} to={tool.path}>
                        {tool.title}
                        <ArrowRightOutlined />
                      </Link>
                    ) : null;
                  })}
                </div>
              )}
              {item.responseModel && (
                <small className="assistant-response-model">
                  实际返回：{item.responseModel}
                </small>
              )}
            </div>
          ))}
          {busy && (
            <Bubble
              loading
              content=""
              header="助理正在回复…"
              variant="borderless"
            />
          )}
          {(error || data?.error) && (
            <Alert type="error" title={error || data?.error} showIcon />
          )}
          <div ref={bottom} />
        </div>
      </Drawer>
    </>
  );
}
