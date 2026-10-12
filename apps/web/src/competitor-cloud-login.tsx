import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Modal, Popconfirm, Space, Spin, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { when } from "./shared";
import {
  cloudLoginActive,
  type CloudAction,
  type CloudLoginView,
  type CompetitorCloudStatus,
} from "../../../packages/contracts/src/competitor-cloud";

const endpoint = "/analytics/competitors";
const labels: Record<string, [string, string]> = {
  DISCONNECTED: ["云端未登录", "default"],
  READY: ["云端已连接", "success"],
  LOGIN_REQUIRED: ["云端需登录", "warning"],
  VERIFICATION_REQUIRED: ["云端需验证", "warning"],
  ERROR: ["云端会话异常", "error"],
};
export function CompetitorCloudLogin({
  manage,
  onConnected,
  openRequest = 0,
  resumeUpdate = false,
  onCancelUpdate,
  onDisconnected,
}: {
  manage: boolean;
  onConnected: () => void;
  openRequest?: number;
  resumeUpdate?: boolean;
  onCancelUpdate?: () => void;
  onDisconnected?: () => void;
}) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false),
    [loginId, setLoginId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const saved = useRef("");
  const requested = useRef(0);
  const points = useRef<{ x: number; y: number }[]>([]);
  const session = useQuery<CompetitorCloudStatus>({
    queryKey: ["competitor-cloud-session"],
    queryFn: async () => (await api(endpoint + "/cloud-session")).data,
    refetchInterval: open ? 5000 : 60000,
  });
  const login = useQuery<CloudLoginView>({
    queryKey: ["competitor-cloud-login", loginId],
    enabled: open && !!loginId,
    queryFn: async () => (await api(endpoint + "/cloud-login/" + loginId)).data,
    refetchInterval: (query) =>
      cloudLoginActive.includes(query.state.data?.status || "") ? 2000 : false,
  });
  const view = login.data,
    active = cloudLoginActive.includes(view?.status || ""),
    ready = view?.status === "WAITING";
  useEffect(() => {
    if (view?.status === "SAVED" && saved.current !== view.id) {
      saved.current = view.id;
      void session.refetch();
      if (resumeUpdate) setOpen(false);
      onConnected();
      message.success("云端登录已保存，后续后台采集会复用此会话");
    }
  }, [view?.status, view?.id]);
  useEffect(() => {
    if (openRequest && openRequest !== requested.current) {
      requested.current = openRequest;
      void start();
    }
  }, [openRequest]);
  async function start() {
    setOpen(true);
    setBusy(true);
    setError("");
    setLoginId("");
    try {
      const result = await api(endpoint + "/cloud-login", "POST", {});
      setLoginId(result.data.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function action(payload: CloudAction) {
    if (!loginId || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(
        endpoint + "/cloud-login/" + loginId + "/actions",
        "POST",
        payload,
      );
      await login.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    if (busy) return;
    setBusy(true);
    try {
      if (loginId && (!view || active))
        await api(endpoint + "/cloud-login/" + loginId + "/cancel", "POST", {});
      setOpen(false);
      setLoginId("");
      onCancelUpdate?.();
      void session.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    try {
      await api(endpoint + "/cloud-session/disconnect", "POST", {});
      await session.refetch();
      onCancelUpdate?.();
      onDisconnected?.();
      message.success("云端会话已断开，自动采集需重新登录");
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  const data = session.data,
    restricted =
      data?.status === "VERIFICATION_REQUIRED" &&
      data.note.includes("HTTP 920"),
    [label, color] = (restricted
      ? ["云端访问受限", "warning"]
      : labels[data?.status || ""]) || ["云端状态待核验", "default"];
  return (
    <>
      <span className="competitor-browser-login">
        <Tag
          color={color}
          title={
            data?.note ||
            (data?.savedAt
              ? `云端登录保存于 ${when(data.savedAt)}；${data.workerOnline ? "采集程序在线" : "采集程序离线"}`
              : "云端使用独立会话，完成扫码并核验后供后台定时采集使用")
          }
        >
          {label}
        </Tag>
        {manage && (
          <Button type="link" size="small" onClick={() => void start()}>
            {data?.status === "READY" ? "管理云端登录" : "云端登录"}
          </Button>
        )}
      </span>
      <Modal
        title="唯品会云端登录"
        open={open}
        onCancel={() => void close()}
        width={900}
        className="competitor-cloud-modal"
        style={{ top: 24 }}
        styles={{
          body: { maxHeight: "calc(100dvh - 180px)", overflowY: "auto" },
        }}
        destroyOnHidden
        footer={
          <Space wrap>
            {view && active && (
              <>
                <Button
                  disabled={!ready || busy}
                  onClick={() => void action({ kind: "REFRESH" })}
                >
                  刷新二维码
                </Button>
                <Button
                  type="primary"
                  disabled={!ready || busy}
                  onClick={() => void action({ kind: "CHECK" })}
                >
                  {resumeUpdate ? "核验并继续更新" : "核验并保存"}
                </Button>
              </>
            )}
            {(!loginId || (view && !active && view.status !== "SAVED")) && (
              <Button
                type="primary"
                loading={busy}
                onClick={() => void start()}
              >
                重新打开
              </Button>
            )}
            {data?.savedAt && data.status !== "DISCONNECTED" && (
              <Popconfirm
                title="断开云端登录？"
                description="清除服务器保存的会话，后续采集需重新扫码。"
                onConfirm={() => void disconnect()}
              >
                <Button danger disabled={busy || active}>
                  断开云端会话
                </Button>
              </Popconfirm>
            )}
            <Button disabled={busy} onClick={() => void close()}>
              {view?.status === "SAVED" ? "返回竞品分析" : "关闭窗口"}
            </Button>
          </Space>
        }
      >
        <p>
          先查看当前云端页面；出现二维码时再用唯品会 App 扫码。完成后点击「
          {resumeUpdate ? "核验并继续更新" : "核验并保存"}」。
        </p>
        <Alert
          type="info"
          showIcon
          title="保存后无需保持电脑或 Codex 在线"
          description="服务器独立保存加密会话。可点击或拖动画面完成平台操作，密码输入区域隐藏。"
        />
        {(error || login.error || session.error) && (
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            showIcon
            title={error || (login.error || session.error)?.message}
          />
        )}
        {view?.note && <p role="status">{view.note}</p>}
        {view?.note.includes("HTTP 920") && (
          <Alert
            type="warning"
            showIcon
            title="登录成功不代表商品接口已恢复"
            description="当前云端商品访问被唯品会限制。请按官方页面提示处理；仍受限时需联系平台确认该云端访问。核验通过前不会继续提交采集任务。"
          />
        )}
        {view?.frame && active ? (
          <img
            className="competitor-cloud-frame"
            src={view.frame}
            alt="唯品会云端登录画面"
            draggable={false}
            onPointerDown={(event) => {
              if (!ready || busy) return;
              const box = event.currentTarget.getBoundingClientRect();
              points.current = [
                {
                  x: (event.clientX - box.left) / box.width,
                  y: (event.clientY - box.top) / box.height,
                },
              ];
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (
                !points.current.length ||
                !event.currentTarget.hasPointerCapture(event.pointerId)
              )
                return;
              const box = event.currentTarget.getBoundingClientRect();
              if (points.current.length < 78)
                points.current.push({
                  x: Math.max(
                    0,
                    Math.min(1, (event.clientX - box.left) / box.width),
                  ),
                  y: Math.max(
                    0,
                    Math.min(1, (event.clientY - box.top) / box.height),
                  ),
                });
            }}
            onPointerCancel={() => {
              points.current = [];
            }}
            onPointerUp={(event) => {
              if (!points.current.length || !view.frameId) return;
              const box = event.currentTarget.getBoundingClientRect(),
                end = {
                  x: Math.max(
                    0,
                    Math.min(1, (event.clientX - box.left) / box.width),
                  ),
                  y: Math.max(
                    0,
                    Math.min(1, (event.clientY - box.top) / box.height),
                  ),
                };
              const trail = [...points.current, end],
                first = trail[0];
              points.current = [];
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
              void action(
                Math.hypot(
                  (end.x - first.x) * box.width,
                  (end.y - first.y) * box.height,
                ) > 6
                  ? { kind: "DRAG", frameId: view.frameId, points: trail }
                  : { kind: "CLICK", frameId: view.frameId, point: end },
              );
            }}
          />
        ) : active || busy || login.isLoading ? (
          <div className="competitor-cloud-loading">
            <Spin /> 正在准备云端画面…
          </div>
        ) : null}
        {view?.status === "SAVED" && (
          <Alert
            type="success"
            showIcon
            title="云端已连接"
            description="返回竞品分析，点击「更新竞品数据」即可开始；每日自动采集继续按采集设置执行。"
          />
        )}
      </Modal>
    </>
  );
}
