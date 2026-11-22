import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Space } from "antd";
import { isDesktopClient } from "./desktop-client";

const checkInterval = 30 * 60 * 1000;
const snoozeDuration = 24 * 60 * 60 * 1000;
const snoozeKey = "xuti.desktop.update.snooze";
type Snooze = { version: string; until: number };

function versionParts(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  )
    return null;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function newerVersion(
  candidate: unknown,
  installed: string,
): candidate is string {
  const latest = versionParts(candidate);
  const current = versionParts(installed);
  if (!latest || !current) return false;
  for (let i = 0; i < current.length; i++) {
    if (latest[i] !== current[i]) return latest[i] > current[i];
  }
  return false;
}

function readSnooze(): Snooze | null {
  try {
    const value = JSON.parse(localStorage.getItem(snoozeKey) || "null");
    return typeof value?.version === "string" && Number.isFinite(value.until)
      ? value
      : null;
  } catch {
    return null;
  }
}

export function DesktopUpdateNotice({
  inHeader = false,
}: {
  inHeader?: boolean;
}) {
  const client = window.xutiDesktop;
  if (!isDesktopClient() || !client || client.nativeUpdates) return null;
  return <LegacyUpdateNotice installed={client.version} inHeader={inHeader} />;
}

function LegacyUpdateNotice({
  installed,
  inHeader,
}: {
  installed: string;
  inHeader: boolean;
}) {
  const [snooze, setSnooze] = useState(readSnooze);
  const { data: latest, dataUpdatedAt } = useQuery({
    queryKey: ["desktop-release", installed],
    queryFn: async ({ signal }) => {
      const response = await fetch("/downloads/xuti-desktop-release.json", {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new Error("暂时无法检查桌面端更新");
      const candidate: unknown = (await response.json())?.version;
      return newerVersion(candidate, installed) ? candidate : null;
    },
    staleTime: checkInterval,
    refetchInterval: checkInterval,
    refetchIntervalInBackground: true,
  });
  if (!latest || (snooze?.version === latest && snooze.until > dataUpdatedAt))
    return null;
  const remindLater = () => {
    const value = { version: latest, until: Date.now() + snoozeDuration };
    setSnooze(value);
    try {
      localStorage.setItem(snoozeKey, JSON.stringify(value));
    } catch {
      // The reminder is still silenced for the current page.
    }
  };
  const actions = (
    <Space size={4}>
      <Button
        type={inHeader ? "link" : "primary"}
        size="small"
        href="/downloads/xuti-desktop.zip"
        download
        onClick={remindLater}
        title={`当前版本 ${installed}。下载后退出旧客户端，完整解压新版并启动。`}
      >
        {inHeader ? `下载新版 ${latest}` : "下载新版"}
      </Button>
      <Button
        size="small"
        type={inHeader ? "text" : "default"}
        onClick={remindLater}
      >
        稍后
      </Button>
    </Space>
  );
  if (inHeader)
    return (
      <div aria-label="桌面端更新" role="status">
        {actions}
      </div>
    );
  return (
    <Alert
      type="info"
      showIcon
      aria-label="桌面端更新"
      style={{
        position: "fixed",
        top: 60,
        right: 16,
        zIndex: 1050,
        width: "min(344px, calc(100vw - 32px))",
      }}
      title={`小序桌面端 ${latest} 可下载`}
      description={
        <Space orientation="vertical" size={8}>
          <span>
            当前版本 {installed}。下载后退出旧客户端，完整解压新版并启动。
          </span>
          {actions}
        </Space>
      }
    />
  );
}
