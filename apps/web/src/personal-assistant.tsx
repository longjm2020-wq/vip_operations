import { useEffect, useRef } from "react";
import { App } from "antd";
import { useAssistantHub } from "./assistant-hub-context";
import type { Row } from "./shared";
import type { WorkspaceSchedule } from "../../../packages/contracts/src/personal-workspace";

export function PersonalAssistant({
  schedule,
  onSchedule,
}: {
  available: Row[];
  schedule: WorkspaceSchedule[];
  onSchedule: (event: WorkspaceSchedule) => void;
}) {
  const hub = useAssistantHub(),
    { message } = App.useApp();
  const processed = useRef<string | null>(null);
  const pending = hub.pendingSchedules[0];
  useEffect(() => {
    hub.setDraftSchedule(schedule);
  }, [schedule, hub.setDraftSchedule]);
  useEffect(() => () => hub.setDraftSchedule(null), [hub.setDraftSchedule]);
  useEffect(() => {
    if (!pending || processed.current === pending.id) return;
    processed.current = pending.id;
    if (!schedule.some((event) => event.id === pending.id)) {
      if (schedule.length >= 500) message.error("日程已达 500 项，请先清理后再添加");
      else {
        onSchedule(pending);
        message.info("已加入日程草稿，请核对并保存工作台");
      }
    }
    hub.consumeSchedule(pending.id);
  }, [pending, schedule, onSchedule, hub, message]);
  return hub.allowed ? hub.compose() : null;
}
