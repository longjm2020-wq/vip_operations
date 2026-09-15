import React, { useState, useEffect } from "react";
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
  Avatar,
  Button,
  ConfigProvider,
  Form,
  Input,
  Layout,
  Menu,
  Space,
  Spin,
  Tabs,
  Typography,
} from "antd";
import zhCN from "antd/locale/zh_CN";
import {
  AppstoreOutlined,
  InboxOutlined,
  ShoppingCartOutlined,
  DatabaseOutlined,
  TeamOutlined,
  SettingOutlined,
  AuditOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from "@ant-design/icons";
import { api, queryClient, setCsrf } from "./api";
import { UserContext, Row } from "./shared";
import { MasterPage } from "./master";
import {
  InventoryPage,
  TransactionsPage,
  PurchaseList,
  PurchaseNew,
  DocumentDetail,
  SuggestionsPage,
  ProductDetail,
} from "./operations";
import { AccessPage, AuditPage } from "./system";
import { VipPage } from "./vip";
import { ManualPage, manualHref } from "./manual";
import {
  SopPage,
  ProjectsPage,
  ProjectDetailPage,
  ProjectNotifications,
} from "./projects";
import "./style.css";
const useUi = create<{ collapsed: boolean; toggle: () => void }>((set) => ({
  collapsed: false,
  toggle: () => set((s) => ({ collapsed: !s.collapsed })),
}));
function BrandMark({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <svg
      className="brand-wordmark"
      viewBox={collapsed ? "42 0 80 121" : "30 0 340 121"}
      role="img"
      aria-label="XUTI"
    >
      <defs>
        <filter id="brand-mask-filter" colorInterpolationFilters="sRGB">
          <feColorMatrix type="luminanceToAlpha" />
          <feComponentTransfer>
            <feFuncA type="discrete" tableValues="0 1 1 1 1 1 1 1" />
          </feComponentTransfer>
        </filter>
        <mask
          id="brand-wordmark-mask"
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="399"
          height="121"
          style={{ maskType: "alpha" }}
        >
          <image
            href="/xuti-wordmark.png"
            width="399"
            height="121"
            filter="url(#brand-mask-filter)"
          />
        </mask>
        <linearGradient id="brand-silver" x1="0" y1="0" x2="1" y2="0">
          <stop
            className="brand-stop brand-stop-a"
            offset="0%"
            stopColor="#718093"
          />
          <stop
            className="brand-stop brand-stop-b"
            offset="50%"
            stopColor="#f4f6fa"
          />
          <stop
            className="brand-stop brand-stop-c"
            offset="100%"
            stopColor="#a3adba"
          />
        </linearGradient>
      </defs>
      <rect
        width="399"
        height="121"
        fill="url(#brand-silver)"
        mask="url(#brand-wordmark-mask)"
      />
    </svg>
  );
}
function Login() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="login">
      <section className="login-story">
        <div className="login-brand">
          <BrandMark />
        </div>
        <div>
          <div className="eyebrow">APPAREL OPERATIONS</div>
          <h1>
            每一件服装，
            <br />
            都有清晰的经营脉络。
          </h1>
          <p>商品、库存与采购，连接成一个可追溯的工作流。</p>
          <div className="story-line">
            01 建立商品 <span>—</span> 02 管理库存 <span>—</span> 03 采购入库
          </div>
        </div>
        <small>供应商经营管理系统 / v0.1</small>
      </section>
      <section className="login-panel">
        <div className="login-box">
          <span className="eyebrow">工作台登录</span>
          <h2>欢迎回来</h2>
          <p className="secondary">使用管理员为您建立的账户登录。</p>
          {error && <Alert type="error" title={error} className="notice" />}
          <Form
            layout="vertical"
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
  return (
    <>
      <Tabs
        activeKey={tab}
        onChange={(key) => setParams({ tab: key })}
        items={[
          { key: "color", label: "颜色映射" },
          { key: "size", label: "尺码映射" },
        ]}
      />
      <MasterPage key={tab} resource={`${tab}-mappings`} />
    </>
  );
}
function Workspace({ user }: { user: Row }) {
  const location = useLocation(),
    ui = useUi();
  const originalItems = [
    {
      key: "/products",
      label: "商品档案",
      icon: <AppstoreOutlined />,
      permission: "product.read",
    },
    {
      key: "/skus",
      label: "SKU 管理",
      icon: <DatabaseOutlined />,
      permission: "product.read",
    },
    {
      key: "/inventory",
      label: "SKU 库存",
      icon: <InboxOutlined />,
      permission: "inventory.read",
    },
    {
      key: "/inventory/transactions",
      label: "库存流水",
      icon: <AuditOutlined />,
      permission: "inventory.read",
    },
    {
      key: "/purchase-suggestions",
      label: "采购建议",
      icon: <ShoppingCartOutlined />,
      permission: "purchase.read",
    },
    {
      key: "/purchase-orders",
      label: "采购订单",
      icon: <ShoppingCartOutlined />,
      permission: "purchase.read",
    },
    {
      key: "/receipts",
      label: "到货入库",
      icon: <InboxOutlined />,
      permission: "receipt.read",
    },
    {
      key: "/suppliers",
      label: "供应商",
      icon: <TeamOutlined />,
      permission: "supplier.read",
    },
    {
      key: "/project-management",
      label: "项目管理",
      icon: <TeamOutlined />,
      permission: "project.read",
      children: [
        { key: "/sops", label: "操作流程 SOP", permission: "project.read" },
        { key: "/projects", label: "新建项目", permission: "project.read" },
      ],
    },
    {
      key: "/settings",
      label: "系统设置",
      icon: <SettingOutlined />,
      children: [
        { key: "/warehouses", label: "仓库", permission: "warehouse.read" },
        { key: "/categories", label: "品类", permission: "product.read" },
        {
          key: "/color-size-mappings",
          label: "颜色尺码映射",
          permission: "product.read",
        },
        { key: "/brands", label: "品牌", permission: "product.read" },
        { key: "/users", label: "用户", permission: "user.read" },
        { key: "/roles", label: "角色权限", permission: "role.read" },
        { key: "/audit-logs", label: "操作日志", permission: "audit.read" },
        { key: "/vip", label: "唯品会接入", permission: "vip.settings" },
      ],
    },
  ];
  const settings = originalItems.find((i) => i.key === "/settings")!;
  const adminKeys = ["/users", "/roles", "/audit-logs"];
  const items = [
    {
      key: "/erp",
      label: "ERP系统",
      icon: <AppstoreOutlined />,
      children: [
        ...originalItems.filter((i) => !i.children),
        ...settings.children!.filter((i) => !adminKeys.includes(i.key)),
      ],
    },
    originalItems.find((i) => i.key === "/project-management")!,
    {
      ...settings,
      children: settings.children!.filter((i) => adminKeys.includes(i.key)),
    },
  ];
  const menu = items
    .filter((i) => !i.permission || user.permissions.includes(i.permission))
    .map((i) => ({
      ...i,
      label: i.children ? i.label : <Link to={i.key}>{i.label}</Link>,
      children: i.children
        ?.filter(
          (c) => !c.permission || user.permissions.includes(c.permission),
        )
        .map((c) => ({ ...c, label: <Link to={c.key}>{c.label}</Link> })),
    }))
    .filter((i) => !i.children || i.children.length > 0);
  const selected = items
    .flatMap((i) => i.children || [i])
    .map((i) => i.key)
    .sort((a, b) => b.length - a.length)
    .find((k) => location.pathname.startsWith(k));
  const parent = items.find((i) =>
    i.children?.some((c) => c.key === selected),
  )?.key;
  const [openKeys, setOpenKeys] = useState<string[]>(parent ? [parent] : []);
  useEffect(() => {
    if (parent)
      setOpenKeys((keys) => (keys.includes(parent) ? keys : [...keys, parent]));
  }, [parent]);
  return (
    <UserContext.Provider value={user}>
      <Layout className="workspace">
        <Layout.Sider width={224} collapsed={ui.collapsed} className="sidebar">
          <Link to="/products" className="brand">
            <BrandMark collapsed={ui.collapsed} />
          </Link>
          {!ui.collapsed && <div className="sidebar-label">OPERATIONS</div>}
          <Menu
            mode="inline"
            theme="dark"
            selectedKeys={selected ? [selected] : []}
            openKeys={openKeys}
            onOpenChange={setOpenKeys}
            items={menu}
          />
          {!ui.collapsed && (
            <div className="sidebar-footer">
              <span className="status-dot" /> 内部管理系统
              <br />
              <small>商品 · 库存 · 采购</small>
            </div>
          )}
        </Layout.Sider>
        <Layout>
          <Layout.Header className="topbar">
            <Space>
              <Button
                type="text"
                onClick={ui.toggle}
                icon={
                  ui.collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />
                }
              />
              <Typography.Text type="secondary">
                服装供应商经营工作台
              </Typography.Text>
            </Space>
            <Space size={14}>
              <Link
                to={manualHref(location.pathname)}
                target="_blank"
                rel="noopener noreferrer"
                title="打开当前模块使用手册，保留当前页面"
              >
                使用手册
              </Link>
              <ProjectNotifications />
              <Avatar
                size={30}
                style={{ background: "#f5dfc9", color: "#d3540b" }}
              >
                {user.displayName?.slice(0, 1)}
              </Avatar>
              <span>{user.displayName}</span>
              <Button
                type="text"
                aria-label="退出"
                icon={<LogoutOutlined />}
                onClick={async () => {
                  await api("/auth/logout", "POST", {});
                  queryClient.removeQueries({
                    predicate: (q) => q.queryKey[0] !== "me",
                  });
                  setCsrf("");
                  queryClient.setQueryData(["me"], null);
                }}
              >
                退出
              </Button>
            </Space>
          </Layout.Header>
          <Layout.Content className="content">
            <Routes>
              <Route path="/help" element={<ManualPage />} />
              <Route path="/products/:id" element={<ProductDetail />} />
              <Route path="/purchase-orders/new" element={<PurchaseNew />} />
              <Route path="/purchase-orders/:id" element={<DocumentDetail />} />
              <Route
                path="/receipts/:id"
                element={<DocumentDetail receipt />}
              />
              {[
                "products",
                "skus",
                "suppliers",
                "warehouses",
                "categories",
                "brands",
              ].map((r) => (
                <Route
                  key={r}
                  path={"/" + r}
                  element={<MasterPage resource={r} />}
                />
              ))}
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
              <Route path="/inventory" element={<InventoryPage />} />
              <Route
                path="/inventory/transactions"
                element={<TransactionsPage />}
              />
              <Route path="/purchase-orders" element={<PurchaseList />} />
              <Route path="/receipts" element={<PurchaseList receipt />} />
              <Route
                path="/purchase-suggestions"
                element={<SuggestionsPage />}
              />
              <Route path="/users" element={<AccessPage />} />
              <Route path="/roles" element={<AccessPage roles />} />
              <Route path="/audit-logs" element={<AuditPage />} />
              <Route path="/vip" element={<VipPage />} />
              <Route path="/sops" element={<SopPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:id" element={<ProjectDetailPage />} />
              <Route path="*" element={<Navigate to="/products" replace />} />
            </Routes>
            <footer className="page-footer">
              XUTI <span>商品 · 库存 · 采购</span>
            </footer>
          </Layout.Content>
        </Layout>
      </Layout>
    </UserContext.Provider>
  );
}
function Root() {
  const me = useQuery({
    queryKey: ["me"],
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
  if (me.isLoading)
    return (
      <div className="loading">
        <Spin size="large" />
      </div>
    );
  return me.data ? <Workspace user={me.data} /> : <Login />;
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      button={{ autoInsertSpace: false }}
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#d3540b",
          colorInfo: "#d3540b",
          colorInfoBg: "#fff4e7",
          colorInfoBorder: "#ecd3b9",
          borderRadius: 7,
          fontFamily: 'Inter, "Microsoft YaHei", sans-serif',
          colorBgLayout: "#fff8f1",
          colorText: "#362a22",
        },
        components: {
          Table: {
            headerBg: "#fff2e4",
            headerColor: "#78604d",
            cellPaddingBlock: 16,
          },
          Button: { controlHeight: 36 },
        },
      }}
    >
      <App>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <Root />
          </BrowserRouter>
        </QueryClientProvider>
      </App>
    </ConfigProvider>
  </React.StrictMode>,
);
