import { createContext, useContext, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Empty, Space, Tag, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "./api";
export type Row = Record<string, any>;
export const UserContext = createContext<Row>({ permissions: [] });
export const useUser = () => useContext(UserContext);
export const useCan = (p: string) => useUser().permissions.includes(p);
export const stateLabels: Record<string, string> = {
  ACTIVE: "正常",
  INACTIVE: "已停用",
  STOPPED: "停售",
  ARCHIVED: "已归档",
  DRAFT: "草稿",
  PENDING_CONFIRMATION: "待确认",
  CONFIRMED: "已确认",
  PARTIALLY_RECEIVED: "部分入库",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  RECEIVED: "已到货 · 待过账",
  POSTED: "已过账",
  PENDING: "待处理",
  ACCEPTED: "已接受",
  MODIFIED: "已改量",
  IGNORED: "已忽略",
  CONVERTED: "已转采购单",
  FIXTURE: "测试样例",
  STANDARD_SALES: "标准销售",
};
export function Status({ value }: { value: string }) {
  return (
    <Tag
      color={
        ["ACTIVE", "COMPLETED", "POSTED"].includes(value)
          ? "green"
          : ["CONFIRMED", "CONVERTED"].includes(value)
            ? "blue"
            : ["PENDING", "PENDING_CONFIRMATION", "RECEIVED"].includes(value)
              ? "gold"
              : undefined
      }
    >
      {stateLabels[value] || value}
    </Tag>
  );
}
export const amount = (v: any) =>
  v == null
    ? "—"
    : Number(v).toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
export const when = (v: any) =>
  v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "—";
export function Header({
  title,
  subtitle,
  extra,
}: {
  title: string;
  subtitle: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <Typography.Title level={2}>{title}</Typography.Title>
        <Typography.Text type="secondary">{subtitle}</Typography.Text>
      </div>
      <Space>{extra}</Space>
    </div>
  );
}
export function useList(path: string, filters: Row = {}) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: [path, page, filters],
    queryFn: () =>
      api(
        path +
          "?" +
          new URLSearchParams({
            ...filters,
            page: String(page),
            pageSize: "20",
          }),
      ),
  });
  return {
    ...query,
    page,
    setPage,
    items: query.data?.data || [],
    total: query.data?.total || 0,
  };
}
export function useOptions(path: string, enabled = true) {
  return useQuery({
    queryKey: ["options", path],
    queryFn: async () => {
      const first = await api(path + "?pageSize=100");
      const data = [...first.data];
      for (let page = 2; data.length < first.total; page++) {
        const next = await api(path + "?pageSize=100&page=" + page);
        if (!next.data.length) break;
        data.push(...next.data);
      }
      return { ...first, data };
    },
    enabled,
  });
}
export function options(result: Row | undefined, label = "name") {
  return (result?.data || []).map((x: Row) => ({
    value: x.id,
    label: x[label] || x.username || x.code || x.id,
  }));
}
export function QueryState({
  error,
  reload,
}: {
  error: Error | null;
  reload: () => void;
}) {
  return error ? (
    <Alert
      title={error.message}
      type="error"
      showIcon
      action={<Button onClick={reload}>重试</Button>}
    />
  ) : null;
}
export const empty = {
  emptyText: (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description="暂无记录，建立资料后即可开始工作"
    />
  ),
};
export function Refresh({ onClick }: { onClick: () => void }) {
  return (
    <Button icon={<ReloadOutlined />} onClick={onClick}>
      刷新
    </Button>
  );
}
