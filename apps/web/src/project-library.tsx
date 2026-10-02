import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  App,
  Alert,
  Button,
  Dropdown,
  Empty,
  Modal,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
} from "antd";
import {
  AppstoreOutlined,
  BarsOutlined,
  DeleteOutlined,
  GlobalOutlined,
  LockOutlined,
  MoreOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import { api, queryClient } from "./api";
import { QueryState, useCan, useUser, when, type Row } from "./shared";
import {
  libraryLabels,
  type LibraryKind,
} from "../../../packages/contracts/src/project-library";
import "./project-library.css";

export async function refreshLibrary() {
  await queryClient.invalidateQueries({
    predicate: (q) => String(q.queryKey[0]).startsWith("project-") || q.queryKey[0] === "workspace-content",
  });
}
export function LibraryScope({value,onChange}:{value:string;onChange:(value:string)=>void}) {
  return <Select aria-label="内容范围" value={value} onChange={onChange} style={{width:150}} options={[{value:"all",label:"全部可访问"},{value:"public",label:"公共区域"},{value:"mine",label:"我创建的"}]} />;
}
export function useLibraryView(
  kind: LibraryKind,
  fallback: "card" | "list" = "card",
) {
  const user = useUser(),
    key = `project-library-view-v1:${user.id}:${kind}`;
  const [view, setView] = useState<"card" | "list">(() => {
    try {
      const value = localStorage.getItem(key);
      return value === "card" || value === "list" ? value : fallback;
    } catch {
      return fallback;
    }
  });
  return {
    view,
    setView: (value: "card" | "list") => {
      setView(value);
      try {
        localStorage.setItem(key, value);
      } catch {}
    },
  };
}
export function LibraryToolbar({
  kind,
  view,
  onView,
}: {
  kind: LibraryKind;
  view: "card" | "list";
  onView: (value: "card" | "list") => void;
}) {
  return (
    <Space wrap>
      <Segmented
        aria-label={`${libraryLabels[kind]}显示样式`}
        value={view}
        onChange={onView}
        options={[
          { value: "card", label: "卡片", icon: <AppstoreOutlined /> },
          { value: "list", label: "列表", icon: <BarsOutlined /> },
        ]}
      />
      <RecycleBinButton kind={kind} />
    </Space>
  );
}
export function VisibilityTag({ value }: { value?: string }) {
  return (
    <Tag
      icon={value === "PUBLIC" ? <GlobalOutlined /> : <LockOutlined />}
      color={value === "PUBLIC" ? "orange" : undefined}
    >
      {value === "PUBLIC" ? "公开" : "不公开"}
    </Tag>
  );
}
export function LibraryActions({
  kind,
  row,
  onDeleted,
}: {
  kind: LibraryKind;
  row: Row;
  onDeleted?: () => void;
}) {
  const { message, modal } = App.useApp(),
    [busy, setBusy] = useState(false);
  if (!row.canManage) return null;
  const execute = async (action: "visibility" | "delete") => {
    setBusy(true);
    try {
      await api(
        `/project-library/${kind}/${row.id}${action === "visibility" ? "/visibility" : ""}`,
        action === "visibility" ? "PATCH" : "DELETE",
        {
          version: row.version,
          ...(action === "visibility"
            ? { visibility: row.visibility === "PUBLIC" ? "PRIVATE" : "PUBLIC" }
            : {}),
        },
      );
      if (action === "delete") onDeleted?.();
      await refreshLibrary();
      message.success(
        action === "delete" ? "已移至回收站，30 天内可恢复" : "公开范围已更新",
      );
    } catch (error) {
      message.error((error as Error).message);
      await refreshLibrary();
      throw error;
    } finally {
      setBusy(false);
    }
  };
  return (
    <span onClick={(event) => event.stopPropagation()}>
      <Dropdown
        trigger={["click"]}
        menu={{
          items: [
            {
              key: "visibility",
              label: row.visibility === "PUBLIC" ? "设为不公开" : "设为公开",
              icon:
                row.visibility === "PUBLIC" ? (
                  <LockOutlined />
                ) : (
                  <GlobalOutlined />
                ),
            },
            { type: "divider" },
            {
              key: "delete",
              label: "移至回收站",
              danger: true,
              icon: <DeleteOutlined />,
            },
          ],
          onClick: ({ key }) => {
            if (key === "visibility")
              modal.confirm({
                title:
                  row.visibility === "PUBLIC" ? "设为不公开？" : "公开此内容？",
                content:
                  row.visibility === "PUBLIC"
                    ? "仅创建者、管理员及已授权的协作成员可访问。"
                    : "系统内具有对应查看权限的用户可访问，不会公开到互联网。",
                onOk: () => execute("visibility"),
              });
            else
              modal.confirm({
                title: `将「${row.name || "未命名草稿"}」移至回收站？`,
                content:
                  "删除后暂时无法访问，30 天内可恢复全部数据与协作设置；期满自动彻底删除。",
                okText: "移至回收站",
                okButtonProps: { danger: true },
                onOk: () => execute("delete"),
              });
          },
        }}
      >
        <Button
          type="text"
          aria-label={`管理${libraryLabels[kind]}：${row.name || "未命名草稿"}`}
          icon={<MoreOutlined />}
          loading={busy}
        />
      </Dropdown>
    </span>
  );
}
export function RecycleBinButton({ kind }: { kind: LibraryKind }) {
  const allowed = useCan(
    kind === "sop"
      ? "sop.manage"
      : kind === "project"
        ? "project.create"
        : "selection.manage",
  );
  const [open, setOpen] = useState(false),
    [restoring, setRestoring] = useState<string>(),
    { message } = App.useApp();
  const result = useQuery({
    queryKey: ["project-trash", kind],
    queryFn: async () =>
      (await api(`/project-library/trash?kind=${kind}`)).data,
    enabled: open && allowed,
    refetchInterval: open ? 60000 : false,
  });
  if (!allowed) return null;
  return (
    <>
      <Button
        aria-label="回收站"
        icon={<DeleteOutlined />}
        onClick={() => setOpen(true)}
      >
        回收站
      </Button>
      <Modal
        title={`${libraryLabels[kind]}回收站`}
        open={open}
        width={900}
        footer={null}
        onCancel={() => {
          if (!restoring) setOpen(false);
        }}
      >
        <Alert
          className="library-trash-notice"
          showIcon
          type="info"
          title="删除后保留 30 天，期满自动彻底删除。恢复后保留原数据、公开范围和协作设置。"
        />
        <QueryState error={result.error} reload={() => void result.refetch()} />
        <Table<Row>
          rowKey="id"
          loading={result.isLoading}
          dataSource={result.data || []}
          scroll={{ x: 750 }}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="回收站为空"
              />
            ),
          }}
          columns={[
            {
              title: "名称",
              dataIndex: "name",
              render: (name: string) => name || "未命名草稿",
            },
            {
              title: "创建人",
              dataIndex: "ownerName",
              render: (name: string) => name || "系统模板",
            },
            { title: "删除时间", dataIndex: "deletedAt", render: when },
            {
              title: "恢复期限",
              dataIndex: "expiresAt",
              render: (date: string) => (
                <Space orientation="vertical" size={0}>
                  <span>{when(date)}</span>
                  <small>
                    剩余{" "}
                    {Math.max(
                      0,
                      Math.ceil((Date.parse(date) - Date.now()) / 86400000),
                    )}{" "}
                    天
                  </small>
                </Space>
              ),
            },
            {
              title: "操作",
              render: (_: unknown, row: Row) => (
                <Button
                  aria-label="恢复"
                  icon={<UndoOutlined />}
                  loading={restoring === row.id}
                  disabled={!!restoring && restoring !== row.id}
                  onClick={async () => {
                    setRestoring(row.id);
                    try {
                      await api(
                        `/project-library/${kind}/${row.id}/restore`,
                        "POST",
                        { version: row.version },
                      );
                      await refreshLibrary();
                      message.success("已恢复");
                    } catch (error) {
                      message.error((error as Error).message);
                      await result.refetch();
                    } finally {
                      setRestoring(undefined);
                    }
                  }}
                >
                  恢复
                </Button>
              ),
            },
          ]}
        />
      </Modal>
    </>
  );
}
