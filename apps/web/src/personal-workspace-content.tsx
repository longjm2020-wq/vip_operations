import { useState } from "react";
import { Button, Card, Empty, Segmented, Space, Spin, Tabs } from "antd";
import { AppstoreOutlined, BarsOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { QueryState, useUser, type Row } from "./shared";
import { LibraryActions, VisibilityTag } from "./project-library";
import {
  libraryLabels,
  type LibraryKind,
} from "../../../packages/contracts/src/project-library";
const kinds = [
  { key: "sop", permission: "project.read", path: "/sops" },
  { key: "project", permission: "project.read", path: "/projects" },
  { key: "table", permission: "project.read", path: "/project-tables" },
] as const;
export function PersonalWorkspaceContent() {
  const user = useUser(),
    allowed = kinds.filter((k) => user.permissions.includes(k.permission)),
    [kind, setKind] = useState<LibraryKind>(allowed[0]?.key || "sop"),
    [page, setPage] = useState(1),
    [view, setView] = useState("card");
  const current = allowed.find((k) => k.key === kind),
    q = useQuery({
      queryKey: ["workspace-content", user.id, kind, page],
      queryFn: () => api(`/my-workspace/content?kind=${kind}&page=${page}`),
      enabled: !!current,
    }),
    items: Row[] = q.data?.data.items || [];
  if (!allowed.length) return null;
  const href = (row: Row) =>
    kind === "sop" ? `/sops?open=${row.id}` : `${current!.path}/${row.id}`;
  return (
    <Card
      className="personal-content"
      title="我创建的内容"
      extra={
        <Segmented
          aria-label="我的内容显示样式"
          value={view}
          onChange={setView}
          options={[
            { value: "card", label: "卡片", icon: <AppstoreOutlined /> },
            { value: "list", label: "列表", icon: <BarsOutlined /> },
          ]}
        />
      }
    >
      <Tabs
        activeKey={kind}
        onChange={(key) => {
          setKind(key as LibraryKind);
          setPage(1);
        }}
        items={allowed.map((k) => ({
          key: k.key,
          label: libraryLabels[k.key],
        }))}
        tabBarExtraContent={
          <Link to={current?.path || allowed[0].path}>
            新建 / 管理{libraryLabels[kind]}
          </Link>
        }
      />
      <QueryState error={q.error} reload={() => q.refetch()} />
      {q.isLoading && <Spin />}
      <div
        className={
          view === "card" ? "personal-content-cards" : "personal-content-list"
        }
      >
        {items.map((row) => (
          <div className="personal-content-item" key={row.id}>
            <div>
              <Link to={href(row)}>{row.name || "未命名草稿"}</Link>
              <p>创建者：{row.ownerName}</p>
            </div>
            <Space>
              <VisibilityTag value={row.visibility} />
              <LibraryActions kind={kind} row={row} />
            </Space>
          </div>
        ))}
      </div>
      {!q.isLoading && !q.error && !items.length && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={`暂无自己创建的${libraryLabels[kind]}`}
        />
      )}
      <div className="personal-content-footer">
        <small>
          公开内容同时显示在项目协作公共区域；不公开内容保留已授权协作成员的访问权限。
        </small>
        <Space>
          <Button
            disabled={page === 1 || q.isFetching}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </Button>
          <span>{page}</span>
          <Button
            disabled={!q.data?.data.hasMore || q.isFetching}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </Button>
        </Space>
      </div>
    </Card>
  );
}
