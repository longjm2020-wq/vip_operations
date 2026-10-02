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
  Select,
  Space,
  Spin,
  Table,
  Typography,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api, queryClient } from "./api";
import { Header, QueryState, useCan, useUser, type Row } from "./shared";
import { StyleSelectionsPage } from "./style-selections";
import { SelectionWorkspace } from "./selection-workspace";
import { LibraryActions, LibraryToolbar, LibraryScope, VisibilityTag, useLibraryView } from "./project-library";
import { visibilityOptions } from "../../../packages/contracts/src/project-library";

export function ProjectTablesPage() {
  const library=useLibraryView("table","list");
  const user=useUser(),[scope,setScope]=useState("all");
  const canCreate = useCan("selection.manage"),
    navigate = useNavigate(),
    { message } = App.useApp();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const attempt = useRef<{ name: string; visibility: string; key: string } | undefined>(undefined);
  const tables = useQuery({
    queryKey: ["project-tables"],
    queryFn: () => api("/project-tables"),
  });
  const [form] = Form.useForm();
  const displayed=(tables.data?.data||[]).filter((row:Row)=>scope==="all" || scope==="public" && row.visibility==="PUBLIC" || scope==="mine" && String(row.createdBy)===String(user.id));
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
      <div className="library-toolbar"><LibraryScope value={scope} onChange={setScope}/><LibraryToolbar kind="table" view={library.view} onView={library.setView}/></div>
      {library.view==="card" ? <div className="library-card-grid">
        {displayed.map((row:Row)=><Card key={row.id} hoverable onClick={()=>navigate(`/project-tables/${row.id}`)}>
          <div className="library-card-heading"><VisibilityTag value={row.visibility}/><LibraryActions kind="table" row={row}/></div>
          <h3><Link to={`/project-tables/${row.id}`}>{row.name}</Link></h3>
          <Typography.Text type="secondary">{row.createdByName}</Typography.Text>
          <footer>{new Date(row.createdAt).toLocaleString("zh-CN",{hour12:false})}</footer>
        </Card>)}
        {!tables.isLoading&&!displayed.length&&<Empty description="暂无表格，新建后即可开始录入"/>}
      </div> : <Card>
        <Table
          rowKey="id"
          loading={tables.isLoading}
          dataSource={displayed}
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
            { title:"公开范围",dataIndex:"visibility",render:(v:string)=><VisibilityTag value={v}/> },
            {
              title: "创建时间",
              dataIndex: "createdAt",
              render: (value: string) =>
                new Date(value).toLocaleString("zh-CN", { hour12: false }),
            },
            {
              title: "操作",
              render: (_: unknown, row: Row) => (
                <Space><Link to={`/project-tables/${row.id}`}>打开表格</Link><LibraryActions kind="table" row={row}/></Space>
              ),
            },
          ]}
        />
      </Card>}
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
          initialValues={{visibility:"PRIVATE"}}
          onFinish={async ({ name,visibility }: { name: string;visibility:string }) => {
            if (busy) return;
            const trimmed = name.trim();
            if (attempt.current?.name !== trimmed || attempt.current?.visibility !== visibility)
              attempt.current = { name: trimmed, visibility, key: crypto.randomUUID() };
            setBusy(true);
            try {
              const result = await api(
                "/project-tables",
                "POST",
                { name: trimmed,visibility },
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
          <Form.Item name="visibility" label="公开范围" extra="公开后，系统内有选款登记查看权限的用户可访问；保护区域权限继续生效。">
            <Select options={visibilityOptions}/>
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
