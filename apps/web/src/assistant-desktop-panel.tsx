import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, App, Button, Space, Tag, Typography } from "antd";
import {
  DownloadOutlined,
  DesktopOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { api } from "./api";
import { desktopClientRequest, isDesktopClient } from "./desktop-client";
import type { DesktopState } from "../../../packages/contracts/src/assistant-desktop";
import { AssistantDesktopTaskCard } from "./assistant-desktop-task-card";

export function AssistantDesktopPanel({
  open,
  data,
  error,
  refresh,
  choose,
  connectLocal,
  connecting = false,
  disabled = false,
  setupNote = "",
  selectedId,
}: {
  open: boolean;
  data?: DesktopState;
  error: string;
  refresh: () => Promise<unknown>;
  choose: (id: string) => void;
  connectLocal: () => void;
  connecting?: boolean;
  disabled?: boolean;
  setupNote?: string;
  selectedId?: string;
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
  const [localDevice, setLocalDevice] = useState("");
  const local = data?.devices.find((d) => d.id === localDevice);
  useEffect(() => {
    if (!native) return;
    let active = true;
    void desktopClientRequest("status")
      .then((r) => {
        if (active) setLocalDevice(r.connected ? r.deviceId : "");
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [native, data]);
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
        <Button size="small" icon={<ReloadOutlined />} onClick={refresh}>
          刷新
        </Button>
      </div>
      <p>
        使用你自己的 Windows
        电脑操作网页和应用。首次连接确认一次，之后可直接下达指令。
      </p>
      {(native || !data?.devices.length) && (
        <Alert
          type="info"
          showIcon
          title={
            native
              ? local?.crossWindowAuthorized
                ? "本机已记住授权"
                : local
                  ? "本机已连接，尚未授权"
                  : "小序桌面端已就绪"
              : "使用小序桌面端"
          }
          description={
            native
              ? local?.crossWindowAuthorized
                ? "已记住本机授权，点击「使用我的电脑」即可下达指令。"
                : "点击下方按钮，在本机弹窗确认后即可使用。授权会记住，可随时撤销。"
              : "下载并解压桌面端，打开 XutiDesktop.exe，登录后点击「操作本机」。只需首次确认，之后可从网页或桌面端下达指令。"
          }
        />
      )}
      <Space wrap style={{ margin: "16px 0" }}>
        {native && (
          <>
            <Button
              loading={connecting}
              disabled={!!busy || disabled}
              onClick={connectLocal}
            >
              使用我的电脑
            </Button>
            <Button
              onClick={() =>
                void run("native-tasks", () =>
                  desktopClientRequest("show-tasks"),
                )
              }
              disabled={!!busy || disabled}
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
            {d.online ? "在线" : "离线"}
          </Tag>
          <Tag color={d.crossWindowAuthorized ? "blue" : undefined}>
            {d.crossWindowAuthorized ? "已记住跨窗口授权" : "逐次允许"}
          </Tag>
          {selectedId === d.id && <Tag color="blue">当前执行电脑</Tag>}
          <Space>
            <Button
              size="small"
              disabled={!d.online || !!busy || disabled}
              onClick={() => choose(d.id)}
            >
              在这台电脑执行
            </Button>
          </Space>
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
      {!!data?.devices.length && <h4>操作任务</h4>}
      {!!data?.devices.length && !data?.tasks.length && (
        <p>
          选择电脑后，在对话框描述任务，例如“将记事本中的文字整理成分点列表”。
        </p>
      )}
      {data?.tasks.map((t) => (
        <AssistantDesktopTaskCard
          key={t.id}
          task={t}
          device={data.devices.find((device) => device.id === t.deviceId)}
          localDeviceId={localDevice}
          refresh={refresh}
        />
      ))}
      {!!data?.devices.length && (
        <p className="assistant-desktop-note">
          电脑需保持开机，小序桌面端需运行。授权在客户端重启后保留，断开或重新配对后需重新授权。小序可按授权切换窗口，你手动操作会暂停；Ctrl
          + Alt + X
          随时停止。登录、付款、对外发送和删除等操作由你接手。任务进度会保存，窗口截图不留存。
        </p>
      )}
    </div>
  );
}
