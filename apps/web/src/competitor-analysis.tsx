import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popover,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
} from "antd";
import {
  DownloadOutlined,
  PlusOutlined,
  ReloadOutlined,
  LinkOutlined,
  UploadOutlined,
  PictureOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, queryClient } from "./api";
import { Header, useCan, when } from "./shared";
import {
  analyzeCompetitor,
  competitorPriceBands,
  type CompetitorBrand,
  type CompetitorSource,
  type CompetitorProduct,
  type CompetitorProductPreview,
} from "../../../packages/contracts/src/competitor-analysis";
import {
  CompassProductImage,
  CompassImagePreview,
  type CompassImageTarget,
} from "./compass-product-image";
import { captureBookmarkUrl } from "./competitor-capture";
import { readCompetitorFile } from "./competitor-import";
import { downloadSheet } from "./download-sheet";
import {
  CompetitorCrawlPanel,
  type CompetitorCrawlStatus,
} from "./competitor-crawl";
import "./competitor-analysis.css";

type Result = ReturnType<typeof analyzeCompetitor>;
type Dashboard = {
  crawl: CompetitorCrawlStatus;
  source: CompetitorSource;
  brands: CompetitorBrand[];
  alignedPeriod: boolean;
  options: { categories: string[]; materials: string[]; seasons: string[] };
  results: Result[];
};
const number = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const money = (v: number | null | undefined) =>
  v == null ? "—" : "¥ " + number(v);
const colors = [
  "#e97c3c",
  "#8b9d7e",
  "#798eaa",
  "#b99478",
  "#a794b0",
  "#c5a04a",
  "#7ea6a0",
  "#ae7c7c",
];
function ProductPhoto({
  product,
  onPreview,
}: {
  product: CompetitorProduct;
  onPreview: (target: CompassImageTarget) => void;
}) {
  return (
    <span className="competitor-photo">
      <CompassProductImage
        image={product.imageUrl || undefined}
        code={product.styleCode || product.title}
        onPreview={onPreview}
      />
    </span>
  );
}
function DistributionPreview({
  products,
}: {
  products: CompetitorProductPreview[];
}) {
  return (
    <div className="competitor-bar-products">
      {products.map((p) => (
        <a
          key={p.productId}
          href={p.productUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`打开${p.title}商品详情`}
        >
          {p.imageUrl ? (
            <img
              src={p.imageUrl}
              alt={p.title}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="competitor-bar-placeholder">
              <PictureOutlined aria-hidden="true" />
            </span>
          )}
          <span>{p.styleCode || p.title}</span>
          <strong>{money(p.salePrice)}</strong>
        </a>
      ))}
    </div>
  );
}
function Distribution({
  title,
  field,
  results,
  activePreview,
  onPreviewChange,
}: {
  title: string;
  field: "categories" | "materials" | "prices" | "seasons";
  results: Result[];
  activePreview: string | null;
  onPreviewChange: (key: string, open: boolean) => void;
}) {
  const combined = new Map<string, number>();
  results.forEach((r) =>
    r[field].forEach((x) =>
      combined.set(x.name, (combined.get(x.name) || 0) + x.count),
    ),
  );
  const labels = [...combined]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map((x) => x[0]);
  const max = Math.max(
    1,
    ...results.flatMap((r) => r[field].map((x) => x.count)),
  );
  return (
    <Card size="small" title={title} className="competitor-distribution">
      {labels.length ? (
        <div role="group" aria-label={`${title}，按品牌比较当前样本`}>
          {labels.map((name) => (
            <div className="competitor-bar-group" key={name}>
              <strong>{name}</strong>
              {results.map((r, i) => {
                const bucket = r[field].find((x) => x.name === name);
                const count = bucket?.count || 0;
                const previewKey = `${field}:${r.brand.id}:${name}`;
                return (
                  <Popover
                    key={r.brand.id}
                    trigger={["hover", "click"]}
                    placement="top"
                    mouseEnterDelay={0.15}
                    mouseLeaveDelay={0.25}
                    title={`${r.brand.name} · ${name} · 前${bucket?.top10?.length || 0}款`}
                    content={
                      <DistributionPreview products={bucket?.top10 || []} />
                    }
                    classNames={{ root: "competitor-bar-popover" }}
                    open={count > 0 && activePreview === previewKey}
                    onOpenChange={(open) => onPreviewChange(previewKey, open)}
                  >
                    <button
                      type="button"
                      className="competitor-bar-row"
                      disabled={!count}
                      aria-label={`${r.brand.name} · ${name}，${count}款，查看前10款商品`}
                    >
                      <span>{r.brand.name}</span>
                      <span className="competitor-bar-track" aria-hidden="true">
                        <i
                          style={{
                            width: (count / max) * 100 + "%",
                            background: colors[i % colors.length],
                          }}
                        />
                      </span>
                      <b>{count}</b>
                    </button>
                  </Popover>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无已采集数据"
        />
      )}
    </Card>
  );
}
function CaptureGuide({
  open,
  onClose,
  brands,
}: {
  open: boolean;
  onClose: () => void;
  brands: CompetitorBrand[];
}) {
  const linkRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (open && linkRef.current)
      linkRef.current.setAttribute("href", captureBookmarkUrl());
  }, [open]);
  return (
    <Drawer title="采集唯品会公开商品" open={open} onClose={onClose} size={520}>
      <p>
        将下面按钮拖到浏览器书签栏。工具仅提取当前页的公开商品信息并下载 JSON
        文件，不读取账号信息。
      </p>
      <a
        ref={linkRef}
        className="competitor-bookmark"
        draggable
        onClick={(e) => {
          e.preventDefault();
        }}
      >
        采集唯品会商品
      </a>
      <ol>
        <li>打开品牌页面，在「品牌」筛选中点击该品牌，再选择「销量」排序。</li>
        <li>
          向下滚动，让需要分析的商品完成加载。点击书签栏中的「采集唯品会商品」，保存排名文件。
        </li>
        <li>
          逐款打开已采集样本的商品详情页（每品牌50款），查看「规格参数」，再点击同一书签，保存详细材质与季节文件。
        </li>
        <li>
          回到竞品分析，点击「导入数据」，选择对应品牌，上传排名文件；然后可一次上传多个详情文件，补齐成分信息。
        </li>
      </ol>
      <Alert
        type="info"
        showIcon
        title="公开销量排名按品牌分别比较，不推算销售件数。品类及材质筛选只作用于已采集样本；页面未公开的详细成分显示「未公开」。"
      />
      <div className="competitor-source-links">
        {brands.map((b) => (
          <a
            key={b.id}
            href={b.searchUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {b.name}
            <LinkOutlined />
          </a>
        ))}
      </div>
    </Drawer>
  );
}
function ImportPanel({
  open,
  onClose,
  brands,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  brands: CompetitorBrand[];
  onImported: () => void;
}) {
  const { message } = App.useApp(),
    [brandId, setBrandId] = useState<string>(),
    [files, setFiles] = useState<File[]>([]),
    [prepared, setPrepared] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [phase, setPhase] = useState("");
  const brand = brands.find((x) => x.id === brandId) || brands[0];
  useEffect(() => {
    setPrepared([]);
    setError("");
    setFiles([]);
    setPhase("");
  }, [open, brandId]);
  async function choose(selected: File[]) {
    setFiles(selected);
    setPrepared([]);
    setError("");
    setBusy(true);
    try {
      if (!brand) throw Error("请先选择品牌");
      const loaded = [];
      for (const file of selected) {
        if (!file.name.toLowerCase().endsWith(".json"))
          throw Error("请选择公开商品采集的 JSON 文件");
        const data = await readCompetitorFile(file, brand);
        if (
          data.kind === "SALES" ||
          (data.kind === "LIST" && data.source !== "PUBLIC_RANK")
        )
          throw Error("仅支持公开销量排名和商品详情文件");
        loaded.push(data);
      }
      setPrepared(loaded);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      for (let i = 0; i < prepared.length; i++) {
        const data = prepared[i];
        setPhase(`导入 ${i + 1}/${prepared.length}：${files[i].name}`);
        const { kind, ...body } = data;
        if (kind === "DETAILS")
          await api("/analytics/competitors/details", "POST", body);
        else await api("/analytics/competitors/imports", "POST", body);
        onImported();
      }
      setPhase("全部导入完成");
      message.success("竞品数据已更新");
      setPrepared([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      title="导入竞品数据"
      onCancel={() => !busy && onClose()}
      width={640}
      footer={
        <Space>
          <Button disabled={busy} onClick={onClose}>
            关闭
          </Button>
          <Button
            type="primary"
            loading={busy}
            disabled={!prepared.length || !!error}
            onClick={() => void save()}
          >
            确认导入
          </Button>
        </Space>
      }
      maskClosable={!busy}
      closable={!busy}
    >
      <Form layout="vertical">
        <Form.Item label="所属品牌">
          <Select
            aria-label="导入数据所属品牌"
            value={brand?.id}
            disabled={busy}
            onChange={setBrandId}
            options={brands.map((b) => ({ value: b.id, label: b.name }))}
          />
        </Form.Item>
        <p>
          支持公开销量排名和商品详情 JSON
          文件。每个文件最多5MB、5000款商品，数据日期不能晚于今天。
        </p>
        <Space wrap>
          <label className="competitor-file-button">
            <UploadOutlined aria-hidden="true" /> 选择文件
            <input
              aria-label="选择竞品数据文件"
              type="file"
              accept=".json"
              multiple
              disabled={busy}
              onChange={(e) => void choose(Array.from(e.target.files || []))}
            />
          </label>
        </Space>
        {prepared.map((p, i) => (
          <p key={i}>
            {files[i].name} · {p.products.length}款 ·{" "}
            {p.kind === "DETAILS" ? "补充详情材质" : "公开销量排名"}
          </p>
        ))}
        {phase && <p>{phase}</p>}
        {error && <Alert type="error" showIcon title={error} />}
      </Form>
    </Modal>
  );
}
export function CompetitorAnalysisPage() {
  const canRead = useCan("analytics.read"),
    manage = useCan("analytics.manage"),
    { message } = App.useApp();
  const [mode, setMode] = useState("multi"),
    [selected, setSelected] = useState<string[]>([]),
    [filters, setFilters] = useState<Record<string, string>>({}),
    [keyword, setKeyword] = useState(""),
    [search, setSearch] = useState(""),
    [active, setActive] = useState<string>(),
    [capture, setCapture] = useState(false),
    [crawlSettings, setCrawlSettings] = useState(false),
    [queuing, setQueuing] = useState(false),
    [importOpen, setImportOpen] = useState(false),
    [addOpen, setAddOpen] = useState(false),
    [adding, setAdding] = useState(false),
    [addError, setAddError] = useState("");
  const [preview, setPreview] = useState<CompassImageTarget | null>(null);
  const [distributionPreview, setDistributionPreview] = useState<string | null>(
    null,
  );
  const top20Ref = useRef<HTMLDivElement>(null);
  const sortOpen = useRef(false);
  const sortAnchor = useRef<{
    panelTop: number;
    pageX: number;
    tableTop: number;
    tableLeft: number;
    pending: boolean;
  } | null>(null);
  const captureSortAnchor = () => {
    const panel = top20Ref.current;
    if (!panel) return;
    const body = panel.querySelector(".ant-table-body");
    sortAnchor.current = {
      panelTop: panel.getBoundingClientRect().top,
      pageX: window.scrollX,
      tableTop: body?.scrollTop || 0,
      tableLeft: body?.scrollLeft || 0,
      pending: false,
    };
  };
  const [form] = Form.useForm();
  useEffect(() => {
    const t = setTimeout(() => setSearch(keyword.trim()), 300);
    return () => clearTimeout(t);
  }, [keyword]);
  const q = useQuery<Dashboard>({
    queryKey: ["competitor-dashboard", selected, filters, search],
    enabled: canRead,
    // Keep the panels mounted so a new filter cannot collapse the page scroll range.
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      query.state.data?.crawl.jobs.some((j) =>
        ["QUEUED", "RUNNING"].includes(j.status),
      )
        ? 5000
        : 60000,
    queryFn: async () =>
      (
        await api(
          "/analytics/competitors?" +
            new URLSearchParams({
              source: "PUBLIC_RANK",
              ...filters,
              ...(selected.length ? { brandIds: selected.join(",") } : {}),
              ...(search ? { keyword: search } : {}),
            }),
        )
      ).data,
  });
  const data = q.data,
    brands = data?.brands || [],
    own = brands.find((b) => b.isOwn),
    competitors = brands.filter((b) => !b.isOwn),
    results = data?.results || [];
  const current = results.find((r) => r.brand.id === active) || results[0];
  useLayoutEffect(() => {
    const anchor = sortAnchor.current;
    if (!anchor?.pending) return;
    const restore = () => {
      const panel = top20Ref.current;
      if (!panel || sortAnchor.current !== anchor) return;
      window.scrollTo({
        left: anchor.pageX,
        top:
          window.scrollY + panel.getBoundingClientRect().top - anchor.panelTop,
        behavior: "instant",
      });
      panel.querySelector(".ant-table-body")?.scrollTo({
        top: anchor.tableTop,
        left: anchor.tableLeft,
        behavior: "instant",
      });
    };
    restore();
    const frame = requestAnimationFrame(() => {
      restore();
      if (!q.isFetching && !q.isPlaceholderData) sortAnchor.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [filters, q.data, q.isFetching, q.isPlaceholderData]);
  useEffect(() => {
    // Respect a user's new scroll intent while a slow request is pending.
    const release = () => {
      sortAnchor.current = null;
    };
    window.addEventListener("wheel", release, { passive: true });
    window.addEventListener("touchmove", release, { passive: true });
    return () => {
      window.removeEventListener("wheel", release);
      window.removeEventListener("touchmove", release);
    };
  }, []);
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["competitor-dashboard"] });
  async function crawl() {
    setQueuing(true);
    try {
      const ids = results.map((r) => r.brand.id);
      if (!ids.length) return;
      const requested = await api("/analytics/competitors/crawl", "POST", {
        brandIds: ids,
      });
      refresh();
      if (
        requested.data.jobs.some((job: { status: string }) =>
          ["QUEUED", "RUNNING"].includes(job.status),
        )
      )
        message.success("后台采集已排队，可继续使用页面");
      else message.info("5分钟内已有采集记录，可查看采集状态后再更新");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setQueuing(false);
    }
  }
  const setFilter = (key: string, value?: string) =>
    setFilters((old) => {
      const next = { ...old };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  async function add() {
    try {
      const b = await form.validateFields();
      setAdding(true);
      setAddError("");
      await api("/analytics/competitors/brands", "POST", {
        name: b.name,
        brandSn: b.brandSn || null,
      });
      setAddOpen(false);
      form.resetFields();
      refresh();
      message.success("品牌已添加");
    } catch (e) {
      if (e instanceof Error) setAddError(e.message);
    } finally {
      setAdding(false);
    }
  }
  const columns = [
    {
      title: "排名",
      dataIndex: "publicRank",
      width: 64,
      render: number,
    },
    {
      title: "商品",
      key: "product",
      width: 340,
      render: (_v: unknown, p: CompetitorProduct) => (
        <div className="competitor-product">
          <ProductPhoto product={p} onPreview={setPreview} />
          <div>
            <a href={p.productUrl} target="_blank" rel="noopener noreferrer">
              {p.title}
            </a>
            {p.styleCode && <small>{p.styleCode}</small>}
          </div>
        </div>
      ),
    },
    {
      title: "特卖价",
      dataIndex: "salePrice",
      width: 105,
      render: (v: number | null) => <strong>{money(v)}</strong>,
    },
    {
      title: "品类 / 季节",
      key: "category",
      width: 155,
      render: (_v: unknown, p: CompetitorProduct) => (
        <div>
          {p.category || "按标题分类"}
          <small>{p.seasons.join("、") || "季节未公开"}</small>
        </div>
      ),
    },
    {
      title: "详细材质信息",
      key: "material",
      width: 330,
      render: (_v: unknown, p: CompetitorProduct) => (
        <div className="competitor-material">
          {p.materialInfo || (
            <span className="competitor-muted">未公开 / 待补充详情</span>
          )}
          {p.detailObservedAt && (
            <small>详情核对：{when(p.detailObservedAt)}</small>
          )}
        </div>
      ),
    },
    {
      title: "详情",
      key: "link",
      width: 76,
      render: (_v: unknown, p: CompetitorProduct) => (
        <a
          href={p.productUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`打开${p.title}商品详情`}
        >
          <LinkOutlined /> 查看
        </a>
      ),
    },
  ];
  if (!canRead)
    return <Alert type="warning" title="当前账号没有经营分析查看权限" />;
  return (
    <div className="competitor-page">
      <Header
        title="竞品分析"
        subtitle="唯品会 · 我的品牌与竞品对比"
        extra={
          <>
            <Button
              icon={<ReloadOutlined aria-hidden="true" />}
              loading={q.isFetching}
              onClick={() => void q.refetch()}
            >
              刷新
            </Button>
            {manage && (
              <>
                <Button
                  type="primary"
                  icon={<ReloadOutlined aria-hidden="true" />}
                  loading={queuing}
                  disabled={!results.length}
                  onClick={() => void crawl()}
                >
                  更新竞品数据
                </Button>
                <Button
                  icon={<SettingOutlined aria-hidden="true" />}
                  disabled={!data}
                  onClick={() => setCrawlSettings(true)}
                >
                  采集设置
                </Button>
                <Button
                  icon={<UploadOutlined aria-hidden="true" />}
                  onClick={() => setImportOpen(true)}
                >
                  导入数据
                </Button>
                <Button
                  icon={<PlusOutlined aria-hidden="true" />}
                  onClick={() => {
                    setAddOpen(true);
                    setAddError("");
                  }}
                >
                  新增品牌
                </Button>
              </>
            )}
          </>
        }
      />
      <CompetitorCrawlPanel
        data={data?.crawl}
        brands={brands}
        manage={manage}
        open={crawlSettings}
        onClose={() => setCrawlSettings(false)}
        onRefresh={refresh}
        onCapture={() => setCapture(true)}
      />
      <Card size="small" className="competitor-filters">
        <div className="competitor-brand-line">
          <Tag color="orange">我的品牌 · {own?.name || "序缇"}</Tag>
          <Segmented
            aria-label="品牌对比模式"
            value={mode}
            options={[
              { label: "单品牌对比", value: "single" },
              { label: "多品牌对比", value: "multi" },
            ]}
            onChange={(v) => {
              setMode(v);
              if (own) {
                const ids = selected.filter((x) => x !== own.id);
                setSelected([
                  own.id,
                  ...(v === "single"
                    ? ids.slice(0, 1).length
                      ? ids.slice(0, 1)
                      : competitors.slice(0, 1).map((x) => x.id)
                    : ids),
                ]);
              }
            }}
          />
          <Select
            aria-label="选择竞品品牌"
            mode={mode === "multi" ? "multiple" : undefined}
            value={
              mode === "multi"
                ? selected.length
                  ? selected.filter((x) => x !== own?.id)
                  : competitors.slice(0, 6).map((x) => x.id)
                : selected.find((x) => x !== own?.id) || competitors[0]?.id
            }
            onChange={(v) =>
              own &&
              setSelected([own.id, ...(Array.isArray(v) ? v : v ? [v] : [])])
            }
            options={competitors.map((b) => ({ value: b.id, label: b.name }))}
            maxTagCount="responsive"
            maxCount={11}
            className="competitor-brand-select"
            placeholder="选择竞品，最多11个"
          />
        </div>
        <div className="competitor-facet-line">
          {(
            [
              ["category", "品类", data?.options.categories],
              ["material", "材质", data?.options.materials],
              ["season", "季节", data?.options.seasons],
            ] as const
          ).map(([key, label, options]) => (
            <Select
              key={key}
              aria-label={`筛选${label}`}
              placeholder={`全部${label}`}
              value={filters[key]}
              onChange={(v) => setFilter(key, v)}
              allowClear
              options={(options || []).map((x) => ({ value: x, label: x }))}
            />
          ))}
          <Select
            aria-label="筛选价格区间"
            placeholder="全部价格区间"
            value={filters.priceBand}
            onChange={(v) => setFilter("priceBand", v)}
            allowClear
            options={competitorPriceBands.map((b) => ({
              value: b.key,
              label: b.label,
            }))}
          />
          <Input
            aria-label="搜索竞品商品"
            placeholder="搜索商品 / 款号"
            allowClear
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: 200 }}
          />
          <Button
            type="text"
            onClick={() => {
              setFilters({});
              setKeyword("");
            }}
          >
            重置筛选
          </Button>
        </div>
      </Card>
      <p className="competitor-scope-note">
        公开排名按品牌分别统计，未公开实际销售件数。分析范围为已采集商品，详细材质以规格参数为准；未补齐详情时，品类和材质标签仅按标题识别。
      </p>
      {q.isLoading && <Spin />}
      {q.error && (
        <Alert type="error" showIcon title={(q.error as Error).message} />
      )}{" "}
      {data && !data.alignedPeriod && (
        <Alert
          type="warning"
          showIcon
          title="品牌的数据日期不同，请更新到相同日期后评估差异。当前各品牌独立展示。"
        />
      )}
      {!!data && (
        <>
          <div className="competitor-metrics">
            <Card size="small">
              <span>对比品牌</span>
              <strong>{results.length}</strong>
              <small>含我的品牌</small>
            </Card>
            <Card size="small">
              <span>当前商品样本</span>
              <strong>
                {number(results.reduce((n, r) => n + r.total, 0))}
              </strong>
              <small>筛选后已采集商品</small>
            </Card>
            <Card size="small">
              <span>我的品牌价格中位数</span>
              <strong>
                {money(results.find((r) => r.brand.isOwn)?.medianPrice)}
              </strong>
              <small>仅统计有特卖价的商品</small>
            </Card>
            <Card size="small">
              <span>详细材质已补齐</span>
              <strong>
                {number(results.reduce((n, r) => n + r.materialCoverage, 0))}
              </strong>
              <small>以商品规格参数核对</small>
            </Card>
          </div>
          <Card size="small" title="品牌概览">
            <Table
              rowKey={(r) => r.brand.id}
              pagination={false}
              size="small"
              dataSource={results}
              scroll={{ x: 900 }}
              columns={[
                {
                  title: "品牌",
                  render: (_v, r) => (
                    <Space>
                      {r.brand.name}
                      {r.brand.isOwn && <Tag color="orange">我的品牌</Tag>}
                    </Space>
                  ),
                },
                {
                  title: "样本款数",
                  render: (_v, r) => `${r.total} / ${r.captured}`,
                },
                {
                  title: "特卖价中位数",
                  render: (_v, r) => money(r.medianPrice),
                },
                {
                  title: "价格范围",
                  render: (_v, r) =>
                    r.minPrice === null
                      ? "—"
                      : `${money(r.minPrice)}–${money(r.maxPrice)}`,
                },
                {
                  title: "材质完整",
                  render: (_v, r) => `${r.materialCoverage} / ${r.total}`,
                },
                {
                  title: "数据日期",
                  render: (_v, r) =>
                    r.snapshot ? r.snapshot.asOfDate : "未采集",
                },
              ]}
            />
          </Card>
          <div className="competitor-charts">
            {(
              [
                ["品类分布", "categories"],
                ["特卖价区间", "prices"],
                ["材质分布", "materials"],
                ["季节分布", "seasons"],
              ] as const
            ).map(([title, field]) => (
              <Distribution
                key={field}
                title={title}
                field={field}
                results={results}
                activePreview={distributionPreview}
                onPreviewChange={(key, open) =>
                  setDistributionPreview((old) =>
                    open ? key : old === key ? null : old,
                  )
                }
              />
            ))}
          </div>
          <Card
            size="small"
            title="商品 TOP20"
            className="competitor-top20"
            ref={top20Ref}
            extra={
              <Space>
                <span
                  onPointerDownCapture={(event) => {
                    // The option menu is a portal: its React events also bubble
                    // here, but must not replace the anchor before the menu opened.
                    if (
                      !sortOpen.current &&
                      event.currentTarget.contains(event.target as Node)
                    )
                      captureSortAnchor();
                  }}
                  onKeyDownCapture={(event) => {
                    if (
                      !sortOpen.current &&
                      event.currentTarget.contains(event.target as Node)
                    )
                      captureSortAnchor();
                  }}
                >
                  <Select
                    aria-label="TOP20排序指标"
                    value={filters.sort || "rank"}
                    onOpenChange={(open) => {
                      sortOpen.current = open;
                      if (open && !sortAnchor.current) captureSortAnchor();
                      if (!open && !sortAnchor.current?.pending)
                        sortAnchor.current = null;
                    }}
                    onChange={(v) => {
                      if (!sortAnchor.current) captureSortAnchor();
                      if (sortAnchor.current) sortAnchor.current.pending = true;
                      setFilter("sort", v);
                    }}
                    options={[
                      {
                        value: "rank",
                        label: "公开销量排名",
                      },
                      { value: "priceAsc", label: "特卖价从低到高" },
                      { value: "priceDesc", label: "特卖价从高到低" },
                    ]}
                  />
                </span>
                <Button
                  icon={<DownloadOutlined aria-hidden="true" />}
                  disabled={q.isFetching || !current?.top20.length}
                  onClick={() =>
                    current &&
                    void downloadSheet(
                      `${current.brand.name}-竞品TOP20`,
                      current.top20.map((p) => ({
                        品牌: current.brand.name,
                        公开排名: p.publicRank,
                        商品名称: p.title,
                        款号: p.styleCode,
                        特卖价: p.salePrice,
                        品类: p.category,
                        详细材质信息: p.materialInfo,
                        季节: p.seasons.join("、"),
                        预览图链接: p.imageUrl,
                        商品详情链接: p.productUrl,
                      })),
                    )
                  }
                >
                  导出TOP20
                </Button>
              </Space>
            }
          >
            <Tabs
              aria-label="品牌商品排行"
              activeKey={current?.brand.id}
              onChange={setActive}
              items={results.map((r) => ({
                key: r.brand.id,
                label: r.brand.name,
              }))}
            />
            <div className="competitor-top20-content" aria-busy={q.isFetching}>
              {current?.snapshot ? (
                <>
                  <p className="competitor-scope-note">
                    {current.snapshot.scope} · 数据日期{" "}
                    {current.snapshot.asOfDate} · 更新于{" "}
                    {when(current.snapshot.createdAt)}
                    {current.snapshot.sourceUrl && (
                      <>
                        {" "}
                        ·{" "}
                        <a
                          href={current.snapshot.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          查看榜单来源
                        </a>
                      </>
                    )}
                  </p>
                  <Table
                    rowKey="productId"
                    dataSource={current.top20}
                    columns={columns}
                    size="small"
                    loading={q.isFetching}
                    pagination={false}
                    scroll={{
                      x: 1250,
                      y: 560,
                      scrollToFirstRowOnChange: false,
                    }}
                    locale={{ emptyText: "当前筛选没有匹配商品" }}
                  />
                </>
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="该品牌尚未采集数据"
                >
                  <a
                    href={current?.brand.searchUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    打开唯品会品牌页
                  </a>
                  {manage && (
                    <Button
                      type="primary"
                      loading={queuing}
                      onClick={() => void crawl()}
                      style={{ marginLeft: 12 }}
                    >
                      后台采集
                    </Button>
                  )}
                </Empty>
              )}
            </div>
          </Card>
        </>
      )}
      <CaptureGuide
        open={capture}
        onClose={() => setCapture(false)}
        brands={brands}
      />
      <CompassImagePreview target={preview} onClose={() => setPreview(null)} />
      <ImportPanel
        open={importOpen}
        onClose={() => setImportOpen(false)}
        brands={brands}
        onImported={refresh}
      />
      <Modal
        title="新增竞品品牌"
        open={addOpen}
        onCancel={() => !adding && setAddOpen(false)}
        onOk={() => void add()}
        confirmLoading={adding}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="品牌名称"
            rules={[{ required: true, message: "请填写品牌名称" }, { max: 40 }]}
          >
            <Input aria-label="新增竞品品牌名称" placeholder="例如：兔皇" />
          </Form.Item>
          <Form.Item
            name="brandSn"
            label="唯品会品牌ID（选填）"
            rules={[{ pattern: /^\d{1,20}$/, message: "品牌ID须为数字" }]}
          >
            <Input placeholder="品牌筛选链接中的 brand_sn" />
          </Form.Item>
        </Form>
        {addError && <Alert type="error" title={addError} />}
      </Modal>
    </div>
  );
}
