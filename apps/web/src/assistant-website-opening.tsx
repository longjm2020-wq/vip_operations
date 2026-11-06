import { useEffect, useState } from "react";
import { Button, Spin } from "antd";
import { useSearchParams } from "react-router-dom";
import { api } from "./api";
import type { AssistantConversation } from "../../../packages/contracts/src/personal-assistant";
import { assistantWebsiteUrl } from "../../../packages/contracts/src/assistant-web-command";

/** This same-origin window works in regular browsers and Desktop 1.2.0's WebView. */
export function AssistantWebsiteOpening() {
  const [params] = useSearchParams();
  const requestId = params.get("requestId") || "";
  const [notice, setNotice] = useState("正在查找网站，找到后自动打开…");
  const [waiting, setWaiting] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const referrer = document.createElement("meta");
    referrer.name = "referrer";
    referrer.content = "no-referrer";
    document.head.appendChild(referrer);
    const stop = (text: string) => {
      setWaiting(false);
      setNotice(text);
      clearTimeout(timer);
    };
    const timeout = setTimeout(() => {
      controller.abort();
      stop("未能及时打开网站，请返回原对话查看结果或重新发送网站名称。");
    }, 65000);
    const check = async () => {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          requestId,
        )
      ) {
        clearTimeout(timeout);
        stop("打开请求无效，请从小序对话重新发送网站名称。");
        return;
      }
      try {
        const response = await api(
          "/my-workspace/assistant",
          "GET",
          undefined,
          undefined,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const conversation = response.data as AssistantConversation;
        const index = conversation.messages.findIndex(
          (item) => item.role === "user" && item.id === requestId,
        );
        const reply = index >= 0 ? conversation.messages[index + 1] : undefined;
        if (reply?.role === "assistant") {
          clearTimeout(timeout);
          const target =
            reply.webNavigation && assistantWebsiteUrl(reply.webNavigation.url);
          if (target) {
            stop(`正在打开${reply.webNavigation!.title}…`);
            window.location.replace(target);
          } else stop(reply.text || "未能确认网站，请返回原对话补充网站名称。");
          return;
        }
        if (index >= 0 && conversation.state === "FAILED") {
          clearTimeout(timeout);
          stop(conversation.error || "网站查询失败，请返回原对话重试。");
          return;
        }
        timer = setTimeout(() => void check(), 750);
      } catch (error) {
        if (controller.signal.aborted) return;
        clearTimeout(timeout);
        stop((error as Error).message || "网站查询失败，请返回原对话重试。");
      }
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(timeout);
      referrer.remove();
    };
  }, [requestId]);
  return (
    <main
      style={{
        maxWidth: 560,
        margin: "18vh auto",
        padding: 24,
        textAlign: "center",
      }}
    >
      <h1>小序正在打开网页</h1>
      {waiting && <Spin />}
      <p role="status">{notice}</p>
      {!waiting && <Button href="/my-workspace">返回工作台</Button>}
    </main>
  );
}
