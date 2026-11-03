import { useState } from "react";
import { Alert, App, Button, Empty, Space, Tag, Typography } from "antd";
import {
  DownloadOutlined,
  DesktopOutlined,
  PauseOutlined,
  StopOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { api } from "./api";
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
        让小序在你选择的 Windows
        窗口中点击、输入和滚动。电脑任务使用当前选择的识图能力。
      </p>
      <Alert
        type="info"
        showIcon
        title="先连接这台电脑"
        description="下载并解压本机助手，双击启动小序.cmd，再粘贴配对码。每次任务在本机选择一个窗口，允许后才会将窗口画面交给智能服务处理。"
      />
      <Space wrap style={{ margin: "16px 0" }}>
        <Button
          href="/downloads/xuti-desktop.zip"
          download
          icon={<DownloadOutlined />}
        >
          下载 Windows 助手
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
          生成配对码
        </Button>
      </Space>
      {pair && (
        <Alert
          showIcon
          type="info"
          title="仅粘贴到本机助手，10分钟内有效"
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
        电脑需保持开机，本机助手需运行。切换窗口或手动输入会暂停；Ctrl + Alt + X
        随时停止。登录、付款、对外发送和删除等操作由你接手。任务进度会保存，窗口截图不留存。
      </p>
    </div>
  );
}
