import { useState, type ReactNode } from "react";
import { App, type TableProps } from "antd";
import type { InventoryDimension } from "../../../packages/contracts/src/inventory-summary";
import { useUser, type Row } from "./shared";
import {
  SelectionColumnGroupManager,
  SelectionColumnGroupTabs,
  type SelectionColumnGroup,
} from "./selection-column-groups";

type Preferences = { groups: SelectionColumnGroup[]; activeKey: string };
type Props = {
  dimension: InventoryDimension;
  columns: NonNullable<TableProps<Row>["columns"]>;
  children: (view: {
    manager: ReactNode;
    tabs: ReactNode;
    groupKeys: string[];
    visit: number;
  }) => ReactNode;
};
const defaults: SelectionColumnGroup[] = [
  {
    id: "inventory",
    name: "库存",
    columnKeys: [
      "physicalQty",
      "inTransitQty",
      "transferTransitQty",
      "incomingQty",
    ],
  },
  {
    id: "reference",
    name: "经营参考",
    columnKeys: [
      "periodSalesQty",
      "estimatedReturns",
      "dailySales",
      "returnRate",
      "planningDailySales",
      "coverageDays",
      "replenishmentQty",
    ],
  },
  {
    id: "listing",
    name: "平台状态",
    columnKeys: [
      "barcodeListingState",
      "styleListingState",
      "listingCheckedAt",
      "lastListingChangeAt",
      "lastListingChangeType",
    ],
  },
];
function read(key: string, keys: string[]): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      saved &&
      Array.isArray(saved.groups) &&
      typeof saved.activeKey === "string"
    ) {
      const ids = new Set<string>(),
        names = new Set<string>();
      const groups: SelectionColumnGroup[] = saved.groups.flatMap(
        (group: SelectionColumnGroup) => {
          if (
            !group ||
            typeof group.id !== "string" ||
            !group.id ||
            ids.has(group.id) ||
            typeof group.name !== "string" ||
            !group.name.trim() ||
            group.name === "全部字段" ||
            names.has(group.name.trim()) ||
            !Array.isArray(group.columnKeys)
          )
            return [];
          const columnKeys = [
            ...new Set(group.columnKeys.filter((key) => keys.includes(key))),
          ];
          if (!columnKeys.length) return [];
          ids.add(group.id);
          names.add(group.name.trim());
          return [{ id: group.id, name: group.name.trim(), columnKeys }];
        },
      );
      return {
        groups,
        activeKey: groups.some((group) => group.id === saved.activeKey)
          ? saved.activeKey
          : "",
      };
    }
  } catch {
    /* Unavailable preferences must not block inventory viewing. */
  }
  return {
    groups: defaults
      .map((group) => ({
        ...group,
        columnKeys: group.columnKeys.filter((key) => keys.includes(key)),
      }))
      .filter((group) => group.columnKeys.length),
    activeKey: "",
  };
}

export function InventoryColumnGroups(props: Props) {
  const user = useUser();
  const storageKey = `inventory-column-groups-v1:${user.id}:${props.dimension}`;
  return (
    <InventoryColumnGroupsState
      key={storageKey}
      {...props}
      storageKey={storageKey}
    />
  );
}

function InventoryColumnGroupsState({
  columns,
  children,
  storageKey,
}: Props & { storageKey: string }) {
  const { message } = App.useApp();
  const fields = columns.map((column) => ({
    key: "dataIndex" in column ? String(column.dataIndex) : String(column.key),
    label: String(column.title),
  }));
  const keys = fields.map((field) => field.key);
  const [preferences, setPreferences] = useState(() => read(storageKey, keys));
  const [visit, setVisit] = useState(0);
  const persist = (next: Preferences) => {
    // A failed save keeps the manager's draft open; never claim persistence.
    localStorage.setItem(storageKey, JSON.stringify(next));
    setPreferences(next);
    setVisit((value) => value + 1);
  };
  return children({
    manager: (
      <SelectionColumnGroupManager
        columns={fields}
        visible={keys}
        groups={preferences.groups}
        persistenceHint="可为同一字段配置多个分组。分组与当前 TAB 按账号和条码／货号／款号维度保存在当前浏览器，刷新后恢复；不影响其他用户、库存数量或导出列。"
        onSave={(groups) => {
          try {
            persist({
              groups,
              activeKey: groups.some(
                (group) => group.id === preferences.activeKey,
              )
                ? preferences.activeKey
                : "",
            });
          } catch {
            throw new Error(
              "浏览器无法保存分组，请允许站点存储后重试；分组草稿已保留",
            );
          }
        }}
      />
    ),
    tabs: (
      <SelectionColumnGroupTabs
        groups={preferences.groups}
        visibleKeys={keys}
        activeKey={preferences.activeKey}
        onChange={(activeKey) => {
          const next = { ...preferences, activeKey };
          try {
            persist(next);
          } catch {
            setPreferences(next);
            setVisit((value) => value + 1);
            message.warning("已切换分组；浏览器无法保存选择，刷新后需重新选择");
          }
        }}
      />
    ),
    groupKeys:
      preferences.groups.find((group) => group.id === preferences.activeKey)
        ?.columnKeys ?? [],
    visit,
  });
}
