import {
  assistantWebsiteUrl,
  type AssistantWebOpenResult,
} from "../../../packages/contracts/src/assistant-web-command.js";
import { isDesktopClient } from "./desktop-client.js";

/** Call synchronously from Send/Enter, while browser user activation is still present. */
export function openAssistantWebsite(url: string): AssistantWebOpenResult {
  const target = assistantWebsiteUrl(url);
  if (!target) return "blocked";
  return openWindow(target, false);
}

export function prepareAssistantWebsite(
  requestId: string,
): AssistantWebOpenResult {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      requestId,
    )
  )
    return "blocked";
  const target = new URL("/assistant/open-website", window.location.origin);
  target.searchParams.set("requestId", requestId);
  return openWindow(target.href, true);
}

function openWindow(target: string, pending: boolean): AssistantWebOpenResult {
  let opened: Window | null = null;
  try {
    if (isDesktopClient()) {
      // Desktop 1.2.0 already routes user-initiated HTTPS popups to its browser window.
      // WebView2 handles the window externally and cannot return a usable WindowProxy.
      window.open(target, "_blank", "noopener,noreferrer");
      return pending ? "pending" : "requested";
    }
    opened = window.open("about:blank", "_blank");
    if (!opened) return "blocked";
    opened.opener = null;
    const referrer = opened.document.createElement("meta");
    referrer.name = "referrer";
    referrer.content = "no-referrer";
    opened.document.head.appendChild(referrer);
    opened.location.replace(target);
    return pending ? "pending" : "opened";
  } catch {
    opened?.close();
    return "blocked";
  }
}
