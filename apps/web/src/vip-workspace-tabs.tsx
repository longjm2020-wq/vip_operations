import { CloseOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

export interface VipWorkspaceTab {
  key: string;
  label: string;
  href: string;
}

const VIP_WORKSPACE_ROUTES: ReadonlyArray<{
  prefix: string;
  label: string;
}> = [
  { prefix: "/analytics/compass", label: "经营分析" },
  { prefix: "/analytics/competitors", label: "竞品分析" },
  { prefix: "/style-selections", label: "选款登记" },
  { prefix: "/products", label: "商品档案" },
  { prefix: "/operations/vip/inventory", label: "库存明细" },
  { prefix: "/operations/vip/integration", label: "唯品会接入" },
];

/** Resolve a pathname to its canonical VIP workspace tab metadata. */
export function resolveVipWorkspaceRoute(pathname: string) {
  const matched = VIP_WORKSPACE_ROUTES.find((route) =>
    pathname.startsWith(route.prefix)
  );
  return matched
    ? { key: matched.prefix, label: matched.label, defaultHref: matched.prefix }
    : null;
}

function getStorageKey(userId?: number | string) {
  return `vip_workspace_tabs:${userId ?? "anon"}`;
}

function loadStoredTabs(storageKey: string): VipWorkspaceTab[] {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is VipWorkspaceTab =>
        Boolean(item) &&
        typeof item.key === "string" &&
        typeof item.label === "string" &&
        typeof item.href === "string" &&
        Boolean(resolveVipWorkspaceRoute(item.key))
    );
  } catch {
    return [];
  }
}

function saveStoredTabs(storageKey: string, tabs: VipWorkspaceTab[]) {
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(tabs));
  } catch {
    // Ignore storage errors in restricted environments.
  }
}

/** Manage open VIP workspace sub-page tabs in sessionStorage for the current user. */
export function useVipWorkspaceTabs(userId?: number | string) {
  const location = useLocation();
  const navigate = useNavigate();
  const storageKey = getStorageKey(userId);

  const [tabs, setTabs] = useState<VipWorkspaceTab[]>(() =>
    loadStoredTabs(storageKey)
  );

  const activeRoute = useMemo(
    () => resolveVipWorkspaceRoute(location.pathname),
    [location.pathname]
  );

  useEffect(() => {
    setTabs(loadStoredTabs(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (!activeRoute) return;
    const currentHref = `${location.pathname}${location.search}${location.hash}`;
    setTabs((prev) => {
      const idx = prev.findIndex((tab) => tab.key === activeRoute.key);
      if (idx === -1) {
        const next = [
          ...prev,
          { key: activeRoute.key, label: activeRoute.label, href: currentHref },
        ];
        saveStoredTabs(storageKey, next);
        return next;
      }
      if (
        prev[idx].href === currentHref &&
        prev[idx].label === activeRoute.label
      ) {
        return prev;
      }
      const next = prev.map((tab, i) =>
        i === idx
          ? { key: activeRoute.key, label: activeRoute.label, href: currentHref }
          : tab
      );
      saveStoredTabs(storageKey, next);
      return next;
    });
  }, [activeRoute, location.hash, location.pathname, location.search, storageKey]);

  const closeTab = (key: string) => {
    const idx = tabs.findIndex((tab) => tab.key === key);
    if (idx === -1) return;
    const remaining = tabs.filter((tab) => tab.key !== key);
    setTabs(remaining);
    saveStoredTabs(storageKey, remaining);

    if (activeRoute?.key === key) {
      const nextTab = remaining[Math.min(idx, remaining.length - 1)];
      navigate(nextTab ? nextTab.href : "/operations?platform=vip");
    }
  };

  return {
    tabs,
    activeTabKey: activeRoute?.key,
    closeTab,
  };
}

interface VipWorkspaceTabBarProps {
  tabs: VipWorkspaceTab[];
  activeTabKey?: string;
  onCloseTab: (key: string) => void;
}

/** Render switchable, closeable tabs for opened VIP workspace sub-pages. */
export function VipWorkspaceTabBar({
  tabs,
  activeTabKey,
  onCloseTab,
}: VipWorkspaceTabBarProps) {
  if (!tabs.length) return null;

  return (
    <div
      className="vip-workspace-tabs"
      role="tablist"
      aria-label="唯品会工作区已打开页面"
    >
      {tabs.map((tab) => {
        const isActive = tab.key === activeTabKey;
        return (
          <div
            key={tab.key}
            className={`vip-workspace-tab${isActive ? " is-active" : ""}`}
          >
            <Link
              to={tab.href}
              role="tab"
              aria-selected={isActive}
              aria-current={isActive ? "page" : undefined}
              className="vip-workspace-tab-link"
            >
              {tab.label}
            </Link>
            <button
              type="button"
              className="vip-workspace-tab-close"
              aria-label={`关闭${tab.label}`}
              onClick={() => onCloseTab(tab.key)}
            >
              <CloseOutlined aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
