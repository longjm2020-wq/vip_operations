import { useState } from "react";
import { Button, Checkbox, Modal, Select, Space, Tabs, Typography } from "antd";
import {
  SettingOutlined,
  SortAscendingOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { useUser } from "./shared";
type Column = {
  key: string;
  label: string;
  type?: string;
  fallbackType?: string;
};
export function SelectionOrganization({
  columns,
  group,
  sort,
  onGroup,
  onSort,
}: {
  columns: Column[];
  group: string;
  sort: string;
  onGroup: (key: string) => void;
  onSort: (key: string) => void;
}) {
  const user = useUser(),
    storageKey = `selection-organization-v1:${user.id}`;
  const [configured, setConfigured] = useState<{
    groups: string[];
    sorts: string[];
  }>(() => {
    try {
      return JSON.parse(
        localStorage.getItem(storageKey) || '{"groups":[],"sorts":[]}',
      );
    } catch {
      return { groups: [], sorts: [] };
    }
  });
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
  const sorts = configured.sorts.filter(
    (key) =>
      available.some((column) => column.key === key) &&
      key !== "registrationBatch",
  );
  const sortOptions = [
    { value: "sortOrder:asc", label: "手动排序" },
    { value: "updatedAt:desc", label: "最近修改" },
    { value: "createdAt:desc", label: "最新登记" },
    { value: "registrationBatch:desc", label: "登记批次" },
    ...sorts.flatMap((key) => [
      { value: `field:${key}:asc`, label: `${label(key)} ↑` },
      { value: `field:${key}:desc`, label: `${label(key)} ↓` },
    ]),
  ];
  if (!sortOptions.some((option) => option.value === sort))
    sortOptions.push({
      value: sort,
      label: sort.startsWith("field:")
        ? `${label(sort.slice(6, sort.lastIndexOf(":")))} ${sort.endsWith(":asc") ? "↑" : "↓"}`
        : "当前列排序",
    });
  return (
    <>
      <Select
        aria-label="分组方式"
        className="selection-tool-select"
        value={group}
        suffixIcon={<TeamOutlined />}
        options={[
          { value: "none", label: "不分组" },
          { value: "batch", label: "按登记批次分组" },
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
        value={sort}
        suffixIcon={<SortAscendingOutlined />}
        options={[
          ...sortOptions,
          {
            value: "configure",
            label: (
              <span>
                <SettingOutlined /> 配置排序字段
              </span>
            ),
          },
        ]}
        onChange={(key) =>
          key === "configure" ? configure("sorts") : onSort(key)
        }
      />
      <Modal
        title="配置分组与排序字段"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => {
          setConfigured(draft);
          localStorage.setItem(storageKey, JSON.stringify(draft));
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
          固定选项始终保留。选择其他字段加入自己的下拉菜单，图片字段不参与分组和排序。
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
                  onChange={(values) => setDraft({ ...draft, [key]: values })}
                  options={available
                    .filter(
                      (column) =>
                        column.key !== "registrationBatch" &&
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
