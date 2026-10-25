import {SelectionWorkspace} from "./selection-workspace";
import { BrandVideo } from "./brand-video";
import { FloatingPanels } from "./floating-panels";
import React, { useState } from "react";
const CompassAnalyticsPage = React.lazy(() => import("./compass-analytics").then(module => ({ default: module.CompassAnalyticsPage })));
const CompetitorAnalysisPage = React.lazy(() => import("./competitor-analysis").then(module => ({ default: module.CompetitorAnalysisPage })));
const OperationsWorkspacePage = React.lazy(() => import("./operations-workspace").then(module => ({ default: module.OperationsWorkspacePage })));
const PersonalWorkspacePage = React.lazy(() => import("./personal-workspace").then(module => ({ default: module.PersonalWorkspacePage })));
const CompassAISettingsPage = React.lazy(() => import("./compass-ai-settings").then(module => ({ default: module.CompassAISettingsPage })));
const PublicSelectionCollection = React.lazy(() => import("./selection-collections").then(module => ({ default: module.PublicSelectionCollection })));
const PublicCompassReport = React.lazy(() => import("./public-compass-report").then(module => ({ default: module.PublicCompassReport })));
const PublicCompetitorAnalysis = React.lazy(() => import("./public-competitor-analysis").then(module => ({ default: module.PublicCompetitorAnalysis })));
const SelectionMobilePhotos = React.lazy(() => import("./selection-mobile-photos").then(module => ({ default: module.SelectionMobilePhotos })));
import { createRoot } from "react-dom/client";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "react-router-dom";
import { create } from "zustand";
import {
  App,
  Alert,
  Button,
  Checkbox,
  Form,
  Grid,
  Input,
  Layout,
  Menu,
  Space,
  Spin,
} from "antd";

import {
  AppstoreOutlined,
  InboxOutlined,
  DatabaseOutlined,
  ApartmentOutlined,
  TruckOutlined,
  SettingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ArrowLeftOutlined,
  HomeOutlined,
  ReadOutlined,
} from "@ant-design/icons";
import { api, queryClient, setCsrf } from "./api";
import { UserContext, Row } from "./shared";
import { PageSearchContext } from "./page-search";
import { AccountMenu } from "./account-menu";
import { WorkspaceMenuIcon } from "./workspace-menu-icon";
const ColorSizeMappings = React.lazy(() => import("./color-size-mappings").then(module => ({ default: module.ColorSizeMappings })));
const ProductArchive = React.lazy(() => import("./product-archive").then(module => ({ default: module.ProductArchive })));
const InventoryDetailsPage = React.lazy(() => import("./operations").then(module => ({ default: module.InventoryDetailsPage })));
const ProductDetail = React.lazy(() => import("./operations").then(module => ({ default: module.ProductDetail })));
const AccessPage = React.lazy(() => import("./system").then(module => ({ default: module.AccessPage })));
const AuditPage = React.lazy(() => import("./system").then(module => ({ default: module.AuditPage })));
const VipPage = React.lazy(() => import("./vip").then(module => ({ default: module.VipPage })));
const ProjectTablesPage = React.lazy(()=>import("./project-tables").then(module=>({default:module.ProjectTablesPage})));
const ProjectTablePage = React.lazy(()=>import("./project-tables").then(module=>({default:module.ProjectTablePage})));
const StyleSelectionsPage = React.lazy(() => import("./style-selections").then(module => ({ default: module.StyleSelectionsPage })));
import { ManualPage, manualHref } from "./manual";
import { PersonalAssistantProvider } from "./personal-assistant-provider";
import { SidebarAssistant } from "./sidebar-assistant";
const SopPage = React.lazy(() => import("./projects").then(module => ({ default: module.SopPage })));
const ProjectsPage = React.lazy(() => import("./projects").then(module => ({ default: module.ProjectsPage })));
const ProjectDetailPage = React.lazy(() => import("./projects").then(module => ({ default: module.ProjectDetailPage })));
const ProjectNotifications = React.lazy(() => import("./projects").then(module => ({ default: module.ProjectNotifications })));
import "./style.css";
import "./workspace-shell.css";
import { AppearanceProvider, ThemeToggle } from "./appearance";
const SupplierRegister = React.lazy(() => import("./supply").then(module => ({ default: module.SupplierRegister })));
const SupplyProfile = React.lazy(() => import("./supply").then(module => ({ default: module.SupplyProfile })));
const SupplyProducts = React.lazy(() => import("./supply").then(module => ({ default: module.SupplyProducts })));
const SupplyReview = React.lazy(() => import("./supply").then(module => ({ default: module.SupplyReview })));
const SupplyOrders = React.lazy(() => import("./supply-orders").then(module => ({ default: module.SupplyOrders })));
const SupplyStatements = React.lazy(() => import("./supply-statements").then(module => ({ default: module.SupplyStatements })));
const useUi = create<{ collapsed: boolean; toggle: () => void }>((set) => ({
  collapsed: false,
  toggle: () => set((s) => ({ collapsed: !s.collapsed })),
}));
function BrandMark({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <span
      className={
        collapsed ? "brand-wordmark brand-wordmark-collapsed" : "brand-wordmark"
      }
      role="img"
      aria-label="XUTI 衣序"
    />
  );
}
function Login() {
  const supplierLogin = useLocation().pathname.startsWith("/supply");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="login">
      <section className="login-story">
        <BrandVideo />
        <div className="login-brand">
          <BrandMark />
        </div>
        <div className="login-video-copy">
          <h1>
            让好产品，
            <br />
            遇见新的可能。
          </h1>
        </div>
      </section>
      <section className="login-panel">
        <div className="login-box">
          <span className="eyebrow">工作台登录</span>
          <h2>欢迎回来</h2>
          <p className="secondary">
            {supplierLogin
              ? "供应商登录序缇供应链后台。"
              : "使用管理员为您建立的账户登录。"}
          </p>
          <p>
            <Link to="/supply/register">供应商持邀请码注册入驻</Link>
          </p>
          {error && <Alert type="error" title={error} className="notice" />}
          <Form
            layout="vertical"
            initialValues={{ rememberMe: false }}
            onFinish={async (b) => {
              setBusy(true);
              setError("");
              try {
                const r = await api("/auth/login", "POST", b);
                setCsrf(r.data.csrfToken);
                queryClient.setQueryData(["me"], r.data);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Form.Item
              name="username"
              label="用户名"
              rules={[{ required: true }]}
            >
              <Input autoComplete="username" size="large" />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: true }]}
            >
              <Input.Password autoComplete="current-password" size="large" />
            </Form.Item>
            <Form.Item name="rememberMe" valuePropName="checked">
              <Checkbox>保持登录 30 天</Checkbox>
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              size="large"
              loading={busy}
            >
              进入工作台
            </Button>
          </Form>
          <p className="login-note">内部经营系统 · 商品与供应链管理</p>
        </div>
      </section>
    </div>
  );
}
function ColorSizeMappingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "size" ? "size" : "color";
  return <ColorSizeMappings tab={tab} onTabChange={tab => setParams({ tab })} />;
}
function Workspace({ user }: { user: Row }) {
  const location = useLocation(),
    ui = useUi();
  const personalWorkspace = location.pathname === "/my-workspace";
  const screens = Grid.useBreakpoint();
  const mobileWorkspace = personalWorkspace && screens.md === false;
  const [workspaceNavOpen, setWorkspaceNavOpen] = useState(false);
  const navCollapsed = mobileWorkspace ? !workspaceNavOpen : ui.collapsed;
  React.useEffect(() => setWorkspaceNavOpen(false), [location.pathname]);
  const [searchHost, setSearchHost] = useState<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const header = searchHost?.closest<HTMLElement>(".topbar");
    if (!header) return;
    const publishHeight = () => header.parentElement?.style.setProperty("--workspace-topbar-height", `${header.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(publishHeight);
    observer.observe(header); publishHeight();
    return () => observer.disconnect();
  }, [searchHost]);
  const originalItems = [
    { key: "/analytics/compass", label: "经营分析", icon: <DatabaseOutlined />, permission: "analytics.read" },
    { key: "/analytics/competitors", label: "竞品分析", icon: <DatabaseOutlined />, permission: "analytics.read" },
    { key: "/operations/vip/inventory", label: "库存明细", icon: <InboxOutlined />, permission: "inventory.read" },
    {
      key: "/products",
      label: "商品档案",
      icon: <AppstoreOutlined />,
      permission: "product.read",
    },
    {
      key: "/style-selections",
      label: "选款登记",
      icon: <DatabaseOutlined />,
      permission: "selection.read",
    },
    {
      key: "/project-management",
      label: "项目协作",
      icon: <ApartmentOutlined />,
      children: [
        { key: "/sops", label: "新建SOP", permission: "project.read" },
        { key: "/projects", label: "新建项目", permission: "project.read" },
        {key:"/project-tables",label:"新建表格",permission:"project.read"},
      ],
    },
    {
      key: "/settings",
      label: "系统设置",
      icon: <SettingOutlined />,
      children: [
        { key: "/users", label: "用户", permission: "user.read" },
        { key: "/roles", label: "角色权限", permission: "role.read" },
        { key: "/audit-logs", label: "操作日志", permission: "audit.read" },
        ...(user.roleCodes?.includes("SUPER_ADMIN") ? [{ key: "/settings/ai", label: "AI 模型设置", permission: "analytics.manage" }] : []),
      ],
    },
  ];
  originalItems.push({ key: "/operations/vip/integration", label: "唯品会接入", icon: <SettingOutlined />, permission: "vip.settings" });
  const settings = originalItems.find((i) => i.key === "/settings")!;
  const operationKeys = ["/analytics/compass", "/analytics/competitors", "/style-selections", "/products", "/operations/vip/inventory", "/operations/vip/integration"];
  const items = [
    ...(operationKeys.some((key) =>
      user.permissions.includes(originalItems.find((i) => i.key === key)!.permission!),
    )
      ? [{
          key: "/operations",
          label: "运营中心",
          icon: <DatabaseOutlined />,
          permission: undefined,
          children: undefined,
        }]
      : []),
    originalItems.find((i) => i.key === "/project-management")!,
    {
      key: "/supply",
      label: "供应链端",
      icon: <TruckOutlined />,
      children: [
        ...(user.roleCodes?.includes("SUPPLIER")
          ? [
              {
                key: "/supply/profile",
                label: "企业资质管理",
                permission: "supply.portal",
              },
              {
                key: "/supply/products",
                label: "供应商产品库",
                permission: "supply.portal",
              },
              {
                key: "/supply/orders",
                label: "订单中心",
                permission: "supply.portal",
              },
              {
                key: "/supply/statements",
                label: "对账中心",
                permission: "supply.portal",
              },
            ]
          : []),
        {
          key: "/supply/review",
          label: "入驻审核 / 邀请码",
          permission: "supply.review",
        },
        {
          key: "/supply/catalog",
          label: "供应链产品库",
          permission: "supply.manage",
        },
        {
          key: "/supply/procurement",
          label: "订单中心",
          permission: "supply.purchase",
        },
        {
          key: "/supply/reconciliation",
          label: "对账中心",
          permission: "supply.reconcile",
        },
      ],
    },
    settings,
  ];
  const visibleItems = items
    .filter((i) => !i.permission || user.permissions.includes(i.permission))
    .map((i) => ({
      ...i,
      children: i.children
        ?.filter(
          (c) => !c.permission || user.permissions.includes(c.permission),
        ),
    }))
    .filter((i) => !i.children || i.children.length > 0);
  const selected = operationKeys.some((key) => location.pathname.startsWith(key))
    ? "/operations"
    : items
        .flatMap((i) => i.children?.map((c) => c.key) || [i.key])
        .sort((a, b) => b.length - a.length)
        .find((k) => location.pathname.startsWith(k));
  const parent = items.find((i) =>
    i.children?.some((c) => c.key === selected),
  )?.key;
  const [openMenuKeys,setOpenMenuKeys]=useState<string[]>([]);
  React.useEffect(()=>{
    if (parent) setOpenMenuKeys(keys=>keys.includes(parent) ? keys : [...keys,parent]);
  },[parent]);
  const activeKey = parent || selected;
  const activeWorkspace = visibleItems.find((i) => i.key === activeKey);
  const tableDetail = location.pathname.startsWith("/project-tables/");
  const collaborationTable = location.pathname.startsWith("/style-selections") || location.pathname === "/products" || tableDetail;
  const operationTool = location.pathname.startsWith("/analytics/compass")
    ? "经营分析"
    : location.pathname.startsWith("/analytics/competitors")
      ? "竞品分析"
    : location.pathname.startsWith("/style-selections")
      ? "选款登记"
    : location.pathname.startsWith("/products")
      ? "商品档案"
    : location.pathname.startsWith("/operations/vip/inventory")
      ? "库存明细"
    : location.pathname.startsWith("/operations/vip/integration")
      ? "唯品会接入"
      : undefined;
  const menu = visibleItems.map((item) => {
    const children = item.children?.map((child) => ({
      key: child.key,
      label: (
        <Link to={child.key} aria-current={selected === child.key ? "page" : undefined}>
          {child.label}
        </Link>
      ),
    }));
    return {
      key: item.key,
      icon: navCollapsed ? (
        <WorkspaceMenuIcon workspace={item.key} selected={item.key === activeKey} />
      ) : item.icon,
      popupClassName: item.children ? "workspace-menu-popup" : undefined,
      label: item.children ? item.label : (
        <Link
          to={item.key === activeKey ? location.pathname + location.search : item.key}
          aria-current={item.key === activeKey ? "page" : undefined}
        >
          {item.label}
        </Link>
      ),
      children: navCollapsed && children ? [{
        key: `${item.key}-heading`,
        type: "group" as const,
        label: <span className="workspace-menu-popup-heading">{item.label}</span>,
        children,
      }] : children,
    };
  });
  const routeBack=tableDetail ? {href:"/project-tables",label:"返回表格列表"}
    : location.pathname.startsWith("/projects/") ? {href:"/projects",label:"返回项目列表"}
    : selected && location.pathname!==selected && activeWorkspace?.children?.some(child=>child.key===selected)
      ? {href:selected,label:`返回${activeWorkspace.children.find(child=>child.key===selected)!.label}`}
      : undefined;
  return (
    <PageSearchContext.Provider value={searchHost}><UserContext.Provider value={user}><PersonalAssistantProvider key={user.id}>
      <Layout className={`workspace${personalWorkspace ? " workspace-future" : ""}`}>
        {mobileWorkspace && workspaceNavOpen && <button type="button" className="workspace-nav-scrim" aria-label="关闭工作区导航" onClick={() => setWorkspaceNavOpen(false)} />}
        <Layout.Sider width={personalWorkspace ? 216 : 200} collapsed={navCollapsed} collapsedWidth={mobileWorkspace ? 0 : 80} className="sidebar">
          <Link
            to={
              "/my-workspace"
            }
            className="brand"
          >
            <BrandMark collapsed={navCollapsed} />
          </Link>
          {!navCollapsed && (
            <div className="sidebar-caption">
              {user.roleCodes?.includes("SUPPLIER")
                ? "序缇供应链后台"
                : "内部管理系统"}
            </div>
          )}
          <Menu
            mode="inline"
            theme="dark"
            aria-label="工作区导航"
            selectedKeys={personalWorkspace ? ["/my-workspace"] : selected ? [selected] : []}
            openKeys={openMenuKeys}
            onOpenChange={setOpenMenuKeys}
            items={[
              {
                key: "/my-workspace",
                icon: <HomeOutlined />,
                label: <Link to="/my-workspace" aria-current={personalWorkspace ? "page" : undefined} onClick={() => setWorkspaceNavOpen(false)}>我的工作台</Link>,
              },
              ...menu,
            ]}
          />
          {!personalWorkspace && <SidebarAssistant />}
          <div className="sidebar-footer">
            <Link
              to={manualHref(location.pathname)}
              className="sidebar-help"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="使用手册"
              title="打开当前模块使用手册，保留当前页面"
            >
              <ReadOutlined aria-hidden="true" />
              <span className="sidebar-help-label">使用手册</span>
            </Link>
          </div>
        </Layout.Sider>
        <Layout>
          <Layout.Header className="topbar">
            <div className="topbar-main">
              <Button
                type="text"
                aria-label={navCollapsed ? "展开工作区导航" : "收起工作区导航"}
                onClick={() => mobileWorkspace ? setWorkspaceNavOpen(!workspaceNavOpen) : ui.toggle()}
                icon={
                  navCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />
                }
              />
              <span className="workspace-title">
                {location.pathname === "/my-workspace" ? "我的工作台" : activeWorkspace?.label || "使用手册"}
              </span>
            </div>
            <nav
              className="workspace-subnav"
              aria-label={`${activeWorkspace?.label || "工作台"}功能导航`}
            >
              {routeBack ? <div className="workspace-path"><Link to={routeBack.href} aria-label={routeBack.label}><ArrowLeftOutlined/> {routeBack.label}</Link></div> : operationTool ? (
                <div className="workspace-path">
                  <Link to="/operations?platform=vip">
                    <ArrowLeftOutlined /> 唯品会工作区
                  </Link>
                  <span aria-hidden="true">/</span>
                  <span aria-current="page">{operationTool}</span>
                </div>
              ) : null}
            </nav>
            <div ref={setSearchHost} className="topbar-search-host" role="search" aria-label="当前页面搜索"/>
            <Space className="topbar-actions" size={10}>
              <ThemeToggle />
              <ProjectNotifications />
              <AccountMenu
                user={user}
                onLogout={async () => {
                  await api("/auth/logout", "POST", {});
                  queryClient.removeQueries({
                    predicate: (q) => q.queryKey[0] !== "me",
                  });
                  setCsrf("");
                  queryClient.setQueryData(["me"], null);
                }}
              />
            </Space>
          </Layout.Header>
          <Layout.Content className={`content${collaborationTable ? " selection-workspace-content" : ""}`}>
            <Routes>
              <Route path="/my-workspace" element={<PersonalWorkspacePage key={user.id} />} />
              <Route path="/settings/ai" element={<CompassAISettingsPage />} />
              <Route path="/supply/profile" element={<SupplyProfile />} />
              <Route path="/supply/products" element={<SupplyProducts />} />
              <Route path="/supply/orders" element={<SupplyOrders />} />
              <Route path="/supply/statements" element={<SupplyStatements />} />
              <Route
                path="/supply/reconciliation"
                element={<SupplyStatements internal />}
              />
              <Route
                path="/supply/procurement"
                element={<SupplyOrders internal />}
              />
              <Route path="/supply/review" element={<SupplyReview />} />
              <Route
                path="/supply/catalog"
                element={<SupplyProducts internal />}
              />
              <Route path="/help" element={<ManualPage />} />
              <Route path="/operations" element={<OperationsWorkspacePage />} />
              <Route path="/operations/vip/inventory" element={<InventoryDetailsPage />} />
              <Route path="/products/:id" element={<ProductDetail />} />
              <Route path="/products" element={<ProductArchive key={user.id}/>} />
              <Route
                path="/color-size-mappings"
                element={<ColorSizeMappingsPage />}
              />
              <Route
                path="/color-mappings"
                element={
                  <Navigate to="/color-size-mappings?tab=color" replace />
                }
              />
              <Route
                path="/size-mappings"
                element={
                  <Navigate to="/color-size-mappings?tab=size" replace />
                }
              />
              <Route path="/analytics/compass" element={<CompassAnalyticsPage />} />
              <Route path="/analytics/competitors" element={<CompetitorAnalysisPage />} />
              <Route path="/style-selections" element={<StyleSelectionsPage />} />
              <Route path="/project-tables" element={<ProjectTablesPage/>}/>
              <Route path="/project-tables/:id" element={<ProjectTablePage/>}/>
              <Route path="/users" element={<AccessPage />} />
              <Route path="/roles" element={<AccessPage roles />} />
              <Route path="/audit-logs" element={<AuditPage />} />
              <Route path="/operations/vip/integration" element={<VipPage />} />
              <Route path="/vip" element={<Navigate to="/operations/vip/integration" replace />} />
              <Route path="/sops" element={<SopPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:id" element={<ProjectDetailPage />} />
              <Route
                path="*"
                element={
                  <Navigate
                    to={
                      "/my-workspace"
                    }
                    replace
                  />
                }
              />
            </Routes>
            {!collaborationTable && !personalWorkspace && <footer className="page-footer">
              XUTI
            </footer>}
          </Layout.Content>
        </Layout>
      </Layout>
    </PersonalAssistantProvider></UserContext.Provider></PageSearchContext.Provider>
  );
}
function Root() {
  const location = useLocation();
  const publicCollection = location.pathname === "/collect/products";
  const publicReport = location.pathname.startsWith("/share/compass/");
  const publicCompetitors = location.pathname.startsWith("/share/competitors/");
  const me = useQuery({
    queryKey: ["me"],
    enabled: !publicCollection && !publicReport && !publicCompetitors,
    queryFn: async () => {
      try {
        const r = await api("/auth/me");
        setCsrf(r.data.csrfToken);
        return r.data;
      } catch {
        return null;
      }
    },
    retry: false,
  });
  const renderContent = () => {
  if (publicCollection) return <PublicSelectionCollection />;
  if (publicReport) return <PublicCompassReport />;
  if (publicCompetitors) return <PublicCompetitorAnalysis />;
  if (me.isLoading)
    return (
      <div className="loading">
        <Spin size="large" />
      </div>
    );
  if (
    me.data?.roleCodes?.includes("SUPPLIER") &&
    !location.pathname.startsWith("/supply/") &&
    location.pathname !== "/my-workspace" &&
    location.pathname !== "/help"
  )
    return <Navigate to="/my-workspace" replace />;
  if (me.data && location.pathname === "/mobile/style-photos") return <UserContext.Provider value={me.data}><SelectionWorkspace key={new URLSearchParams(location.search).get("tableId") || "default"} tableId={new URLSearchParams(location.search).get("tableId") || undefined} archive={new URLSearchParams(location.search).get("archive")==="1"}><SelectionMobilePhotos /></SelectionWorkspace></UserContext.Provider>;
  return me.data ? (
    <Workspace user={me.data} />
  ) : location.pathname === "/supply/register" ? (
    <SupplierRegister />
  ) : (
    <Login />
  );
  };
  const publicPage = publicCollection || publicReport || publicCompetitors;
  const accountId = !publicPage && me.data ? String(me.data.id) : null;
  return <AppearanceProvider key={accountId || "guest"} accountId={accountId}><App><FloatingPanels />{(publicPage || (!me.isLoading && !me.data) || location.pathname === "/mobile/style-photos") && <ThemeToggle standalone />}{renderContent()}</App></AppearanceProvider>;
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <React.Suspense fallback={<div className="loading"><Spin size="large" /></div>}><Root /></React.Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
