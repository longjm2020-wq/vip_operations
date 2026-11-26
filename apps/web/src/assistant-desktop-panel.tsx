import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Alert, App, Button, Space, Tag, Typography } from "antd";
import {
  DownloadOutlined,
  DesktopOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { api } from "./api";
import {
  desktopClientRequest,
  isDesktopClient,
  type DesktopClientState,
} from "./desktop-client";
import { desktopReceiverProblem } from "./desktop-setup";
import type { DesktopState } from "../../../packages/contracts/src/assistant-desktop";
import { AssistantDesktopTaskCard } from "./assistant-desktop-task-card";

export function AssistantDesktopPanel({
  collapseTools,
  open,
  data,
  client,
  clientError,
  error,
  refresh,
  choose,
  compose,
  connectLocal,
  connecting = false,
  disabled = false,
  setupNote = "",
  selectedId,
  preferredId,
  automatic = false,
}: {
  collapseTools?: ReactNode;
  open: boolean;
  data?: DesktopState;
  client?: DesktopClientState;
  clientError?: string;
  error: string;
  refresh: () => Promise<unknown>;
  choose: (id: string) => void;
  compose: () => void;
  connectLocal: () => void;
  connecting?: boolean;
  disabled?: boolean;
  setupNote?: string;
  selectedId?: string;
  preferredId?: string;
  automatic?: boolean;
}) {
  const { message } = App.useApp();
  const panelRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const scroller = panelRef.current?.closest<HTMLElement>(
      ".workspace-tool-panels, .ant-drawer-body",
    );
    if (scroller) scroller.scrollTop = 0;
  }, [open]);
  const [pair, setPair] = useState<{ code: string; expiresAt: string } | null>(
    null,
  );
  const [busy, setBusy] = useState("");
  const native = isDesktopClient();
  const localId = client?.connected ? client.deviceId : undefined;
  const local = data?.devices.find((d) => d.id === localId);
  const selected = data?.devices.find((d) => d.id === selectedId);
  const problem =
    clientError ||
    (local ? desktopReceiverProblem(local, client) : client?.engineError);
  const localAuthorized =
    local?.crossWindowAuthorized && client?.authorized === true;
  const composingOnLocal = !!localAuthorized && selectedId === localId;
  const showComposer =
    !!selected &&
    !desktopReceiverProblem(selected, client) &&
    (native ? composingOnLocal && !problem : true);
  async function run(key: string, fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
      await refresh();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="assistant-desktop-panel" ref={panelRef}>
      <div className="assistant-desktop-heading">
        <h3>
          <DesktopOutlined /> 我的电脑
        </h3>
        <Space>
          <Button size="small" icon={<ReloadOutlined />} onClick={refresh}>
            刷新
          </Button>
          {collapseTools}
        </Space>
      </div>
      <p>
        {automatic
          ? "在小序输入框发送「在我的电脑上切换到已打开的记事本窗口」。任务进度会显示在对话里。"
          : "使用你自己的 Windows 电脑操作网页和应用。首次连接确认一次，之后可直接下达指令。"}
      </p>
      {(native || !data?.devices.length) && (
        <Alert
          type={problem ? "warning" : "info"}
          showIcon
          title={
            native
              ? problem
                ? "本机暂时无法接收任务"
                : localAuthorized
                  ? "本机已连接并记住授权"
                  : local
                    ? "本机已连接，尚未授权"
                    : "连接本机"
              : "使用小序桌面端"
          }
          description={
            native
              ? problem ||
                (localAuthorized
                  ? composingOnLocal
                    ? "可直接在小序输入框下达本机指令。"
                    : "点击「使用我的电脑」将本机选为执行设备。"
                  : "点击下方按钮，在本机弹窗确认后即可使用。授权会记住，可随时撤销。")
              : "下载并解压桌面端，打开 XutiDesktop.exe，登录后在「我的电脑」中点击「使用我的电脑」。只需首次确认，之后可从网页或桌面端下达指令。"
          }
        />
      )}
      <Space wrap style={{ margin: "16px 0" }}>
        {showComposer && (
          <Button
            type="primary"
            disabled={!!busy || disabled}
            onClick={compose}
          >
            下达指令
          </Button>
        )}
        {native && (
          <>
            {!showComposer && (!localAuthorized || !composingOnLocal) && (
              <Button
                loading={connecting}
                disabled={!!busy || disabled || client?.engineReady === false}
                onClick={connectLocal}
              >
                使用我的电脑
              </Button>
            )}
            <Button
              onClick={() =>
                void run("native-tasks", () =>
                  desktopClientRequest("show-tasks"),
                )
              }
              disabled={!!busy}
            >
              打开电脑任务
            </Button>
          </>
        )}
        {!native && !data?.devices.length && (
          <Button
            href="/downloads/xuti-desktop.zip"
            download
            icon={<DownloadOutlined />}
          >
            下载 Windows 桌面端
          </Button>
        )}
      </Space>
      {setupNote && <Alert type="info" showIcon title={setupNote} />}
      <details>
        <summary>其他连接方式与客户端更新</summary>
        <Button
          href="/downloads/xuti-desktop.zip"
          download
          icon={<DownloadOutlined />}
        >
          下载新版桌面端
        </Button>
        <Button
          loading={busy === "pair"}
          disabled={!!busy || disabled}
          onClick={() =>
            void run("pair", async () =>
              setPair(
                (await api("/my-workspace/assistant/desktop/pair-code", "POST"))
                  .data,
              ),
            )
          }
        >
          生成配对码
        </Button>
        {pair && (
          <Alert
            showIcon
            type="info"
            title="仅粘贴到小序桌面端的电脑任务面板，10分钟内有效"
            description={
              <>
                <Typography.Text copyable={{ text: pair.code }} code>
                  {pair.code}
                </Typography.Text>
                <div>
                  有效至 {new Date(pair.expiresAt).toLocaleTimeString()}
                </div>
              </>
            }
          />
        )}
      </details>
      {error && <Alert type="error" title={error} />}
      {!!data?.devices.length && <h4>选择我的电脑</h4>}
      {data?.devices.map((d) => (
        <div className="assistant-desktop-item" key={d.id}>
          <strong>{d.name}</strong>
          <Tag color={d.online ? "processing" : undefined}>
            {!d.online
              ? "离线"
              : d.engineReady === false ||
                  (d.id === localId && client?.engineReady === false)
                ? "在线 · 未接收任务"
                : d.engineReady === true
                  ? "在线 · 可接收任务"
                  : "在线 · 接单待确认"}
          </Tag>
          <Tag color={d.crossWindowAuthorized ? "blue" : undefined}>
            {d.crossWindowAuthorized ? "已记住跨窗口授权" : "逐次允许"}
          </Tag>
          {selectedId === d.id && (
            <Tag color="blue">
              {automatic && preferredId === d.id ? "常用电脑" : "当前执行电脑"}
            </Tag>
          )}
          {(selectedId !== d.id || (automatic && preferredId !== d.id)) && (
            <Space>
              <Button
                size="small"
                disabled={
                  !!desktopReceiverProblem(d, client) || !!busy || disabled
                }
                onClick={() => choose(d.id)}
              >
                {automatic ? "设为常用电脑" : "在这台电脑执行"}
              </Button>
            </Space>
          )}
          <details className="assistant-desktop-management">
            <summary>管理连接与授权</summary>
            <Space wrap>
              <Button
                size="small"
                disabled={!!busy || connecting}
                onClick={() =>
                  void run(d.id, async () => {
                    await api(
                      `/my-workspace/assistant/desktop/devices/${d.id}/revoke`,
                      "POST",
                    );
                  })
                }
              >
                断开
              </Button>
              {d.crossWindowAuthorized && (
                <Button
                  size="small"
                  disabled={!!busy || connecting}
                  onClick={() =>
                    void run(`authorization-${d.id}`, async () => {
                      await api(
                        `/my-workspace/assistant/desktop/devices/${d.id}/authorization/revoke`,
                        "POST",
                      );
                      message.success("跨窗口授权已撤销，当前电脑任务已暂停");
                    })
                  }
                >
                  撤销跨窗口授权
                </Button>
              )}
            </Space>
          </details>
        </div>
      ))}
      {data && (data.devices.length > 0 || data.tasks.length > 0) && (
        <details className="assistant-desktop-task-list">
          <summary>操作任务</summary>
          {data.tasks.length === 0 && <p>暂无电脑任务</p>}
          {data.tasks.map((task) => (
            <AssistantDesktopTaskCard
              key={task.id}
              task={task}
              device={data.devices.find((device) => device.id === task.deviceId)}
              localDeviceId={localId}
              refresh={refresh}
            />
          ))}
          {data.devices.length > 0 && (
            <p className="assistant-desktop-note">
              电脑和小序桌面端需保持运行。在任务卡可暂停或停止，紧急停止快捷键见本机「电脑任务」。
              {client?.stopShortcut && `本机快捷键为 ${client.stopShortcut}。`}
              登录、付款、对外发送和删除等操作由你接手。
            </p>
          )}
        </details>
      )}
    </div>
  );
}
