import { useState } from "react";
import { App, Button, Form, Input, Modal, Switch } from "antd";
import {
  CalendarOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
} from "@ant-design/icons";
import {
  workspaceScheduleSchema,
  type WorkspaceSchedule,
} from "../../../packages/contracts/src/personal-workspace";
import "./personal-schedule.css";

export function PersonalSchedule({
  events,
  today,
  busy,
  onChange,
}: {
  events: WorkspaceSchedule[];
  today: string;
  busy: boolean;
  onChange: (events: WorkspaceSchedule[]) => void;
}) {
  const { message } = App.useApp();
  const [selected, setSelected] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [editing, setEditing] = useState<WorkspaceSchedule | null>(null);
  const [allDay, setAllDay] = useState(true);
  const [error, setError] = useState("");
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const count = Math.ceil((offset + days) / 7) * 7;
  const dates = Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(year, monthNumber - 1, index - offset + 1));
    return date.toISOString().slice(0, 10);
  });
  const daily = events
    .filter((event) => event.date === selected)
    .sort(
      (a, b) =>
        a.startTime.localeCompare(b.startTime) ||
        a.title.localeCompare(b.title, "zh-CN"),
    );
  const moveMonth = (direction: number) => {
    setMonth(
      new Date(Date.UTC(year, monthNumber - 1 + direction, 1))
        .toISOString()
        .slice(0, 7),
    );
  };
  const edit = (event?: WorkspaceSchedule) => {
    setEditing(
      event || {
        id: crypto.randomUUID(),
        title: "",
        date: selected,
        startTime: "",
        endTime: "",
        note: "",
      },
    );
    setAllDay(!event?.startTime);
    setError("");
  };
  const apply = () => {
    if (!editing) return;
    const parsed = workspaceScheduleSchema.safeParse(
      allDay ? { ...editing, startTime: "", endTime: "" } : editing,
    );
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    if (!allDay && !parsed.data.startTime) {
      setError("请选择开始时间，或开启全天安排");
      return;
    }
    const exists = events.some((event) => event.id === parsed.data.id);
    if (!exists && events.length >= 500) {
      setError("最多保存500条日程，请先移除不需要的安排");
      return;
    }
    onChange(
      exists
        ? events.map((event) =>
            event.id === parsed.data.id ? parsed.data : event,
          )
        : [...events, parsed.data],
    );
    setSelected(parsed.data.date);
    setMonth(parsed.data.date.slice(0, 7));
    setEditing(null);
    message.info("日程已更新，点击「保存工作台」同步到账号");
  };
  return (
    <section
      className="personal-schedule workspace-panel"
      aria-label="日程面板"
    >
      <header className="workspace-panel-heading">
        <h2>
          <CalendarOutlined aria-hidden /> 日程
        </h2>
        <Button
          type="text"
          size="small"
          onClick={() => {
            setSelected(today);
            setMonth(today.slice(0, 7));
          }}
        >
          今天
        </Button>
      </header>
      <div className="schedule-month">
        <strong aria-live="polite">
          {year} 年 {monthNumber} 月
        </strong>
        <div>
          <Button
            size="small"
            type="text"
            icon={<LeftOutlined />}
            aria-label="日程上个月"
            onClick={() => moveMonth(-1)}
          />
          <Button
            size="small"
            type="text"
            icon={<RightOutlined />}
            aria-label="日程下个月"
            onClick={() => moveMonth(1)}
          />
        </div>
      </div>
      <div className="schedule-weekdays" aria-hidden>
        {["一", "二", "三", "四", "五", "六", "日"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="schedule-days" role="group" aria-label="选择日程日期">
        {dates.map((date) => {
          const scheduled = events.filter(
            (event) => event.date === date,
          ).length;
          return (
            <button
              key={date}
              type="button"
              aria-label={`${date}${scheduled ? `，${scheduled}项日程` : ""}`}
              aria-pressed={date === selected}
              aria-current={date === today ? "date" : undefined}
              className={`${date.startsWith(month) ? "" : "outside "}${selected === date ? "selected " : ""}${date === today ? "today" : ""}`}
              onClick={() => {
                setSelected(date);
                if (!date.startsWith(month)) setMonth(date.slice(0, 7));
              }}
            >
              {Number(date.slice(-2))}
              {scheduled > 0 && <i aria-hidden />}
            </button>
          );
        })}
      </div>
      <div className="schedule-day-heading">
        <span>
          {selected === today
            ? "今天"
            : `${Number(selected.slice(5, 7))}月${Number(selected.slice(8))}日`}
          的安排 <small>{daily.length}</small>
        </span>
        <Button
          type="text"
          size="small"
          icon={<PlusOutlined />}
          aria-label="新增日程"
          disabled={busy || events.length >= 500}
          onClick={() => edit()}
        />
      </div>
      <div className="schedule-agenda" aria-live="polite">
        {daily.map((event) => (
          <button
            key={event.id}
            type="button"
            className="schedule-event"
            disabled={busy}
            onClick={() => edit(event)}
            aria-label={`编辑日程 ${event.title}`}
          >
            <span className="schedule-event-time">
              {event.startTime || "全天"}
              {event.endTime && <small>{event.endTime}</small>}
            </span>
            <span>
              <strong>{event.title}</strong>
              {event.note && <small>{event.note}</small>}
            </span>
          </button>
        ))}
        {!daily.length && (
          <div className="schedule-empty">
            <span>这一天还没有安排</span>
            <Button
              type="link"
              disabled={busy || events.length >= 500}
              onClick={() => edit()}
            >
              添加日程
            </Button>
          </div>
        )}
      </div>
      <div className="schedule-timezone">北京时间 · 仅自己可见</div>
      <Modal
        title={
          events.some((event) => event.id === editing?.id)
            ? "编辑日程"
            : "新增日程"
        }
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={apply}
        okText="应用日程"
        cancelText="取消"
        className="workspace-schedule-modal"
        destroyOnHidden
      >
        {editing && (
          <Form layout="vertical" className="schedule-form">
            <Form.Item label="日程名称" required>
              <Input
                autoFocus
                aria-label="日程名称"
                maxLength={160}
                value={editing.title}
                placeholder="例如：秋冬选款评审"
                onChange={(e) =>
                  setEditing({ ...editing, title: e.target.value })
                }
              />
            </Form.Item>
            <Form.Item label="日程日期" required>
              <Input
                type="date"
                aria-label="日程日期"
                value={editing.date}
                onChange={(e) =>
                  setEditing({ ...editing, date: e.target.value })
                }
              />
            </Form.Item>
            <Form.Item label="全天安排">
              <Switch
                aria-label="全天安排"
                checked={allDay}
                onChange={setAllDay}
              />
            </Form.Item>
            {!allDay && (
              <div className="schedule-times">
                <Form.Item label="开始时间" required>
                  <Input
                    type="time"
                    aria-label="日程开始时间"
                    value={editing.startTime}
                    onChange={(e) =>
                      setEditing({ ...editing, startTime: e.target.value })
                    }
                  />
                </Form.Item>
                <Form.Item label="结束时间">
                  <Input
                    type="time"
                    aria-label="日程结束时间"
                    value={editing.endTime}
                    onChange={(e) =>
                      setEditing({ ...editing, endTime: e.target.value })
                    }
                  />
                </Form.Item>
              </div>
            )}
            <Form.Item label="备注">
              <Input.TextArea
                aria-label="日程备注"
                value={editing.note}
                maxLength={1000}
                rows={3}
                onChange={(e) =>
                  setEditing({ ...editing, note: e.target.value })
                }
              />
            </Form.Item>
            {error && (
              <p role="alert" className="schedule-error">
                {error}
              </p>
            )}
            <p className="schedule-save-note">
              应用后，点击「保存工作台」保存到账号。日程不发送通知或邀请。
            </p>
            {events.some((event) => event.id === editing.id) && (
              <Button
                danger
                onClick={() => {
                  onChange(events.filter((event) => event.id !== editing.id));
                  setEditing(null);
                  message.info("日程已移除，保存工作台后生效");
                }}
              >
                删除日程
              </Button>
            )}
          </Form>
        )}
      </Modal>
    </section>
  );
}
