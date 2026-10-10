import { Card, Empty, Tabs } from "antd";
import {
  BarChartOutlined,
  DatabaseOutlined,
  AppstoreOutlined,
  ArrowRightOutlined,
  FundProjectionScreenOutlined,
  InboxOutlined,
} from "@ant-design/icons";
import { Link, useSearchParams } from "react-router-dom";
import { Header, useCan } from "./shared";
import "./operations-workspace.css";

const platforms = [
  { key: "vip", label: "唯品会" },
  { key: "taobao", label: "淘宝" },
  { key: "douyin", label: "抖音" },
  { key: "jd", label: "京东" },
  { key: "pinduoduo", label: "拼多多" },
  { key: "channels", label: "视频号" },
  { key: "xiaohongshu", label: "小红书" },
  { key: "kuaishou", label: "快手" },
];
export function OperationsWorkspacePage() {
  const [params, setParams] = useSearchParams(),
    analytics = useCan("analytics.read"),
    selection = useCan("selection.read"),
    products = useCan("product.read"),
    inventory = useCan("inventory.read");
  const platform = platforms.some((p) => p.key === params.get("platform"))
    ? params.get("platform")!
    : "vip";
  const entries = [
    {
      name: "经营分析",
      href: "/analytics/compass",
      icon: <BarChartOutlined />,
      description: "销售趋势、商品排行与每日经营报告",
      visible: analytics,
    },
    {
      name: "选款登记",
      href: "/style-selections",
      icon: <DatabaseOutlined />,
      description: "选款资料登记、字段配置与团队协作",
      visible: selection,
    },
    {
      name: "商品档案",
      href: "/products",
      icon: <AppstoreOutlined />,
      description: "商品资料、字段配置与团队协作",
      visible: products,
    },
    {
      name: "竞品分析",
      href: "/analytics/competitors",
      icon: <FundProjectionScreenOutlined />,
      description: "品牌对比、价格材质分析与商品 TOP20",
      visible: analytics,
    },
    {
      name: "库存明细",
      href: "/operations/vip/inventory",
      icon: <InboxOutlined />,
      description: "分仓库存、在途数量与经营参考",
      visible: inventory,
    },
  ].filter((e) => e.visible);
  return (
    <div className="operations-workspace">
      <Header title="运营中心" subtitle="按平台查看运营工具" />
      <Tabs
        aria-label="运营平台"
        activeKey={platform}
        onChange={(key) => setParams({ platform: key })}
        items={platforms}
      />
      {platform === "vip" && entries.length ? (
        <div className="operations-entry-grid">
          {entries.map((entry) => (
            <Link
              key={entry.href}
              to={entry.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={entry.name}
              className="operations-entry-link"
            >
              <Card hoverable size="small">
                <div className="operations-entry-icon">{entry.icon}</div>
                <div>
                  <h3>{entry.name}</h3>
                  <p>{entry.description}</p>
                </div>
                <ArrowRightOutlined
                  className="operations-entry-arrow"
                  aria-hidden="true"
                />
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <div className="operations-platform-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              platform === "vip"
                ? "暂无可访问的功能，请联系管理员配置权限"
                : "暂无已配置功能入口"
            }
          />
        </div>
      )}
    </div>
  );
}
