import { useEffect, useState } from "react";
import { Alert, App, Button, Empty, Space, Tag, Typography } from "antd";
import {
  DownloadOutlined,
  DesktopOutlined,
  PauseOutlined,
  StopOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { api } from "./api";
import { desktopClientRequest, isDesktopClient } from "./desktop-client";
import {
  desktopStatusLabels,
  type DesktopState,
} from "../../../packages/contracts/src/assistant-desktop";

export function AssistantDesktopPanel({
  data,
  error,
  refresh,
  choose,
}: {
  data?: DesktopState;
  error: string;
  refresh: () => void;
  choose: (id: string) => void;
}) {
  const { message } = App.useApp();
  const [pair, setPair] = useState<{ code: string; expiresAt: string } | null>(
    null,
  );
  const [busy, setBusy] = useState("");
  const native = isDesktopClient();
  const [localDevice, setLocalDevice] = useState("");
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
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="assistant-desktop-panel">
      <div className="assistant-desktop-heading">
        <h3>
          <DesktopOutlined /> 电脑操作
        </h3>
        <Button size="small" icon={<ReloadOutlined />} onClick={refresh}>
          刷新
        </Button>
      </div>
      <p>
        让小序操作 Windows
        应用和网页。可逐次选择窗口，也可在本机记住跨窗口授权，让新任务自动执行。电脑任务使用当前选择的识图能力。
      </p>
      <Alert
        type="info"
        showIcon
        title={native ? "小序桌面端已就绪" : "使用小序桌面端"}
        description={
          native
            ? "连接本机后，在顶部「电脑任务」点击「授权跨窗口操作」，确认一次即可记住这台设备；也可逐次选择窗口并允许。"
            : "下载并解压 Windows 桌面端，双击 XutiDesktop.exe。登录工作台后点击「连接本机」，无需再打开独立助手。"
        }
      />
      <Space wrap style={{ margin: "16px 0" }}>
        {native && (
          <>
            <Button
              type="primary"
              loading={busy === "native-pair"}
              disabled={!!busy}
              onClick={() =>
                void run("native-pair", async () => {
                  const current = await desktopClientRequest("status");
                  if (current.connected) {
                    if (data?.devices.some((d) => d.id === current.deviceId)) {
                      choose(current.deviceId);
                      return;
                    }
                    await desktopClientRequest("show-tasks");
                    throw new Error(
                      "本机已有连接，请先在电脑任务中断开，再连接当前账号",
                    );
                  }
                  const pairCode = (
                    await api(
                      "/my-workspace/assistant/desktop/pair-code",
                      "POST",
                    )
                  ).data.code as string;
                  const result = await desktopClientRequest("pair", pairCode);
                  setLocalDevice(result.deviceId);
                  choose(result.deviceId);
                  message.success("本机已连接，可以给小序下达电脑任务");
                })
              }
            >
              {localDevice && data?.devices.some((d) => d.id === localDevice)
                ? "在本机执行"
                : "连接本机"}
            </Button>
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
        <Button
          href="/downloads/xuti-desktop.zip"
          download
          icon={<DownloadOutlined />}
        >
          {native ? "下载新版桌面端" : "下载 Windows 桌面端"}
        </Button>
        <Button
          loading={busy === "pair"}
          disabled={!!busy}
          onClick={() =>
            void run("pair", async () =>
              setPair(
                (await api("/my-workspace/assistant/desktop/pair-code", "POST"))
                  .data,
              ),
            )
          }
        >
          {native ? "连接其他电脑" : "生成配对码"}
        </Button>
      </Space>
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
              <div>有效至 {new Date(pair.expiresAt).toLocaleTimeString()}</div>
            </>
          }
        />
      )}
      {error && <Alert type="error" title={error} />}
      <h4>已连接电脑</h4>
      {!data?.devices.length && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="尚未连接电脑"
        />
      )}
      {data?.devices.map((d) => (
        <div className="assistant-desktop-item" key={d.id}>
          <strong>{d.name}</strong>
          <Tag color={d.online ? "processing" : undefined}>
            {d.online ? "在线" : "离线"}
          </Tag>
          <Tag color={d.crossWindowAuthorized ? "blue" : undefined}>
            {d.crossWindowAuthorized ? "已记住跨窗口授权" : "逐次允许"}
          </Tag>
          <Space>
            <Button
              size="small"
              type="primary"
              disabled={!d.online}
              onClick={() => choose(d.id)}
            >
              在这台电脑执行
            </Button>
            <Button
              size="small"
              disabled={!!busy}
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
                disabled={!!busy}
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
        </div>
      ))}
      <h4>操作任务</h4>
      {!data?.tasks.length && (
        <p>
          选择电脑后，在对话框描述任务，例如“将记事本中的文字整理成分点列表”。
        </p>
      )}
      {data?.tasks.map((t) => (
        <div className="assistant-desktop-item" key={t.id}>
          <Tag>{desktopStatusLabels[t.status]}</Tag>
          {t.scope === "device" && <Tag>跨窗口</Tag>}
          <strong>{t.instruction}</strong>
          <div>
            {t.deviceName} · {t.window || "尚未选择窗口"} · 已执行 {t.step} 步
          </div>
          <time dateTime={t.updatedAt}>
            {new Date(t.updatedAt).toLocaleString("zh-CN")}
          </time>
          <p role="status">{t.stage}</p>
          <Space>
            {t.status === "RUNNING" && (
              <Button
                size="small"
                icon={<PauseOutlined />}
                disabled={!!busy}
                onClick={() =>
                  void run(t.id, () =>
                    api(
                      `/my-workspace/assistant/desktop/tasks/${t.id}/control`,
                      "POST",
                      { action: "pause" },
                    ),
                  )
                }
              >
                暂停
              </Button>
            )}
            {["PAUSED", "NEEDS_USER"].includes(t.status) && (
              <Button
                size="small"
                disabled={!!busy}
                onClick={() =>
                  void run(t.id, () =>
                    api(
                      `/my-workspace/assistant/desktop/tasks/${t.id}/control`,
                      "POST",
                      { action: "resume" },
                    ),
                  )
                }
              >
                继续
              </Button>
            )}
            {["WAITING", "RUNNING", "PAUSED", "NEEDS_USER"].includes(
              t.status,
            ) && (
              <Button
                size="small"
                icon={<StopOutlined />}
                disabled={!!busy}
                onClick={() =>
                  void run(t.id, () =>
                    api(
                      `/my-workspace/assistant/desktop/tasks/${t.id}/control`,
                      "POST",
                      { action: "stop" },
                    ),
                  )
                }
              >
                停止
              </Button>
            )}
          </Space>
        </div>
      ))}
      <p className="assistant-desktop-note">
        电脑需保持开机，小序桌面端需运行。授权在客户端重启后保留，断开或重新配对后需重新授权。小序可按授权切换窗口，你手动操作会暂停；Ctrl
        + Alt + X
        随时停止。登录、付款、对外发送和删除等操作由你接手。任务进度会保存，窗口截图不留存。
      </p>
    </div>
  );
}
