import { useState } from "react";
import {
  App,
  Button,
  Card,
  Checkbox,
  Image,
  Popover,
  Select,
  Space,
  Table,
  Tabs,
  Tooltip,
  type TableColumnsType,
} from "antd";
import { DownloadOutlined, SettingOutlined } from "@ant-design/icons";
import {
  compassLabels,
  type CompassDimension,
  type CompassSortField,
} from "../../../packages/contracts/src/compass-analytics";
import { type Row, useUser } from "./shared";
import { downloadWorkbook } from "./sheet-excel";

type View = "custom" | "traffic" | "conversion" | "afterSales" | "inventory";
type FieldKey = CompassSortField | "lastDate";
type Field = {
  key: FieldKey;
  label: string;
  group: Exclude<View, "custom"> | "base";
  format?: "money" | "percent";
  needsTraffic?: boolean;
  note?: string;
};
const views: { key: View; label: string; note: string }[] = [
  {
    key: "custom",
    label: "自定义",
    note: "商品标识列固定在左侧；可在字段设置中选择显示内容。",
  },
  {
    key: "traffic",
    label: "流量",
    note: "曝光、商详、收藏、加购按每日累计，跨日未去重。",
  },
  {
    key: "conversion",
    label: "转化",
    note: "购买转化率按累计客户数 / 商详 UV 重算，跨日客户数未去重。",
  },
  {
    key: "afterSales",
    label: "售后",
    note: "期间退货率为退货件数 / 销售件数，可能超过 100%，不代表同批订单退货率。",
  },
  {
    key: "inventory",
    label: "库存",
    note: "库存仅取截止日快照，不累计每日库存，不改变 ERP 实物库存。",
  },
];
const fields: Field[] = [
  { key: "exposure", label: "曝光 UV", group: "traffic", needsTraffic: true },
  {
    key: "detailViews",
    label: "商详 UV",
    group: "traffic",
    needsTraffic: true,
  },
  {
    key: "clickRate",
    label: "点击率",
    group: "traffic",
    format: "percent",
    needsTraffic: true,
    note: "累计商详 UV / 累计曝光 UV",
  },
  { key: "favorites", label: "收藏人数", group: "traffic" },
  { key: "cartUsers", label: "加购 UV", group: "traffic" },
  { key: "salesAmount", label: "销售额", group: "conversion", format: "money" },
  {
    key: "netSalesAmount",
    label: "净销售额",
    group: "conversion",
    format: "money",
    note: "报表销售额（不含拒退）",
  },
  { key: "salesQty", label: "销售件数", group: "conversion" },
  {
    key: "netSalesQty",
    label: "净销售件数",
    group: "conversion",
    note: "报表销售量（不含拒退）",
  },
  { key: "customers", label: "客户数", group: "conversion" },
  {
    key: "conversionRate",
    label: "购买转化率",
    group: "conversion",
    format: "percent",
    needsTraffic: true,
    note: "累计客户数 / 累计商详 UV",
  },
  {
    key: "averagePrice",
    label: "件均价",
    group: "conversion",
    format: "money",
    note: "销售额 / 销售件数",
  },
  { key: "returnsQty", label: "退货件数", group: "afterSales" },
  {
    key: "returnRate",
    label: "期间退货率",
    group: "afterSales",
    format: "percent",
  },
  {
    key: "returnsAmount",
    label: "退货金额",
    group: "afterSales",
    format: "money",
  },
  { key: "rejectedQty", label: "拒收件数", group: "afterSales" },
  {
    key: "rejectionRate",
    label: "期间拒收率",
    group: "afterSales",
    format: "percent",
    note: "拒收件数 / 销售件数",
  },
  {
    key: "rejectedAmount",
    label: "拒收金额",
    group: "afterSales",
    format: "money",
  },
  { key: "exchangesQty", label: "换货件数", group: "afterSales" },
  {
    key: "exchangesAmount",
    label: "换货金额",
    group: "afterSales",
    format: "money",
  },
  { key: "onSaleStock", label: "截止日在售库存", group: "inventory" },
  { key: "saleableStock", label: "截止日可售库存", group: "inventory" },
  { key: "lastDate", label: "最后数据日期", group: "base" },
];
const defaultFields: FieldKey[] = [
  "salesAmount",
  "netSalesAmount",
  "salesQty",
  "returnsQty",
  "returnRate",
  "returnsAmount",
  "saleableStock",
  "lastDate",
];
type Preferences = { view: View; fields: FieldKey[]; image: boolean };
const defaults = (): Preferences => ({
  view: "custom",
  fields: [...defaultFields],
  image: true,
});
const available = (field: Field, dimension: CompassDimension) =>
  dimension !== "barcode" || !field.needsTraffic;
function readPreferences(storageKey: string): Preferences {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(storageKey) || "null",
    );
    if (!value || typeof value !== "object") return defaults();
    const input = value as Record<string, unknown>;
    if (
      !views.some((view) => view.key === input.view) ||
      !Array.isArray(input.fields) ||
      typeof input.image !== "boolean"
    )
      return defaults();
    return {
      view: input.view as View,
      fields: Array.from(
        new Set(
          input.fields.filter((key): key is FieldKey =>
            fields.some((field) => field.key === key),
          ),
        ),
      ),
      image: input.image,
    };
  } catch {
    return defaults();
  }
}
const formatNumber = (value: any) =>
  value == null
    ? "—"
    : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const formatValue = (value: any, field: Field) =>
  value == null
    ? "—"
    : field.key === "lastDate"
      ? String(value)
      : field.format === "money"
        ? "¥ " + formatNumber(value)
        : field.format === "percent"
          ? (Number(value) * 100).toFixed(2) + "%"
          : formatNumber(value);
type Props = {
  dimension: CompassDimension;
  data: Row;
  loading: boolean;
  page: number;
  sort: string;
  onPage: (page: number) => void;
  onSort: (sort: string) => void;
  onDrill: (row: Row) => void;
};
export function CompassDetailTable(props: Props) {
  const user = useUser(),
    storageKey = `compass-table-v1:${user.id}:${props.dimension}`;
  return <DetailTable key={storageKey} {...props} storageKey={storageKey} />;
}
function DetailTable({
  dimension,
  data,
  loading,
  page,
  sort,
  onPage,
  onSort,
  onDrill,
  storageKey,
}: Props & { storageKey: string }) {
  const { message } = App.useApp(),
    [preferences, setPreferences] = useState(() => readPreferences(storageKey)),
    [settingsOpen, setSettingsOpen] = useState(false),
    [draft, setDraft] = useState<Preferences>(preferences),
    [preview, setPreview] = useState<{ image: string; code: string } | null>(
      null,
    );
  const supported = fields.filter((field) => available(field, dimension));
  const visible = supported.filter((field) =>
    preferences.view === "custom"
      ? preferences.fields.includes(field.key)
      : field.group === preferences.view ||
        field.key === "lastDate" ||
        (preferences.view === "inventory" &&
          ["salesQty", "netSalesQty"].includes(field.key)),
  );
  // Preserve the user's chosen order instead of regrouping their custom view.
  if (preferences.view === "custom")
    visible.sort(
      (a, b) =>
        preferences.fields.indexOf(a.key) - preferences.fields.indexOf(b.key),
    );
  const save = (next: Preferences) => {
    setPreferences(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      message.warning("设置已应用；当前浏览器无法保存偏好。");
    }
  };
  const toggleField = (key: FieldKey, checked: boolean) =>
    setDraft((current) => ({
      ...current,
      fields: checked
        ? [...current.fields, key]
        : current.fields.filter((value) => value !== key),
    }));
  const allSelected = supported.every((field) =>
    draft.fields.includes(field.key),
  );
  const exportView = () =>
    downloadWorkbook(
      `罗盘${compassLabels[dimension]}分析_${views.find((view) => view.key === preferences.view)!.label}_${data.startDate}_${data.endDate}`,
      [
        { key: "code", label: compassLabels[dimension] },
        ...(preferences.image ? [{ key: "image", label: "商品图片链接" }] : []),
        ...visible.map((field) => ({ key: field.key, label: field.label })),
      ],
      (data.items || []).map((row: Row) => ({
        code: row.code,
        image: row.image || "",
        ...Object.fromEntries(
          visible.map((field) => [
            field.key,
            row[field.key] == null
              ? ""
              : field.format === "percent"
                ? formatValue(row[field.key], field)
                : row[field.key],
          ]),
        ),
      })),
      [
        "导出为当前视图、筛选及排序下的一页结果；三个报表独立统计，不合并相加。",
        "图片导出为原始链接；商品编码保留文本格式。库存为截止日快照。",
        "客户数与 UV 跨日未去重，比例按累计分子和分母重算。期间退货率不代表同批订单退货率。",
      ],
    );
  const columns: TableColumnsType<Row> = [
    {
      key: "code",
      title: compassLabels[dimension],
      dataIndex: "code",
      fixed: "left",
      width: preferences.image ? 220 : 180,
      render: (value, row) => (
        <div className="compass-product">
          {preferences.image && row.image && /^https:\/\//i.test(row.image) && (
            <button
              type="button"
              className="compass-image-button"
              aria-label={`放大图片 ${value}`}
              onClick={() => setPreview({ image: row.image, code: value })}
            >
              <img
                src={row.image}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            </button>
          )}
          <div>
            <Button type="link" onClick={() => onDrill(row)}>
              {value}
            </Button>
            {dimension !== "style" && (
              <small>
                {row.styleNo}
                {row.sizes ? ` · ${row.sizes}` : ""}
              </small>
            )}
          </div>
        </div>
      ),
    },
    ...visible.map((field): TableColumnsType<Row>[number] => ({
      key: field.key,
      title: field.note ? (
        <Tooltip title={field.note}>
          <span>{field.label}</span>
        </Tooltip>
      ) : (
        field.label
      ),
      dataIndex: field.key,
      width:
        field.key === "lastDate"
          ? 140
          : Math.max(125, field.label.length * 14 + 50),
      render: (value) => formatValue(value, field),
      ...(field.key === "lastDate"
        ? {}
        : {
            sorter: true,
            sortDirections: ["descend"],
            sortOrder: sort === field.key ? "descend" : null,
          }),
    })),
  ];
  return (
    <Card
      className="compass-detail-card"
      title={`${compassLabels[dimension]}明细`}
      extra={
        <Space wrap>
          <Select
            aria-label="明细排序"
            value={sort}
            style={{ width: 190 }}
            onChange={onSort}
            showSearch={{ optionFilterProp: "label" }}
            options={supported
              .filter((field) => field.key !== "lastDate")
              .map((field) => ({
                value: field.key,
                label: `按${field.label}排序`,
              }))}
          />
          <Button
            icon={<DownloadOutlined aria-hidden="true" />}
            disabled={!data.items?.length}
            onClick={() => void exportView()}
          >
            导出当前页
          </Button>
        </Space>
      }
    >
      <div className="compass-detail-toolbar">
        <Tabs
          aria-label="明细数据视图"
          size="small"
          activeKey={preferences.view}
          items={views.map(({ key, label }) => ({ key, label }))}
          onChange={(view) => save({ ...preferences, view: view as View })}
        />
        {preferences.view === "custom" && (
          <Popover
            trigger="click"
            placement="bottom"
            open={settingsOpen}
            onOpenChange={(open) => {
              setSettingsOpen(open);
              if (open)
                setDraft({ ...preferences, fields: [...preferences.fields] });
            }}
            content={
              <div
                className="compass-field-settings"
                role="dialog"
                aria-label="明细字段设置"
              >
                <strong>显示字段</strong>
                <p className="secondary">
                  商品标识列固定显示。设置按账号和报表维度保存在当前浏览器。
                </p>
                <Checkbox
                  checked={allSelected}
                  indeterminate={
                    !allSelected &&
                    supported.some((field) => draft.fields.includes(field.key))
                  }
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      fields: event.target.checked
                        ? supported.map((field) => field.key)
                        : [],
                    })
                  }
                >
                  全选数据字段
                </Checkbox>
                <div className="compass-field-groups">
                  <section>
                    <h4>基础信息</h4>
                    <Checkbox
                      checked={draft.image}
                      onChange={(event) =>
                        setDraft({ ...draft, image: event.target.checked })
                      }
                    >
                      商品图片
                    </Checkbox>
                    <Checkbox
                      checked={draft.fields.includes("lastDate")}
                      onChange={(event) =>
                        toggleField("lastDate", event.target.checked)
                      }
                    >
                      最后数据日期
                    </Checkbox>
                  </section>
                  {views
                    .filter((view) => view.key !== "custom")
                    .map((view) => (
                      <section key={view.key}>
                        <h4>{view.label}</h4>
                        {fields
                          .filter((field) => field.group === view.key)
                          .map((field) => (
                            <Tooltip
                              key={field.key}
                              title={
                                available(field, dimension)
                                  ? field.note
                                  : "原始条码报表未提供该字段"
                              }
                            >
                              <Checkbox
                                disabled={!available(field, dimension)}
                                checked={
                                  available(field, dimension) &&
                                  draft.fields.includes(field.key)
                                }
                                onChange={(event) =>
                                  toggleField(field.key, event.target.checked)
                                }
                              >
                                {field.label}
                              </Checkbox>
                            </Tooltip>
                          ))}
                      </section>
                    ))}
                </div>
                <div className="compass-field-actions">
                  <Button onClick={() => setDraft(defaults())}>恢复默认</Button>
                  <Space>
                    <Button onClick={() => setSettingsOpen(false)}>取消</Button>
                    <Button
                      type="primary"
                      onClick={() => {
                        save({ ...draft, view: "custom" });
                        setSettingsOpen(false);
                      }}
                    >
                      应用
                    </Button>
                  </Space>
                </div>
              </div>
            }
          >
            <Button icon={<SettingOutlined aria-hidden="true" />}>
              字段设置
            </Button>
          </Popover>
        )}
      </div>
      <p className="compass-view-note">
        {views.find((view) => view.key === preferences.view)!.note}
        {dimension === "barcode" &&
          ["traffic", "conversion"].includes(preferences.view) &&
          " 条码报表未提供曝光、商详 UV 及相关比例，仅展示已有指标。"}
      </p>
      <Table<Row>
        rowKey="code"
        size="small"
        className="compass-detail-table"
        dataSource={data.items}
        loading={loading}
        columns={columns}
        scroll={{
          x: columns.reduce(
            (sum, column) => sum + Number(column.width || 130),
            0,
          ),
        }}
        pagination={{
          current: page,
          pageSize: 20,
          total: data.total,
          showSizeChanger: false,
          onChange: onPage,
        }}
        onChange={(_pagination, _filters, sorter, info) => {
          if (info.action === "sort") {
            const selected = Array.isArray(sorter) ? sorter[0] : sorter;
            if (selected.columnKey) onSort(String(selected.columnKey));
          }
        }}
      />
      <Image.PreviewGroup
        items={
          preview
            ? [
                {
                  src: preview.image,
                  alt: `商品图片 ${preview.code}`,
                  referrerPolicy: "no-referrer",
                },
              ]
            : []
        }
        classNames={{ popup: { root: "compass-image-preview" } }}
        preview={{
          open: preview !== null,
          onOpenChange: (open) => {
            if (!open) setPreview(null);
          },
        }}
      />
    </Card>
  );
}
