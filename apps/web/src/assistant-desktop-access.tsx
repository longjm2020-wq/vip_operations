import { useEffect, useState } from "react";
import { App, Button, Popover, Select } from "antd";
import { DownOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import type { DesktopState } from "../../../packages/contracts/src/assistant-desktop";
import { api } from "./api";
import { desktopClientRequest, isDesktopClient } from "./desktop-client";

export function AssistantDesktopAccess({
  data,
  deviceId,
  choose,
  manage,
  refresh,
  disabled,
  active,
}: {
  data?: DesktopState;
  deviceId?: string;
  choose: (id?: string) => void;
  manage: () => void;
  refresh: () => void;
  disabled: boolean;
  active: boolean;
}) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const device = data?.devices?.find((d) => d.id === deviceId);
  const label = !deviceId
    ? "网站内"
    : !device
      ? "连接失效"
      : !device.online
        ? "电脑离线"
        : device.crossWindowAuthorized
          ? "跨窗口授权"
          : "逐次允许";
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  async function manageAuthorization() {
    setOpen(false);
    if (isDesktopClient()) {
      try {
        const local = await desktopClientRequest("status");
        if (deviceId && local.connected && local.deviceId === deviceId) {
          await desktopClientRequest("show-tasks");
          return;
        }
      } catch (e) {
        message.error((e as Error).message);
      }
    }
    manage();
  }
  async function revoke() {
    if (!device || pending) return;
    setPending(true);
    try {
      await api(
        `/my-workspace/assistant/desktop/devices/${device.id}/authorization/revoke`,
        "POST",
      );
      refresh();
      message.success("跨窗口授权已撤销，当前电脑任务已暂停");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <Popover
      trigger="click"
      placement="topLeft"
      arrow={false}
      title="执行位置与电脑授权"
      open={open && active}
      onOpenChange={setOpen}
      content={
        <div className="assistant-access-menu">
          <Select
            aria-label="执行位置"
            value={deviceId || "website"}
            disabled={disabled || pending}
            options={[
              { value: "website", label: "网站内" },
              ...(data?.devices || []).map((d) => ({
                value: d.id,
                label: d.name + (d.online ? "" : " · 离线"),
                disabled: !d.online,
              })),
            ]}
            onChange={(id) => choose(id === "website" ? undefined : id)}
          />
          <p role="status">
            {!deviceId
              ? "使用当前账号已获准的网站功能。选择在线电脑后，可发送电脑任务。"
              : !device
                ? "设备连接已失效，请重新连接或选择其他执行位置。"
                : device.crossWindowAuthorized
                  ? "已记住此设备授权，可在已打开的普通应用和网页间切换；新任务自动开始。"
                  : "逐次允许：在对应电脑的桌面端选择窗口并允许本次任务。"}
          </p>
          {device && !device.online && (
            <p>电脑当前离线，请打开小序桌面端并恢复连接。</p>
          )}
          <p>
            记住设备授权需在对应电脑的「电脑任务 →
            授权跨窗口操作」中确认。登录、付款等仍由你接手。
          </p>
          <Button
            block
            type="primary"
            disabled={pending}
            onClick={() => void manageAuthorization()}
          >
            {deviceId ? "管理电脑授权" : "连接电脑 / 管理授权"}
          </Button>
          {device?.crossWindowAuthorized && (
            <Button
              block
              danger
              type="text"
              loading={pending}
              onClick={() => void revoke()}
            >
              撤销跨窗口授权
            </Button>
          )}
          <Button
            block
            type="text"
            onClick={() => {
              setOpen(false);
              manage();
            }}
          >
            查看电脑任务进度
          </Button>
        </div>
      }
    >
      <Button
        type="text"
        size="small"
        className="assistant-access-trigger"
        data-authorized={
          device?.crossWindowAuthorized && device.online ? "true" : undefined
        }
        aria-label={`电脑授权：${label}`}
        disabled={disabled || !active}
        icon={<SafetyCertificateOutlined />}
      >
        {label}
        <DownOutlined />
      </Button>
    </Popover>
  );
}
