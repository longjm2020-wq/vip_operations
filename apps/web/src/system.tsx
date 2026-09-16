import { PermissionChecklist } from "./permission-checklist";
import { BatchEditor } from "./batch-editor";
import { Table } from "./data-table";
import { useState } from "react";
import { App, Button, Card, Drawer, Form, Input, Select } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api, queryClient } from "./api";
import {
  Header,
  Row,
  Status,
  useList,
  useCan,
  useUser,
  useOptions,
  options,
  QueryState,
  when,
  UserRoles,
} from "./shared";
export function AccessPage({ roles = false }: { roles?: boolean }) {
  const [batch, setBatch] = useState(false);
  const manage = useCan(roles ? "role.manage" : "user.manage");
  const isSuperAdmin = useUser().roleCodes?.includes("SUPER_ADMIN");
  const canEditRole = (r: Row) =>
    manage && r.code !== "SUPER_ADMIN" && (r.code !== "ADMIN" || isSuperAdmin);
  const path = roles ? "/roles" : "/users",
    q = useQuery({ queryKey: [path], queryFn: () => api(path) }),
    roleOptions = useOptions("/roles", !roles),
    permissions = useOptions("/permissions", roles);
  const [form] = Form.useForm(),
    [open, setOpen] = useState(false),
    [editing, setEditing] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(crypto.randomUUID());
  const protectedRole = roles && (!!editing ? !canEditRole(editing) : !manage);
  const { message, modal } = App.useApp();
  const reset = (row: Row) => {
    let password = "";
    const requestKey = crypto.randomUUID();
    modal.confirm({
      title: "重置 " + row.displayName + " 的密码",
      content: (
        <Input.Password
          placeholder="新密码，至少12位"
          onChange={(e) => (password = e.target.value)}
        />
      ),
      onOk: async () => {
        if (password.length < 12) {
          message.error("密码至少12位");
          throw Error("Password too short");
        }
        try {
          await api(
            "/users/" + row.id + "/reset-password",
            "POST",
            { newPassword: password },
            requestKey,
          );
          message.success("密码已重置，原会话已撤销");
        } catch (e) {
          message.error((e as Error).message);
          throw e;
        }
      },
    });
  };
  const start = (r?: Row) => {
    setEditing(r || null);
    form.resetFields();
    form.setFieldsValue(r || { status: "ACTIVE" });
    setKey(crypto.randomUUID());
    setOpen(true);
  };
  return (
    <>
      <Header
        title={roles ? "角色权限" : "用户管理"}
        subtitle="权限由后端执行，角色变更后立即在后续请求生效。"
        extra={
          <>
            <Button disabled={!manage} onClick={() => setBatch(true)}>
              表格批量编辑
            </Button>
            <Button type="primary" disabled={!manage} onClick={() => start()}>
              新建{roles ? "角色" : "用户"}
            </Button>
          </>
        }
      />
      <Card>
        <QueryState error={q.error} reload={() => q.refetch()} />
        <Table<Row>
          rowKey="id"
          dataSource={q.data?.data || []}
          loading={q.isLoading}
          columns={
            roles
              ? [
                  { title: "角色代码", dataIndex: "code" },
                  { title: "名称", dataIndex: "name" },
                  {
                    title: "权限数量",
                    render: (_, r) => r.permissionCodes?.length,
                  },
                  {
                    title: "操作",
                    render: (_, r) => (
                      <>
                        <Button type="link" onClick={() => start(r)}>
                          {canEditRole(r) ? "编辑权限" : "查看权限"}
                        </Button>
                        {canEditRole(r) && (
                          <Button
                            type="link"
                            danger
                            onClick={() =>
                              modal.confirm({
                                title: "删除角色：" + r.name,
                                content: "仍有用户使用的角色不可删除。",
                                onOk: async () => {
                                  try {
                                    await api(
                                      "/roles/" + r.id,
                                      "DELETE",
                                      {},
                                      crypto.randomUUID(),
                                    );
                                    await queryClient.invalidateQueries();
                                    message.success("已删除");
                                  } catch (e) {
                                    message.error((e as Error).message);
                                    throw e;
                                  }
                                },
                              })
                            }
                          >
                            删除
                          </Button>
                        )}
                      </>
                    ),
                  },
                ]
              : [
                  {
                    title: "用户名 / 角色",
                    dataIndex: "username",
                    render: (name, r) => (
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          flexWrap: "wrap",
                          alignItems: "center",
                        }}
                      >
                        <span>{name}</span>
                        <UserRoles names={r.roleNames} />
                      </div>
                    ),
                  },
                  { title: "姓名", dataIndex: "displayName" },
                  {
                    title: "状态",
                    dataIndex: "status",
                    render: (v) => <Status value={v} />,
                  },
                  {
                    title: "操作",
                    render: (_, r) => (
                      <>
                        <Button type="link" onClick={() => start(r)}>
                          编辑
                        </Button>
                        <Button type="link" onClick={() => reset(r)}>
                          重置密码
                        </Button>
                      </>
                    ),
                  },
                ]
          }
        />
      </Card>
      <Drawer
        width={roles ? "min(760px, 96vw)" : undefined}
        title={protectedRole ? "查看内置角色权限" : editing ? "编辑" : "新建"}
        open={open}
        onClose={() => setOpen(false)}
        extra={
          <Button
            type="primary"
            loading={busy}
            disabled={protectedRole}
            onClick={async () => {
              const body = await form.validateFields();
              setBusy(true);
              try {
                await api(
                  path + (editing ? "/" + editing.id : ""),
                  editing ? "PATCH" : "POST",
                  body,
                  key,
                );
                setOpen(false);
                message.success("已保存");
                await queryClient.invalidateQueries();
              } catch (e) {
                message.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            保存
          </Button>
        }
      >
        <Form
          disabled={protectedRole}
          layout="vertical"
          form={form}
          onValuesChange={() => setKey(crypto.randomUUID())}
        >
          {roles ? (
            <>
              <Form.Item
                name="code"
                label="角色代码"
                rules={[{ required: true }]}
              >
                <Input disabled={!!editing} />
              </Form.Item>
              <Form.Item
                name="name"
                label="角色名称"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
              <Form.Item name="permissionCodes" label="权限">
                <PermissionChecklist
                  disabled={protectedRole}
                  codes={(permissions.data?.data || []).map((p: Row) => p.code)}
                />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item
                name="username"
                label="用户名"
                rules={[{ required: true }]}
              >
                <Input disabled={!!editing} />
              </Form.Item>
              <Form.Item
                name="displayName"
                label="姓名"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
              {!editing && (
                <Form.Item
                  name="password"
                  label="初始密码（至少12位）"
                  rules={[{ required: true, min: 12 }]}
                >
                  <Input.Password />
                </Form.Item>
              )}
              <Form.Item
                name="roleIds"
                label="角色"
                rules={[{ required: true }]}
              >
                <Select mode="multiple" options={options(roleOptions.data)} />
              </Form.Item>
              <Form.Item name="status" label="状态">
                <Select
                  options={[
                    { value: "ACTIVE", label: "正常" },
                    { value: "INACTIVE", label: "已停用" },
                  ]}
                />
              </Form.Item>
            </>
          )}
        </Form>
      </Drawer>
      {batch && (
        <BatchEditor
          title={roles ? "角色名称" : "用户资料"}
          allowCreate={false}
          initial={(q.data?.data || []).filter(
            (r: Row) => !roles || canEditRole(r),
          )}
          fields={
            roles
              ? [
                  { key: "code", label: "角色代码", readonly: true },
                  { key: "name", label: "角色名称", required: true },
                ]
              : [
                  { key: "username", label: "用户名", readonly: true },
                  { key: "displayName", label: "姓名", required: true },
                  { key: "status", label: "状态", type: "status" },
                ]
          }
          saveRow={(body, key, original) =>
            api(path + "/" + original!.id, "PATCH", body, key)
          }
          onClose={() => setBatch(false)}
        />
      )}
    </>
  );
}
export function AuditPage() {
  const q = useList("/audit-logs");
  return (
    <>
      <Header
        title="操作日志"
        subtitle="业务变化、操作者和前后值。日志只读，不可修改。"
      />
      <Card>
        <QueryState error={q.error} reload={() => q.refetch()} />
        <Table<Row>
          rowKey="id"
          dataSource={q.items}
          loading={q.isLoading}
          columns={[
            { title: "时间", dataIndex: "occurredAt", render: when },
            { title: "操作人", dataIndex: "actorLabel" },
            { title: "动作", dataIndex: "action" },
            { title: "业务类型", dataIndex: "entityType" },
            { title: "记录 ID", dataIndex: "entityId" },
            { title: "原因", dataIndex: "reason" },
          ]}
          expandable={{
            expandedRowRender: (r) => (
              <div className="form-grid">
                <div>
                  <strong>变更前</strong>
                  <pre>{JSON.stringify(r.beforeData, null, 2)}</pre>
                </div>
                <div>
                  <strong>变更后</strong>
                  <pre>{JSON.stringify(r.afterData, null, 2)}</pre>
                </div>
              </div>
            ),
          }}
          pagination={{
            current: q.page,
            total: q.total,
            pageSize: 20,
            onChange: q.setPage,
            showSizeChanger: false,
          }}
        />
      </Card>
    </>
  );
}
