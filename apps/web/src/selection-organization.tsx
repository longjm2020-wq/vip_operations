import { useState } from "react";
import { Button, Checkbox, Modal, Select, Space, Tabs, Typography } from "antd";
import {
  SettingOutlined,
  SortAscendingOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { isSelectionCreationTimeColumn, selectionOrganizationSortConfiguration, selectionOrganizationSortOptions, type SelectionOrganizationColumn } from "./selection-organization-sort";
type Column = SelectionOrganizationColumn;
export function SelectionOrganization({
  columns,
  group,
  sort,
  onGroup,
  onSort,
  configured,
  onConfigure,
  onBuildFixedOrder,
}: {
  columns: Column[];
  group: string;
  sort: string;
  onGroup: (key: string) => void;
  onSort: (key: string) => void;
  configured: { groups: string[]; sorts: string[] };
  onConfigure: (value: { groups: string[]; sorts: string[] }) => void;
  onBuildFixedOrder?: () => void;
}) {
  const [draft, setDraft] = useState(configured),
    [open, setOpen] = useState(false),
    [tab, setTab] = useState("groups");
  const available = columns.filter(
    (column) =>
      (column.type || column.fallbackType) !== "image" &&
      !["images", "labelImages"].includes(column.key),
  );
  const label = (key: string) =>
    columns.find((column) => column.key === key)?.label || key;
  const configure = (tab: string) => {
    setDraft(configured);
    setTab(tab);
    setOpen(true);
  };
  const groups = configured.groups.filter(
    (key) =>
      available.some((column) => column.key === key) &&
      !["registrationBatch", "supplierCode"].includes(key),
  );
  const sortOptions = selectionOrganizationSortOptions(columns, configured.sorts, sort);
  return (
    <>
      <Select
        aria-label="分组方式"
        className="selection-tool-select"
        popupMatchSelectWidth={false}
        value={group}
        suffixIcon={<TeamOutlined />}
        options={[
          { value: "none", label: "不分组" },
          { value: "createdTime:year", label: "按创建时间（年）分组" },
          { value: "createdTime:quarter", label: "按创建时间（季度）分组" },
          { value: "createdTime:month", label: "按创建时间（月）分组" },
          { value: "createdTime:day", label: "按创建时间（日）分组" },
          { value: "supplier", label: "按供应商编码分组" },
          ...groups.map((key) => ({
            value: `field:${key}`,
            label: `按${label(key)}分组`,
          })),
          {
            value: "configure",
            label: (
              <span>
                <SettingOutlined /> 配置分组字段
              </span>
            ),
          },
        ]}
        onChange={(key) =>
          key === "configure" ? configure("groups") : onGroup(key)
        }
      />
      <Select
        aria-label="排序方式"
        className="selection-tool-select"
        popupMatchSelectWidth={false}
        value={sort}
        suffixIcon={<SortAscendingOutlined />}
        options={[
          ...sortOptions,
          ...(onBuildFixedOrder
            ? [{ value: "buildFixedOrder", label: "按创建时间建立固定排序…" }]
            : []),
          {
            value: "configure",
            label: (
              <span>
                <SettingOutlined /> 配置排序字段
              </span>
            ),
          },
        ]}
        onChange={(key) => {
          if (key === "configure") configure("sorts");
          else if (key === "buildFixedOrder") onBuildFixedOrder?.();
          else onSort(key);
        }}
      />
      <Modal
        title="配置分组与排序字段"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => {
          onConfigure(draft);
          if (
            group.startsWith("field:") &&
            !draft.groups.includes(group.slice(6))
          )
            onGroup("none");
          if (
            sort.startsWith("field:") &&
            !draft.sorts.includes(sort.slice(6, sort.lastIndexOf(":")))
          )
            onSort("sortOrder:asc");
          setOpen(false);
        }}
      >
        <Typography.Paragraph>
          固定选项始终保留。选择其他字段加入自己的下拉菜单，图片字段不参与分组和排序。系统创建时间排序合并为固定的升序和降序选项。
        </Typography.Paragraph>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={(["groups", "sorts"] as const).map((key) => ({
            key,
            label: key === "groups" ? "分组字段" : "排序字段",
            children: (
              <Space orientation="vertical" style={{ width: "100%" }}>
                <Checkbox.Group
                  aria-label={
                    key === "groups" ? "可配置分组字段" : "可配置排序字段"
                  }
                  value={draft[key]}
                  onChange={(values) => setDraft({ ...draft, [key]: key === "sorts" ? selectionOrganizationSortConfiguration(columns, values, draft.sorts) : values })}
                  options={available
                    .filter(
                      (column) =>
                        column.key !== "registrationBatch" &&
                        (key !== "sorts" || !isSelectionCreationTimeColumn(column)) &&
                        (key !== "groups" || column.key !== "supplierCode"),
                    )
                    .map((column) => ({
                      value: column.key,
                      label: column.label,
                    }))}
                />
                <Button
                  type="text"
                  onClick={() => setDraft({ ...draft, [key]: [] })}
                >
                  清除自选字段
                </Button>
              </Space>
            ),
          }))}
        />
      </Modal>
    </>
  );
}
