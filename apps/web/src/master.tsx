import { Table } from "./data-table";
import { useState } from "react";
import {
  App,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Tag,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { Link, useParams } from "react-router-dom";
import { api, queryClient } from "./api";
import { BatchEditor } from "./batch-editor";
import {
  Header,
  Row,
  Status,
  useCan,
  useList,
  useOptions,
  options,
  QueryState,
  empty,
  Refresh,
  amount,
} from "./shared";
type Field = {
  key: string;
  label: string;
  required?: boolean;
  type?: "number" | "money" | "status";
  source?: string;
  optionLabel?: string;
  form?: boolean;
  batch?: boolean;
};
export const configurations: Record<
  string,
  {
    title: string;
    description: string;
    fields: Field[];
    permission: string;
    columns: string[];
  }
> = {
  "color-mappings": {
    title: "颜色映射",
    description: "维护三位色码及参考名称。花色为 025，044 已作废。",
    permission: "product",
    fields: [
      { key: "code", label: "色码（3 位）", required: true },
      { key: "name", label: "参考颜色名称", required: true },
      { key: "status", label: "状态", type: "status" },
    ],
    columns: ["code", "name", "status"],
  },
  "size-mappings": {
    title: "尺码映射",
    description: "维护三位尺码代码与名称。已引用的编码可停用，不能删除或改码。",
    permission: "product",
    fields: [
      { key: "code", label: "尺码代码（3 位）", required: true },
      { key: "name", label: "尺码名称", required: true },
      { key: "status", label: "状态", type: "status" },
    ],
    columns: ["code", "name", "status"],
  },
  products: {
    title: "商品档案",
    description: "以款号建立商品资料，将每一个颜色与尺码连接到经营数据。",
    permission: "product",
    fields: [
      { key: "styleNo", label: "款号", required: true },
      { key: "name", label: "商品名称", required: true },
      {
        key: "categoryId",
        label: "品类",
        required: true,
        source: "/categories?forProduct=true",
        optionLabel: "pathName",
      },
      { key: "brandId", label: "品牌", source: "/brands" },
      { key: "defaultSupplierId", label: "默认供应商", source: "/suppliers" },
      { key: "year", label: "年份", type: "number" },
      { key: "season", label: "季节" },
      { key: "tagPrice", label: "吊牌价", type: "money" },
      { key: "mainImageUrl", label: "主图网址" },
      { key: "remark", label: "备注" },
      { key: "status", label: "状态", type: "status" },
    ],
    columns: ["styleNo", "name", "year", "season", "tagPrice", "status"],
  },
  skus: {
    title: "SKU 管理",
    description: "库存、采购和入库都精确到每一个 SKU。",
    permission: "product",
    fields: [
      {
        key: "productId",
        label: "所属商品",
        source: "/products",
        required: true,
      },
      { key: "skuCode", label: "SKU 编码", required: true },
      { key: "barcode", label: "条码" },
      {
        key: "colorCode",
        label: "颜色代码",
        required: true,
        source: "/color-mappings",
      },
      { key: "colorName", label: "颜色名称", required: true },
      {
        key: "sizeCode",
        label: "尺码代码",
        required: true,
        source: "/size-mappings",
      },
      { key: "sizeName", label: "尺码名称", required: true },
      { key: "costPrice", label: "采购成本", type: "money" },
      { key: "status", label: "状态", type: "status" },
    ],
    columns: [
      "skuCode",
      "colorName",
      "sizeName",
      "barcode",
      "costPrice",
      "status",
    ],
  },
  suppliers: {
    title: "供应商",
    description: "管理采购合作伙伴、交期和最小起订量。",
    permission: "supplier",
    fields: [
      { key: "supplierCode", label: "供应商编码", required: true },
      { key: "name", label: "供应商名称", required: true },
      { key: "contactName", label: "联系人" },
      { key: "phone", label: "联系电话" },
      { key: "address", label: "地址" },
      { key: "defaultLeadTimeDays", label: "默认交期（天）", type: "number" },
      { key: "moq", label: "MOQ（仅提示）", type: "number" },
      { key: "status", label: "状态", type: "status" },
    ],
    columns: [
      "supplierCode",
      "name",
      "contactName",
      "phone",
      "defaultLeadTimeDays",
      "status",
    ],
  },
  warehouses: {
    title: "仓库管理",
    description: "分仓记录库存，让每一件货都有明确归属。",
    permission: "warehouse",
    fields: [
      { key: "code", label: "仓库编码", required: true },
      { key: "name", label: "仓库名称", required: true },
      { key: "address", label: "地址" },
      { key: "status", label: "状态", type: "status" },
    ],
    columns: ["code", "name", "address", "status"],
  },
  categories: {
    title: "品类",
    description: "按一级、二级、三级建立服装品类；商品只能选择末级品类。",
    permission: "product",
    fields: [
      { key: "level1Name", label: "一级品类", form: false, batch: false },
      { key: "level2Name", label: "二级品类", form: false, batch: false },
      { key: "level3Name", label: "三级品类", form: false, batch: false },
      { key: "code", label: "品类编码", required: true },
      { key: "name", label: "名称", required: true },
      {
        key: "parentId",
        label: "上级品类（一级不选，二级选一级，三级选二级）",
        source: "/categories",
        optionLabel: "pathName",
        batch: false,
      },
      {
        key: "parentCode",
        label: "上级品类编码（表格按父级到子级顺序填写）",
        form: false,
      },
      { key: "status", label: "状态", type: "status" },
    ],
    columns: [
      "level1Name",
      "level2Name",
      "level3Name",
      "code",
      "status",
    ],
  },
  brands: {
    title: "品牌",
    description: "维护商品品牌资料。",
    permission: "product",
    fields: [
      { key: "code", label: "品牌编码", required: true },
      { key: "name", label: "名称", required: true },
      { key: "status", label: "状态", type: "status" },
    ],
    columns: ["code", "name", "status"],
  },
};
function Reference({ path, label }: { path: string; label?: string }) {
  const q = useOptions(path);
  return (
    <Select
      showSearch
      allowClear
      optionFilterProp="label"
      options={options(q.data, label)}
      loading={q.isLoading}
    />
  );
}
function FieldInput({ field, resource }: { field: Field; resource: string }) {
  if (field.source)
    return <Reference path={field.source} label={field.optionLabel} />;
  if (field.type === "status")
    return (
      <Select
        options={(resource === "products"
          ? ["ACTIVE", "STOPPED", "ARCHIVED"]
          : ["ACTIVE", "INACTIVE"]
        ).map((v) => ({ value: v, label: <Status value={v} /> }))}
      />
    );
  if (field.type === "number")
    return <InputNumber min={0} precision={0} style={{ width: "100%" }} />;
  if (field.type === "money")
    return (
      <InputNumber stringMode min="0" precision={2} style={{ width: "100%" }} />
    );
  return <Input />;
}
// Form.Item must receive its input directly; render function preserves controlled field props.
export function FieldControl({ field, resource, ...props }: any) {
  const q = useOptions(field.source || "/brands", !!field.source);
  if (field.source)
    return (
      <Select
        {...props}
        showSearch
        allowClear
        optionFilterProp="label"
        options={
          field.source.endsWith("-mappings")
            ? (q.data?.data || [])
                .filter((x: Row) => x.status === "ACTIVE")
                .map((x: Row) => ({
                  value: x.code,
                  label: `${x.code} · ${x.name}`,
                }))
            : options(q.data, field.optionLabel).filter((option: Row) => {
                const item = (q.data?.data || []).find(
                  (row: Row) => String(row.id) === String(option.value),
                );
                return !(
                  resource === "categories" &&
                  field.key === "parentId" &&
                  Number(item?.level || 1) >= 3
                );
              })
        }
        loading={q.isLoading}
      />
    );
  if (field.type === "status")
    return (
      <Select
        {...props}
        options={(resource === "products"
          ? ["ACTIVE", "STOPPED", "ARCHIVED"]
          : ["ACTIVE", "INACTIVE"]
        ).map((v) => ({ value: v, label: <Status value={v} /> }))}
      />
    );
  if (["number", "money"].includes(field.type))
    return (
      <InputNumber
        {...props}
        stringMode={field.type === "money"}
        min={0}
        precision={field.type === "money" ? 2 : 0}
        style={{ width: "100%" }}
      />
    );
  return <Input {...props} />;
}
export function MasterPage({
  resource: explicit,
  filter,
}: {
  resource?: string;
  filter?: Row;
}) {
  const { resource: param } = useParams();
  const resource = explicit || param || "products",
    conf = configurations[resource];
  const [search, setSearch] = useState("");
  const [batch, setBatch] = useState(false);
  const q = useList("/" + resource, {
    ...filter,
    ...(search ? { q: search } : {}),
  });
  const [editing, setEditing] = useState<Row | null>(null),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(crypto.randomUUID());
  const [form] = Form.useForm();
  const { message, modal } = App.useApp();
  const create = useCan(
    conf.permission === "product"
      ? ["brands", "categories", "color-mappings", "size-mappings"].includes(
          resource,
        )
        ? "product.update"
        : "product.create"
      : conf.permission + ".manage",
  );
  const edit = useCan(
    conf.permission === "product"
      ? "product.update"
      : conf.permission + ".manage",
  );
  const begin = (row?: Row) => {
    setEditing(row || null);
    form.resetFields();
    form.setFieldsValue(row || { status: "ACTIVE", ...filter });
    setKey(crypto.randomUUID());
    setOpen(true);
  };
  const save = async () => {
    const values = await form.validateFields();
    setBusy(true);
    try {
      const body = Object.fromEntries(
        Object.entries(values).filter(([, v]) => v !== undefined && v !== ""),
      );
      if (resource === "skus" && editing) delete body.productId;
      await api(
        "/" + resource + (editing ? "/" + editing.id : ""),
        editing ? "PATCH" : "POST",
        body,
        key,
      );
      message.success("已保存");
      setBusy(false);
      setOpen(false);
      await queryClient.invalidateQueries();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const columns = conf.columns.map((k) => ({
    title: conf.fields.find((f) => f.key === k)?.label,
    dataIndex: k,
    render: (v: any, row: Row) =>
      k === "status" ? (
        <Status value={v} />
      ) : k === "styleNo" ? (
        <Link to={"/products/" + row.id}>{v}</Link>
      ) : ["costPrice", "tagPrice"].includes(k) ? (
        amount(v)
      ) : (
        (v ?? "—")
      ),
  }));
  return (
    <>
      <Header
        title={conf.title}
        subtitle={conf.description}
        extra={
          <>
            {(create || edit) && (
              <Button onClick={() => setBatch(true)}>
                表格编辑 / Excel 导入
              </Button>
            )}
            {resource === "categories" && create && (
              <Button
                danger
                onClick={() =>
                  modal.confirm({
                    title: "初始化女装三级品类？",
                    content:
                      "将清空当前未被商品使用的品类，并建立女装 / 服饰配件、女上装、女下装、裙装等三级品类。商品、SKU、库存和采购数据不会被删除；如已有商品关联品类，系统会拒绝执行。",
                    okText: "清空并初始化",
                    cancelText: "取消",
                    onOk: async () => {
                      try {
                        const result = await api(
                          "/categories/initialize",
                          "POST",
                          {},
                          crypto.randomUUID(),
                        );
                        await queryClient.invalidateQueries();
                        message.success(
                          `已清空 ${result.data.cleared} 条并建立 ${result.data.created} 条品类`,
                        );
                      } catch (e) {
                        message.error((e as Error).message);
                        throw e;
                      }
                    },
                  })
                }
              >
                初始化女装三级品类
              </Button>
            )}
            {create && (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => begin()}
              >
                新建{resource === "products" ? "商品" : "资料"}
              </Button>
            )}
          </>
        }
      />
      <Card className="surface">
        <div className="table-toolbar">
          <Input.Search
            placeholder="搜索编码或名称"
            allowClear
            onSearch={(v) => {
              setSearch(v);
              q.setPage(1);
            }}
            style={{ maxWidth: 320 }}
          />
          <Refresh onClick={() => q.refetch()} />
        </div>
        <QueryState error={q.error} reload={() => q.refetch()} />
        <Table<Row>
          rowKey="id"
          loading={q.isLoading}
          dataSource={q.items}
          columns={[
            ...columns,
            {
              title: "操作",
              key: "actions",
              render: (_, r) => (
                <Space>
                  {resource === "products" && (
                    <Link to={"/products/" + r.id}>查看</Link>
                  )}
                  {edit &&
                    ["color-mappings", "size-mappings"].includes(resource) && (
                      <Button
                        danger
                        type="link"
                        onClick={() =>
                          modal.confirm({
                            title: "删除此映射？",
                            content: `${r.code} · ${r.name}。已被 SKU 使用的映射不能删除。`,
                            onOk: async () => {
                              try {
                                await api(
                                  `/${resource}/${r.id}`,
                                  "DELETE",
                                  undefined,
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
                  {edit && (
                    <Button type="link" onClick={() => begin(r)}>
                      编辑
                    </Button>
                  )}
                </Space>
              ),
            },
          ]}
          locale={empty}
          pagination={{
            current: q.page,
            total: q.total,
            pageSize: 20,
            onChange: q.setPage,
            showSizeChanger: false,
          }}
          scroll={{ x: 800 }}
        />
      </Card>
      <Drawer
        title={editing ? "编辑资料" : "新建资料"}
        open={open}
        onClose={() => setOpen(false)}
        size="large"
        extra={
          <Button
            aria-label="保存"
            type="primary"
            loading={busy}
            onClick={save}
          >
            保存
          </Button>
        }
      >
        <Form
          form={form}
          layout="vertical"
          onValuesChange={() => setKey(crypto.randomUUID())}
        >
          {conf.fields.filter((f) => f.form !== false).map((f) => (
            <Form.Item
              key={f.key}
              name={f.key}
              label={f.label}
              rules={[{ required: f.required, message: "请填写" + f.label }]}
            >
              <FieldControl
                field={f}
                resource={resource}
                disabled={f.key === "productId" && !!editing}
              />
            </Form.Item>
          ))}
        </Form>
        <Tag>内部商品资料无需唯品会 ID</Tag>
      </Drawer>
      {batch && (
        <BatchEditor
          title={conf.title}
          resource={resource}
          fields={conf.fields.filter((f) => f.batch !== false).map((f) => ({
            ...f,
            readonly:
              f.key === "productId"
                ? (row: Row) => !!row.id || !!filter?.productId
                : !edit
                  ? (row: Row) => !!row.id
                  : false,
          }))}
          initial={q.items}
          defaults={{ status: "ACTIVE", ...filter }}
          allowCreate={create}
          allowEdit={edit}
          onClose={() => setBatch(false)}
        />
      )}
    </>
  );
}
export { FieldInput };
