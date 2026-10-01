import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Space,
  Spin,
  Table,
  Typography,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api, queryClient } from "./api";
import { Header, QueryState, useCan, type Row } from "./shared";
import { StyleSelectionsPage } from "./style-selections";
import { SelectionWorkspace } from "./selection-workspace";

export function ProjectTablesPage() {
  const canCreate = useCan("selection.manage"),
    navigate = useNavigate(),
    { message } = App.useApp();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const attempt = useRef<{ name: string; key: string } | undefined>(undefined);
  const tables = useQuery({
    queryKey: ["project-tables"],
    queryFn: () => api("/project-tables"),
  });
  const [form] = Form.useForm();
  return (
    <>
      <Header
        title="新建表格"
        subtitle="创建空表，使用与选款登记相同的录入、字段管理和协作功能。"
        extra={
          canCreate && (
            <Button
              aria-label="新建表格"
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                form.resetFields();
                attempt.current = undefined;
                setOpen(true);
              }}
            >
              新建表格
            </Button>
          )
        }
      />
      <QueryState error={tables.error} reload={() => void tables.refetch()} />
      <Card>
        <Table
          rowKey="id"
          loading={tables.isLoading}
          dataSource={tables.data?.data || []}
          pagination={{ pageSize: 20 }}
          locale={{
            emptyText: <Empty description="暂无表格，新建后即可开始录入" />,
          }}
          columns={[
            {
              title: "表格名称",
              dataIndex: "name",
              render: (name: string, row: Row) => (
                <Link to={`/project-tables/${row.id}`}>{name}</Link>
              ),
            },
            { title: "创建人", dataIndex: "createdByName" },
            {
              title: "创建时间",
              dataIndex: "createdAt",
              render: (value: string) =>
                new Date(value).toLocaleString("zh-CN", { hour12: false }),
            },
            {
              title: "操作",
              render: (_: unknown, row: Row) => (
                <Link to={`/project-tables/${row.id}`}>打开表格</Link>
              ),
            },
          ]}
        />
      </Card>
      <Modal
        title="新建表格"
        open={open}
        footer={null}
        onCancel={() => {
          if (!busy) setOpen(false);
        }}
        closable={!busy}
        mask={{ closable: !busy }}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async ({ name }: { name: string }) => {
            if (busy) return;
            const trimmed = name.trim();
            if (attempt.current?.name !== trimmed)
              attempt.current = { name: trimmed, key: crypto.randomUUID() };
            setBusy(true);
            try {
              const result = await api(
                "/project-tables",
                "POST",
                { name: trimmed },
                attempt.current!.key,
              );
              await queryClient.invalidateQueries({
                queryKey: ["project-tables"],
              });
              setOpen(false);
              navigate(`/project-tables/${result.data.id}`);
            } catch (error) {
              message.error((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Form.Item
            name="name"
            label="表格名称"
            rules={[
              { required: true, whitespace: true, message: "请输入表格名称" },
              { max: 100 },
            ]}
          >
            <Input autoFocus maxLength={100} placeholder="请输入表格名称" />
          </Form.Item>
          <Typography.Paragraph type="secondary">
            新表初始包含一个「文本」字段和三行空白记录。可通过「＋」添加字段或行，并在表内配置字段类型及其他功能。
          </Typography.Paragraph>
          <Button block type="primary" htmlType="submit" loading={busy}>
            创建空表
          </Button>
        </Form>
      </Modal>
    </>
  );
}
export function ProjectTablePage() {
  const { id = "" } = useParams();
  const table = useQuery({
    queryKey: ["project-table", id],
    queryFn: () => api(`/project-tables/${id}`),
  });
  if (table.isLoading) return <Spin />;
  if (table.error || !table.data)
    return (
      <QueryState error={table.error} reload={() => void table.refetch()} />
    );
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Link to="/project-tables">返回表格列表</Link>
      </Space>
      <SelectionWorkspace
        key={id}
        tableId={id}
        title={table.data.data.name}
        blankLayout={table.data.data.initialLayout === "blank"}
      >
        <StyleSelectionsPage />
      </SelectionWorkspace>
    </>
  );
}
