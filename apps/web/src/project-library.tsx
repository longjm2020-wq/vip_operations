import { useEffect, useState } from "react";
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
  UsergroupAddOutlined,
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
    predicate: (q) =>
      String(q.queryKey[0]).startsWith("project-") ||
      q.queryKey[0] === "workspace-content",
  });
}
export function LibraryScope({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      aria-label="内容范围"
      value={value}
      onChange={onChange}
      style={{ width: 150 }}
      options={[
        { value: "all", label: "全部可访问" },
        { value: "public", label: "公共区域" },
        { value: "mine", label: "我创建的" },
      ]}
    />
  );
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
    [busy, setBusy] = useState(false),
    [membersOpen, setMembersOpen] = useState(false);
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
    <>
      <span onClick={(event) => event.stopPropagation()}>
        <Dropdown
          trigger={["click"]}
          menu={{
            items: [
              {
                key: "members",
                label: "成员权限",
                icon: <UsergroupAddOutlined />,
                disabled: busy,
              },
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
              if (key === "members") setMembersOpen(true);
              else if (key === "visibility")
                modal.confirm({
                  title:
                    row.visibility === "PUBLIC"
                      ? "设为不公开？"
                      : "公开此内容？",
                  content:
                    row.visibility === "PUBLIC"
                      ? "仅创建者、超级管理员及明确获准的协作成员可访问；普通管理员不具有默认访问权。"
                      : "系统内获准用户默认仅查看，编辑需单独授权；已设为禁止查看的成员仍不能访问，不会公开到互联网。",
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
      <span onClick={(event) => event.stopPropagation()}>
        <LibraryCollaboratorsDialog
          kind={kind}
          row={row}
          open={membersOpen}
          onClose={() => setMembersOpen(false)}
        />
      </span>
    </>
  );
}
type LibraryMemberAccess = "EDIT" | "READ" | "DENY";
type LibraryMember = { userId: string; access: LibraryMemberAccess };
type LibraryCollaborators = {
  version: number;
  ownerId: string;
  users: {
    id: string;
    displayName?: string;
    username: string;
    superAdmin?: boolean;
  }[];
  members: LibraryMember[];
};
const memberAccessOptions = [
  { value: "EDIT", label: "可编辑" },
  { value: "READ", label: "仅查看" },
  { value: "DENY", label: "禁止查看" },
];
function LibraryCollaboratorsDialog({
  kind,
  row,
  open,
  onClose,
}: {
  kind: LibraryKind;
  row: Row;
  open: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [members, setMembers] = useState<LibraryMember[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [version, setVersion] = useState<number | null>(null),
    [saving, setSaving] = useState(false),
    [conflict, setConflict] = useState(false);
  const path = `/project-library/${kind}/${row.id}/collaborators`;
  const result = useQuery<LibraryCollaborators>({
    queryKey: ["project-collaborators", kind, String(row.id)],
    queryFn: async () => (await api(path)).data,
    enabled: open,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  useEffect(() => {
    if (!open) {
      setVersion(null);
      setSelected([]);
      setConflict(false);
    } else if (result.data && version === null && !result.isFetching) {
      setMembers(result.data.members.map((member) => ({ ...member })));
      setVersion(result.data.version);
    }
  }, [open, result.data, result.isFetching, version]);
  const users = result.data?.users || [],
    userById = new Map(users.map((user) => [String(user.id), user])),
    fixed = (userId: string) =>
      userId === String(result.data?.ownerId) ||
      !!userById.get(userId)?.superAdmin;
  const loadLatest = async () => {
    const fresh = await result.refetch();
    if (!fresh.data || fresh.error) return;
    setMembers(fresh.data.members.map((member) => ({ ...member })));
    setVersion(fresh.data.version);
    setSelected([]);
    setConflict(false);
  };
  const save = async () => {
    if (version === null || saving || conflict) return;
    setSaving(true);
    try {
      await api(path, "POST", { version, members });
      onClose();
      await refreshLibrary();
      message.success("成员权限已更新");
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "成员权限保存失败，请重试",
      );
      if ((error as { status?: number }).status === 409) {
        setConflict(true);
        await result.refetch();
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={`${libraryLabels[kind]}成员权限：${row.name || "未命名草稿"}`}
      open={open}
      width={720}
      onCancel={() => {
        if (!saving) onClose();
      }}
      footer={
        <Space>
          <Button disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button
            type="primary"
            loading={saving}
            disabled={
              version === null ||
              result.isFetching ||
              !!result.error ||
              conflict
            }
            onClick={() => void save()}
          >
            保存权限
          </Button>
        </Space>
      }
    >
      <Alert
        showIcon
        type="info"
        title={
          <Space size="small">
            <span>成员权限与公开范围分别设置</span>
            <VisibilityTag value={row.visibility} />
          </Space>
        }
        description="公开内容默认仅查看；不公开内容仅创建者、超级管理员及获准成员可访问。可编辑只授权内容修改，不授予成员管理、公开范围设置或删除资格。禁止查看优先于公开范围；移除成员设置后恢复该账号的默认访问范围，原内容保留。创建者及超级管理员固定可查看、编辑和管理，普通管理员没有默认全站权限。"
      />
      <QueryState error={result.error} reload={() => void loadLatest()} />
      {conflict && (
        <Alert
          style={{ marginTop: 12 }}
          showIcon
          type="warning"
          title="其他人已更新成员权限，当前修改已保留"
          description="请使用最新成员设置，核对后重新调整并保存。"
          action={
            <Button size="small" onClick={() => void loadLatest()}>
              使用最新成员设置
            </Button>
          }
        />
      )}
      <Space.Compact style={{ width: "100%", margin: "16px 0" }}>
        <Select
          mode="multiple"
          showSearch
          optionFilterProp="label"
          aria-label="选择协作成员"
          placeholder="选择用户，添加后设置访问权限"
          maxTagCount="responsive"
          value={selected}
          disabled={version === null || saving || conflict}
          onChange={setSelected}
          style={{ flex: 1, minWidth: 0 }}
          options={users
            .filter(
              (user) =>
                !fixed(String(user.id)) &&
                !members.some((member) => member.userId === String(user.id)),
            )
            .map((user) => ({
              value: String(user.id),
              label:
                user.displayName && user.displayName !== user.username
                  ? `${user.displayName}（${user.username}）`
                  : user.username,
            }))}
        />
        <Button
          icon={<UsergroupAddOutlined />}
          disabled={!selected.length || saving || conflict}
          onClick={() => {
            setMembers((current) => [
              ...current,
              ...selected
                .filter(
                  (userId) =>
                    !current.some((member) => member.userId === userId),
                )
                .map((userId) => ({ userId, access: "READ" as const })),
            ]);
            setSelected([]);
          }}
        >
          添加成员
        </Button>
      </Space.Compact>
      <Table<LibraryMember>
        rowKey="userId"
        size="small"
        loading={result.isLoading}
        dataSource={members}
        pagination={
          members.length > 10 ? { pageSize: 10, showSizeChanger: false } : false
        }
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="尚未设置协作成员"
            />
          ),
        }}
        columns={[
          {
            title: "用户",
            render: (_: unknown, member: LibraryMember) => {
              const user = userById.get(member.userId);
              return user ? (
                <Space size="small">
                  <span>{user.displayName || user.username}</span>
                  {user.displayName && user.displayName !== user.username && (
                    <small>{user.username}</small>
                  )}
                </Space>
              ) : (
                "已不可用用户"
              );
            },
          },
          {
            title: "访问权限",
            width: 150,
            render: (_: unknown, member: LibraryMember) =>
              fixed(member.userId) ? (
                <Tag color="orange">固定可管理</Tag>
              ) : (
                <Select
                  aria-label={`成员权限：${userById.get(member.userId)?.displayName || userById.get(member.userId)?.username || member.userId}`}
                  value={member.access}
                  disabled={saving || conflict}
                  options={memberAccessOptions}
                  onChange={(access: LibraryMemberAccess) =>
                    setMembers((current) =>
                      current.map((item) =>
                        item.userId === member.userId
                          ? { ...item, access }
                          : item,
                      ),
                    )
                  }
                />
              ),
          },
          {
            title: "操作",
            width: 72,
            render: (_: unknown, member: LibraryMember) => (
              <Button
                type="text"
                danger
                disabled={saving || conflict || fixed(member.userId)}
                onClick={() =>
                  setMembers((current) =>
                    current.filter((item) => item.userId !== member.userId),
                  )
                }
              >
                移除
              </Button>
            ),
          },
        ]}
      />
    </Modal>
  );
}
export function RecycleBinButton({ kind }: { kind: LibraryKind }) {
  const allowed = useCan("project.read");
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
