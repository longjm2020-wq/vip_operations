import { useEffect, useState } from "react";
import {
  App,
  Button,
  Card,
  Checkbox,
  Popover,
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
} from "../../../packages/contracts/src/compass-analytics";
import { type Row, useUser } from "./shared";
import { downloadWorkbook } from "./sheet-excel";
import {
  CompassProductImage,
  CompassImagePreview,
} from "./compass-product-image";

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
import {
  fields,
  views,
  available,
  formatValue,
  formatNumber,
  type View,
  type FieldKey,
} from "./compass-detail-fields";
import {
  CompassMiniTrend,
  CompassEntityTrend,
  miniMetricForView,
} from "./compass-entity-trend";

type Props = {
  dimension: CompassDimension;
  data: Row;
  loading: boolean;
  invalidSearch?: boolean;
  page: number;
  pageSize: number;
  sort: string;
  onPage: (page: number, pageSize: number) => void;
  onSort: (sort: string) => void;
  onDrill: (row: Row) => void;
  onMiniMetric: (metric: string) => void;
  styleNo: string;
  articleNo: string;
  search: string;
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
  invalidSearch = false,
  page,
  pageSize,
  sort,
  onPage,
  onSort,
  onDrill,
  onMiniMetric,
  styleNo,
  articleNo,
  search,
  storageKey,
}: Props & { storageKey: string }) {
  const { message } = App.useApp(),
    [preferences, setPreferences] = useState(() => readPreferences(storageKey)),
    [settingsOpen, setSettingsOpen] = useState(false),
    [draft, setDraft] = useState<Preferences>(preferences),
    [preview, setPreview] = useState<{ image: string; code: string } | null>(
      null,
    ),
    [trendRow, setTrendRow] = useState<Row | null>(null);
  useEffect(() => {
    onMiniMetric(miniMetricForView(preferences.view, dimension));
  }, [preferences.view, dimension, onMiniMetric]);
  const supported = fields.filter((field) => available(field, dimension));
  const visible = supported.filter((field) =>
    preferences.view === "custom"
      ? preferences.fields.includes(field.key)
      : field.group === preferences.view ||
        field.key === "lastDate" ||
        (preferences.view === "inventory" &&
          ["salesQty", "netSalesQty", "saleAge", "firstListedAt"].includes(
            field.key,
          )),
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
      width: preferences.image ? 308 : 268,
      render: (value, row) => (
        <div className="compass-product">
          {preferences.image && (
            <CompassProductImage
              image={row.image}
              code={value}
              onPreview={setPreview}
            />
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
          <CompassMiniTrend
            row={row}
            metric={
              data.miniMetric || miniMetricForView(preferences.view, dimension)
            }
            startDate={data.startDate}
            endDate={data.endDate}
            onClick={() => setTrendRow(row)}
          />
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
        field.key === "firstListedAt"
          ? 180
          : field.key === "lastDate"
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
          <Button
            icon={<DownloadOutlined aria-hidden="true" />}
            disabled={loading || invalidSearch || !data.items?.length}
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
          scrollToFirstRowOnChange: false,
          y: "min(560px, 60vh)",
          x: columns.reduce(
            (sum, column) => sum + Number(column.width || 130),
            0,
          ),
        }}
        pagination={{
          current: page,
          pageSize,
          total: data.total,
          showTotal: (total) => `共 ${formatNumber(total)} 条`,
          showSizeChanger: { "aria-label": "明细每页条数" },
          pageSizeOptions: [20, 50, 100, 200, 500, 1000],
          responsive: true,
          onChange: onPage,
        }}
        onChange={(_pagination, _filters, sorter, info) => {
          if (info.action === "sort") {
            const selected = Array.isArray(sorter) ? sorter[0] : sorter;
            if (selected.columnKey) onSort(String(selected.columnKey));
          }
        }}
      />
      <CompassImagePreview target={preview} onClose={() => setPreview(null)} />
      {trendRow && (
        <CompassEntityTrend
          row={trendRow}
          dimension={dimension}
          startDate={data.startDate}
          endDate={data.endDate}
          sourceId={String(data.source?.id || "")}
          styleNo={styleNo}
          articleNo={articleNo}
          search={search}
          initialView={preferences.view}
          customFields={preferences.fields}
          onClose={() => setTrendRow(null)}
        />
      )}
    </Card>
  );
}
