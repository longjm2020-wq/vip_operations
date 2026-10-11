import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Modal, Popconfirm, Space, Spin } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api, queryClient } from "./api";
import {
  compassBrowserLoginActive,
  type CompassBrowserAction,
  type CompassBrowserLoginView,
  type CompassBrowserSession,
} from "../../../packages/contracts/src/compass-update";

const endpoint = "/analytics/compass";

export function CompassBrowserLogin({
  session,
  onConnected,
  onDisconnected,
}: {
  session?: CompassBrowserSession;
  onConnected: () => void;
  onDisconnected: () => void;
}) {
  const { message, modal } = App.useApp();
  const [open, setOpen] = useState(false),
    [loginId, setLoginId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const saved = useRef(""),
    connected = useRef(onConnected);
  connected.current = onConnected;
  const login = useQuery<CompassBrowserLoginView>({
    queryKey: ["compass-browser-login", loginId],
    enabled: open && !!loginId,
    queryFn: async () =>
      (await api(endpoint + "/browser-login/" + loginId)).data,
    refetchInterval: (query) =>
      compassBrowserLoginActive.includes(query.state.data?.status || "")
        ? 2000
        : false,
  });
  const view = login.data,
    active = compassBrowserLoginActive.includes(view?.status || ""),
    ready = view?.status === "WAITING";
  useEffect(() => {
    if (view?.status !== "SAVED" || saved.current === view.id) return;
    saved.current = view.id;
    connected.current();
    message.success("罗盘服务器登录已保存，后续更新复用此会话");
  }, [view?.status, view?.id, message]);

  async function start() {
    setOpen(true);
    setBusy(true);
    setError("");
    setLoginId("");
    try {
      const result = await api(endpoint + "/browser-login", "POST", {});
      setLoginId(result.data.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function action(payload: CompassBrowserAction) {
    if (!loginId || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(
        endpoint + "/browser-login/" + loginId + "/actions",
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
        await api(
          endpoint + "/browser-login/" + loginId + "/cancel",
          "POST",
          {},
        );
      setOpen(false);
      setLoginId("");
      queryClient.removeQueries({
        queryKey: ["compass-browser-login", loginId],
        exact: true,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function requestClose() {
    if (busy) return;
    if (loginId && (!view || active)) {
      modal.confirm({
        title: "取消服务器登录？",
        content:
          "当前登录尚未核验保存。即使已经扫码，取消也会丢弃本次未保存的服务器会话；请继续扫码并点击「核验并保存」，或确认取消登录。",
        okText: "确认取消登录",
        cancelText: "继续扫码",
        okButtonProps: { danger: true },
        maskClosable: false,
        onOk: close,
      });
      return;
    }
    void close();
  }
  async function disconnect() {
    try {
      await api(endpoint + "/browser-session/disconnect", "POST", {});
      onDisconnected();
      message.success("服务器罗盘会话已断开，下次更新需重新扫码");
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  const available = !!session?.encryptionReady && !!session.workerOnline;
  return (
    <>
      <Button disabled={!available} onClick={() => void start()}>
        {session?.status === "READY" ? "管理罗盘登录" : "扫码登录罗盘"}
      </Button>
      <Modal
        title="魔方罗盘服务器登录"
        open={open}
        onCancel={requestClose}
        maskClosable={false}
        keyboard={false}
        width={1000}
        style={{ top: 20 }}
        styles={{
          container: {
            maxHeight: "calc(100dvh - 40px)",
            display: "flex",
            flexDirection: "column",
          },
          header: { flexShrink: 0 },
          body: { minHeight: 0, overflowY: "auto" },
          footer: { flexShrink: 0 },
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
                  刷新登录画面
                </Button>
                <Button
                  disabled={!ready || busy || !view.frameId}
                  onClick={() =>
                    view.frameId &&
                    void action({
                      kind: "SCROLL",
                      frameId: view.frameId,
                      deltaY: -450,
                    })
                  }
                >
                  向上滚动
                </Button>
                <Button
                  disabled={!ready || busy || !view.frameId}
                  onClick={() =>
                    view.frameId &&
                    void action({
                      kind: "SCROLL",
                      frameId: view.frameId,
                      deltaY: 450,
                    })
                  }
                >
                  向下滚动
                </Button>
                <Button
                  type="primary"
                  disabled={!ready || busy}
                  onClick={() => void action({ kind: "CHECK" })}
                >
                  核验并保存
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
            {session?.savedAt && session.status !== "DISCONNECTED" && (
              <Popconfirm
                title="断开服务器罗盘登录？"
                description="清除服务器保存的会话，下次更新需重新扫码。"
                onConfirm={() => void disconnect()}
              >
                <Button danger disabled={busy || active}>
                  断开罗盘会话
                </Button>
              </Popconfirm>
            )}
            <Button disabled={busy} onClick={requestClose}>
              {view?.status === "SAVED" ? "返回更新面板" : "关闭登录窗口"}
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          title="首次独立扫码，保存后电脑可关机"
          description="用唯品会 App 扫描服务器浏览器中的二维码，再点击「核验并保存」。会话加密保存在服务器，更新报表无需再登录经营系统。平台会话过期或要求验证时需在此重新处理；本机与 Dot 的登录不会自动共享。"
        />
        <p>
          可直接点击画面切换扫码入口、确认平台提示，或滚动画面。密码输入区域已遮蔽，本窗口不提供文字输入。
        </p>
        <p>
          扫码后请点击「核验并保存」，看到「罗盘登录已保存」后再返回更新面板。
        </p>
        {(error || login.error) && (
          <Alert type="error" showIcon title={error || login.error?.message} />
        )}
        {view?.note && <p role="status">{view.note}</p>}
        {view?.frame && active ? (
          <img
            className="compass-browser-frame"
            src={view.frame}
            alt="魔方罗盘服务器登录画面"
            draggable={false}
            onClick={(event) => {
              if (!ready || busy || !view.frameId) return;
              const box = event.currentTarget.getBoundingClientRect();
              void action({
                kind: "CLICK",
                frameId: view.frameId,
                point: {
                  x: Math.max(
                    0,
                    Math.min(1, (event.clientX - box.left) / box.width),
                  ),
                  y: Math.max(
                    0,
                    Math.min(1, (event.clientY - box.top) / box.height),
                  ),
                },
              });
            }}
            onWheel={(event) => {
              if (!ready || busy || !view.frameId || !event.deltaY) return;
              event.stopPropagation();
              void action({
                kind: "SCROLL",
                frameId: view.frameId,
                deltaY:
                  Math.max(-1200, Math.min(1200, Math.round(event.deltaY))) ||
                  1,
              });
            }}
          />
        ) : active || busy || login.isLoading ? (
          <div className="compass-browser-loading">
            <Spin /> 正在准备服务器登录画面…
          </div>
        ) : null}
        {view?.status === "SAVED" && (
          <Alert
            type="success"
            showIcon
            title="罗盘登录已保存"
            description="返回更新面板可查看下载与导入结果。本次已发起或等待登录的更新将继续执行。"
          />
        )}
      </Modal>
    </>
  );
}
