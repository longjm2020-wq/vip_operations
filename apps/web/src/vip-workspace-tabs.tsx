import {
  ApiOutlined,
  AppstoreOutlined,
  ArrowLeftOutlined,
  BarChartOutlined,
  CloseOutlined,
  DatabaseOutlined,
  FundProjectionScreenOutlined,
  InboxOutlined,
} from "@ant-design/icons";
import { Dropdown, type MenuProps } from "antd";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useCan } from "./shared";

export interface VipWorkspaceTab {
  key: string;
  label: string;
  href: string;
}

const VIP_WORKSPACE_ROUTES: ReadonlyArray<{
  prefix: string;
  label: string;
  permission: string;
  icon: ReactNode;
}> = [
  {
    prefix: "/analytics/compass",
    label: "经营分析",
    permission: "analytics.read",
    icon: <BarChartOutlined />,
  },
  {
    prefix: "/style-selections",
    label: "选款登记",
    permission: "selection.read",
    icon: <DatabaseOutlined />,
  },
  {
    prefix: "/products",
    label: "商品档案",
    permission: "product.read",
    icon: <AppstoreOutlined />,
  },
  {
    prefix: "/analytics/competitors",
    label: "竞品分析",
    permission: "analytics.read",
    icon: <FundProjectionScreenOutlined />,
  },
  {
    prefix: "/operations/vip/inventory",
    label: "库存明细",
    permission: "inventory.read",
    icon: <InboxOutlined />,
  },
  {
    prefix: "/operations/vip/integration",
    label: "唯品会接入",
    permission: "vip.settings",
    icon: <ApiOutlined />,
  },
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

  const reorderTabs = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    setTabs((prev) => {
      const fromIdx = prev.findIndex((tab) => tab.key === fromKey);
      const toIdx = prev.findIndex((tab) => tab.key === toKey);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      saveStoredTabs(storageKey, next);
      return next;
    });
  };

  return {
    tabs,
    activeTabKey: activeRoute?.key,
    closeTab,
    reorderTabs,
  };
}

/** Render the 唯品会工作区 link with a hover dropdown of permitted sub-module entries. */
export function VipWorkspaceRootDropdown({
  activeTabKey,
}: {
  activeTabKey?: string;
}) {
  const analytics = useCan("analytics.read");
  const selection = useCan("selection.read");
  const products = useCan("product.read");
  const inventory = useCan("inventory.read");
  const vipSettings = useCan("vip.settings");

  const permissions: Record<string, boolean> = {
    "analytics.read": analytics,
    "selection.read": selection,
    "product.read": products,
    "inventory.read": inventory,
    "vip.settings": vipSettings,
  };

  const menuItems: MenuProps["items"] = VIP_WORKSPACE_ROUTES.filter(
    (route) => permissions[route.permission]
  ).map((route) => ({
    key: route.prefix,
    icon: route.icon,
    label: <Link to={route.prefix}>{route.label}</Link>,
  }));

  const rootLink = (
    <Link to="/operations?platform=vip" className="vip-workspace-root-link">
      <ArrowLeftOutlined /> 唯品会工作区
    </Link>
  );

  if (!menuItems.length) return rootLink;

  return (
    <Dropdown
      menu={{
        items: menuItems,
        selectedKeys: activeTabKey ? [activeTabKey] : [],
      }}
      trigger={["hover"]}
      placement="bottomLeft"
      overlayClassName="vip-workspace-root-dropdown"
    >
      {rootLink}
    </Dropdown>
  );
}

interface VipWorkspaceTabBarProps {
  tabs: VipWorkspaceTab[];
  activeTabKey?: string;
  onCloseTab: (key: string) => void;
  onReorderTabs: (fromKey: string, toKey: string) => void;
}

/** Render switchable, closeable, drag-reorderable tabs for opened VIP workspace sub-pages. */
export function VipWorkspaceTabBar({
  tabs,
  activeTabKey,
  onCloseTab,
  onReorderTabs,
}: VipWorkspaceTabBarProps) {
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  if (!tabs.length) return null;

  return (
    <div
      className="vip-workspace-tabs"
      role="tablist"
      aria-label="唯品会工作区已打开页面"
    >
      {tabs.map((tab) => {
        const isActive = tab.key === activeTabKey;
        const isDragging = tab.key === draggingKey;
        const isDragOver = tab.key === dragOverKey && draggingKey !== tab.key;
        return (
          <div
            key={tab.key}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", tab.key);
              setDraggingKey(tab.key);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragOverKey !== tab.key) setDragOverKey(tab.key);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const fromKey =
                draggingKey || e.dataTransfer.getData("text/plain");
              if (fromKey && fromKey !== tab.key) {
                onReorderTabs(fromKey, tab.key);
              }
              setDraggingKey(null);
              setDragOverKey(null);
            }}
            onDragEnd={() => {
              setDraggingKey(null);
              setDragOverKey(null);
            }}
            className={`vip-workspace-tab${isActive ? " is-active" : ""}${
              isDragging ? " is-dragging" : ""
            }${isDragOver ? " is-drag-over" : ""}`}
          >
            <Link
              to={tab.href}
              draggable={false}
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
