import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  App,
  Button,
  Checkbox,
  Drawer,
  Dropdown,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from "antd";
import {
  FilterOutlined,
  SettingOutlined,
  PlusOutlined,
  ReloadOutlined,
  DownloadOutlined,
} from "@ant-design/icons";
import { Link } from "react-router-dom";
import { api, queryClient } from "./api";
import {
  Header,
  Row,
  Status,
  useCan,
  useUser,
  useList,
  useOptions,
  QueryState,
} from "./shared";
import { configurations, FieldControl } from "./master";
import { BatchEditor } from "./batch-editor";
import { downloadWorkbook } from "./sheet-excel";
import { archiveFieldIds as ids } from "../../../packages/contracts/src/product-archive";
const base = configurations.products.fields.map((f) => ({
  ...f,
  label:
    f.key === "categoryId"
      ? "三级分类"
      : f.key === "season"
        ? "适穿季节"
        : f.key === "mainImageUrl"
          ? "图片"
          : f.label,
}));
const defaultColumns = [
  "mainImageUrl",
  "styleNo",
  ids.supplierStyle,
  "name",
  "categoryId",
  "brandId",
  "defaultSupplierId",
  "year",
  "season",
  "tagPrice",
  ids.unitPrice,
  ids.customColor,
  ids.standardColor,
  ids.sizeRange,
  ids.vipStatus,
  "status",
];
function CustomControl({ field, ...props }: any) {
  if (field.type === "number")
    return (
      <InputNumber
        {...props}
        style={{ width: "100%" }}
        min={-1e12}
        max={1e12}
      />
    );
  if (field.type === "select")
    return (
      <Select
        {...props}
        allowClear
        options={field.options.map((v: string) => ({ value: v, label: v }))}
      />
    );
  return (
    <Input
      {...props}
      type={field.type === "date" ? "date" : "text"}
      maxLength={1000}
    />
  );
}
export function ProductArchive() {
  const { message, modal } = App.useApp(),
    user = useUser(),
    canEdit = useCan("product.update"),
    canCreate = useCan("product.create");
  const prefKey = "product-archive-columns:" + user.id;
  const [visible, setVisible] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(prefKey) || "null");
      return Array.isArray(v)
        ? Array.from(
            new Set(["styleNo", ...v.filter((x) => typeof x === "string")]),
          )
        : defaultColumns;
    } catch {
      return defaultColumns;
    }
  });
  const [compact, setCompact] = useState(true),
    [settings, setSettings] = useState(false),
    [filterOpen, setFilterOpen] = useState(false),
    [fieldsOpen, setFieldsOpen] = useState(false),
    [batch, setBatch] = useState(false),
    [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(""),
    [filters, setFilters] = useState<Row>({}),
    [editing, setEditing] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<React.Key[]>([]),
    [saveKey, setSaveKey] = useState(crypto.randomUUID());
  const [editForm] = Form.useForm(),
    [createForm] = Form.useForm(),
    [filterForm] = Form.useForm();
  const definitions = useQuery({
    queryKey: ["product-fields"],
    queryFn: async () => (await api("/product-fields")).data as Row[],
  });
  const custom = (definitions.data || []).filter((f) => f.active);
  const fields = [
    ...base,
    ...custom.map((f) => ({ key: f.id, label: f.name, custom: f })),
    { key: "vipTitleLength", label: "标题字数", computed: true },
    { key: "priceCompliance", label: "吊牌价限价是否达标", computed: true },
  ] as any[];
  const order = [
    "styleNo",
    ids.supplierStyle,
    "mainImageUrl",
    "categoryId",
    ids.unitPrice,
    ids.customColor,
    ids.standardColor,
    ids.sizeRange,
    ids.vipStatus,
    ids.minDiscount,
    ids.selectionBatch,
    "season",
    ids.vipTitle,
    "vipTitleLength",
    ids.vipPriceLimit,
    ids.certificatePrice,
    "priceCompliance",
    ids.priceWhitelist,
    ids.certificateName,
    ids.composition,
    ids.safetyClass,
    ids.executionStandard,
    ids.washingCheck,
    ids.materialCheck,
    ids.exempt,
    ids.careDescription,
    "remark",
    ids.reportNo,
  ];
  fields.sort(
    (a, b) =>
      (order.includes(a.key) ? order.indexOf(a.key) : 100) -
      (order.includes(b.key) ? order.indexOf(b.key) : 100),
  );
  const computed = (key: string, r: Row) =>
    key === "vipTitleLength"
      ? r.customFields?.[ids.vipTitle]
        ? Array.from(String(r.customFields[ids.vipTitle])).length
        : "—"
      : r.customFields?.[ids.vipPriceLimit] != null &&
          r.customFields?.[ids.vipPriceLimit] !== "" &&
          r.customFields?.[ids.certificatePrice] != null &&
          r.customFields?.[ids.certificatePrice] !== ""
        ? Number(r.customFields[ids.certificatePrice]) <=
          Number(r.customFields[ids.vipPriceLimit])
          ? "达标"
          : "不达标"
        : "待补充";
  const q = useList("/products", { q: search, ...filters });
  const categories = useOptions("/categories?forProduct=true"),
    brands = useOptions("/brands"),
    suppliers = useOptions("/suppliers");
  const refs: Row = {
    categoryId: categories.data?.data,
    brandId: brands.data?.data,
    defaultSupplierId: suppliers.data?.data,
  };
  const showColumns = (keys: string[]) => {
    const next = Array.from(new Set(["styleNo", ...keys]));
    setVisible(next);
    try {
      localStorage.setItem(prefKey, JSON.stringify(next));
    } catch {
      message.warning("浏览器未允许保存列偏好，本次设置仍有效");
    }
  };
  const begin = (r: Row) => {
    setEditing(r);
    editForm.resetFields();
    editForm.setFieldsValue({ ...r, ...r.customFields });
    setSaveKey(crypto.randomUUID());
  };
  const control = (f: any) =>
    f.custom ? (
      <CustomControl field={f.custom} />
    ) : (
      <FieldControl field={f} resource="products" />
    );
  const display = (f: any, r: Row) => {
    if (f.computed) return computed(f.key, r);
    const v = f.custom ? r.customFields?.[f.key] : r[f.key];
    if (v == null || v === "") return <span className="secondary">—</span>;
    if (f.key === "status") return <Status value={v} />;
    if (f.key === "mainImageUrl")
      return /^https?:\/\//i.test(v) ? (
        <Image src={v} width={32} height={38} style={{ objectFit: "cover" }} />
      ) : (
        "—"
      );
    if (refs[f.key]) {
      const ref = refs[f.key].find((x: Row) => x.id === v);
      return ref?.pathName || ref?.name || "资料 #" + v;
    }
    if (f.key === "styleNo")
      return editing ? String(v) : <Link to={"/products/" + r.id}>{v}</Link>;
    return String(v);
  };
  const save = async (newItem = false) => {
    const form = newItem ? createForm : editForm;
    let values;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    try {
      const body: Row = {};
      const extras: Row = {};
      for (const f of fields) {
        if (!(f.key in values)) continue;
        let v = values[f.key];
        if (v === undefined || v === "") v = null;
        const old = f.custom
          ? editing?.customFields?.[f.key]
          : editing?.[f.key];
        if (!newItem && (old ?? null) === v) continue;
        if (f.custom) extras[f.key] = v;
        else body[f.key] = v;
      }
      if (Object.keys(extras).length) body.customFields = extras;
      if (!newItem && !Object.keys(body).length) {
        setEditing(null);
        return;
      }
      if (!newItem) body.expectedUpdatedAt = editing!.updatedAt;
      await api(
        "/products" + (newItem ? "" : "/" + editing!.id),
        newItem ? "POST" : "PATCH",
        body,
        saveKey,
      );
      message.success("商品已保存");
      setEditing(null);
      setCreating(false);
      await queryClient.invalidateQueries({ queryKey: ["/products"] });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const inputItem = (f: any) => (
    <Form.Item
      name={f.key}
      style={{ margin: 0 }}
      rules={[{ required: !!f.required, message: "请填写" + f.label }]}
    >
      {control(f)}
    </Form.Item>
  );
  const filteredCount = Object.keys(filters).length;
  return (
    <>
      <Header
        title="商品档案"
        subtitle="按款管理商品资料，点击编辑可在当前表格修改。"
        extra={
          <>
            {(canCreate || canEdit) && (
              <Button disabled={!!editing} onClick={() => setBatch(true)}>
                表格导入
              </Button>
            )}
            {canCreate && (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={!!editing}
                onClick={() => {
                  createForm.resetFields();
                  createForm.setFieldsValue({ status: "ACTIVE" });
                  setSaveKey(crypto.randomUUID());
                  setCreating(true);
                }}
              >
                新增商品
              </Button>
            )}
          </>
        }
      />
      <section className="product-archive">
        <div className="product-archive-toolbar">
          <Input.Search
            aria-label="搜索商品"
            placeholder="搜索款号 / 商品名称"
            allowClear
            disabled={!!editing}
            style={{ width: 280 }}
            onSearch={(v) => {
              setSearch(v);
              q.setPage(1);
              setSelected([]);
            }}
          />
          <Button
            icon={<FilterOutlined />}
            disabled={!!editing}
            onClick={() => {
              filterForm.resetFields();
              const customFilters = filters.customFilters
                ? JSON.parse(filters.customFilters)
                : [];
              filterForm.setFieldsValue({
                ...filters,
                ...Object.fromEntries(
                  customFilters.map((f: Row) => [f.id, f.value]),
                ),
              });
              setFilterOpen(true);
            }}
          >
            筛选{filteredCount ? " · 已设置" : ""}
          </Button>
          {!!filteredCount && (
            <Button
              type="text"
              disabled={!!editing}
              onClick={() => {
                setFilters({});
                setSelected([]);
                q.setPage(1);
              }}
            >
              清空筛选
            </Button>
          )}
          <span className="product-toolbar-spacer" />
          <Button
            icon={<DownloadOutlined />}
            disabled={!q.items.length || !!editing}
            onClick={async () => {
              try {
                const columns = fields.filter((f) => visible.includes(f.key));
                await downloadWorkbook(
                  "商品档案",
                  columns.map((f) => ({ key: f.key, label: f.label })),
                  q.items
                    .filter(
                      (r: Row) => !selected.length || selected.includes(r.id),
                    )
                    .map((r: Row) =>
                      Object.fromEntries(
                        columns.map((f) => [
                          f.key,
                          f.computed
                            ? computed(f.key, r)
                            : f.custom
                              ? r.customFields?.[f.key]
                              : refs[f.key]
                                ? refs[f.key].find(
                                    (x: Row) => x.id === r[f.key],
                                  )?.pathName ||
                                  refs[f.key].find(
                                    (x: Row) => x.id === r[f.key],
                                  )?.name ||
                                  r[f.key]
                                : f.key === "status"
                                  ? (
                                      {
                                        ACTIVE: "正常",
                                        STOPPED: "停售",
                                        ARCHIVED: "已归档",
                                      } as Row
                                    )[r.status]
                                  : r[f.key],
                        ]),
                      ),
                    ),
                );
              } catch (e) {
                message.error((e as Error).message);
              }
            }}
          >
            {selected.length ? "导出所选" : "导出当前页"}
          </Button>
          <Button
            aria-label="刷新商品"
            icon={<ReloadOutlined />}
            disabled={!!editing}
            onClick={() => void q.refetch()}
          />
          <Dropdown
            trigger={["click"]}
            disabled={!!editing}
            menu={{
              items: [
                { key: "columns", label: "列设置" },
                { key: "filters", label: "筛选设置" },
                ...(canEdit ? [{ key: "custom", label: "自定义字段" }] : []),
                {
                  key: "density",
                  label: compact ? "切换标准行高" : "切换紧凑行高",
                },
              ],
              onClick: ({ key }) => {
                if (key === "columns") setSettings(true);
                if (key === "filters") {
                  filterForm.resetFields();
                  filterForm.setFieldsValue({
                    ...filters,
                    ...Object.fromEntries(
                      (filters.customFilters
                        ? JSON.parse(filters.customFilters)
                        : []
                      ).map((f: Row) => [f.id, f.value]),
                    ),
                  });
                  setFilterOpen(true);
                }
                if (key === "custom") setFieldsOpen(true);
                if (key === "density") setCompact(!compact);
              },
            }}
          >
            <Button aria-label="商品表格设置" icon={<SettingOutlined />} />
          </Dropdown>
        </div>
        <QueryState
          error={q.error || definitions.error}
          reload={() => {
            void q.refetch();
            void definitions.refetch();
          }}
        />
        <Form
          form={editForm}
          component={false}
          onValuesChange={() => setSaveKey(crypto.randomUUID())}
        >
          <Table<Row>
            size={compact ? "small" : "middle"}
            bordered
            rowKey="id"
            dataSource={q.items}
            loading={q.isLoading}
            rowSelection={{
              selectedRowKeys: selected,
              onChange: setSelected,
              getCheckboxProps: () => ({ disabled: !!editing }),
            }}
            columns={[
              {
                title: "序号",
                key: "index",
                width: 62,
                render: (_, r, i) => (q.page - 1) * 20 + i + 1,
              },
              ...fields
                .filter((f) => visible.includes(f.key))
                .map((f) => ({
                  title: f.label,
                  dataIndex: f.key,
                  key: f.key,
                  width:
                    f.key === "mainImageUrl"
                      ? editing
                        ? 180
                        : 65
                      : f.key === "name" || f.key === "remark"
                        ? 220
                        : f.key === "categoryId"
                          ? 180
                          : f.key === "year"
                            ? 80
                            : f.custom?.type === "number" ||
                                f.key === "season" ||
                                f.key === "tagPrice"
                              ? 100
                              : [
                                    ids.customColor,
                                    ids.standardColor,
                                    ids.sizeRange,
                                  ].includes(f.key)
                                ? 110
                                : 150,
                  render: (_: unknown, r: Row) =>
                    editing?.id === r.id && !f.computed ? (
                      inputItem(f)
                    ) : (
                      <div className="product-cell-value">{display(f, r)}</div>
                    ),
                })),
              {
                title: "操作",
                key: "actions",
                fixed: "right" as const,
                width: 150,
                render: (_, r) => (
                  <Space size={4}>
                    {editing?.id === r.id ? (
                      <>
                        <Button
                          type="link"
                          size="small"
                          loading={busy}
                          onClick={() => void save()}
                        >
                          保存
                        </Button>
                        <Button
                          type="link"
                          size="small"
                          disabled={busy}
                          onClick={() => setEditing(null)}
                        >
                          取消
                        </Button>
                      </>
                    ) : (
                      <>
                        <Link to={"/products/" + r.id}>查看</Link>
                        {canEdit && (
                          <Button
                            type="link"
                            size="small"
                            disabled={!!editing}
                            onClick={() => begin(r)}
                          >
                            编辑
                          </Button>
                        )}
                      </>
                    )}
                  </Space>
                ),
              },
            ]}
            scroll={{ x: "max-content", y: "calc(100vh - 285px)" }}
            pagination={{
              current: q.page,
              total: q.total,
              pageSize: 20,
              showSizeChanger: false,
              disabled: !!editing,
              onChange: (p) => {
                q.setPage(p);
                setSelected([]);
              },
              showTotal: (t) =>
                `共 ${t} 款${selected.length ? " · 已选 " + selected.length + " 款" : ""}`,
            }}
          />
        </Form>
      </section>
      <Drawer
        title="列设置"
        open={settings}
        onClose={() => setSettings(false)}
        width={340}
        extra={
          <Button onClick={() => showColumns(defaultColumns)}>恢复默认</Button>
        }
      >
        <p className="secondary">
          勾选显示列，取消勾选隐藏。款号保留用于识别商品。
        </p>
        <Checkbox.Group
          value={visible}
          onChange={(v) => showColumns(v as string[])}
          className="product-column-options"
        >
          {["基础资料", "唯品会", "合格证", "质检与护理", "自定义字段"].map(
            (group) => (
              <section key={group}>
                <h4>{group}</h4>
                {fields
                  .filter(
                    (f) =>
                      (f.custom?.groupName ||
                        (f.computed ? "唯品会" : "基础资料")) === group,
                  )
                  .map((f) => (
                    <Checkbox
                      key={f.key}
                      value={f.key}
                      disabled={f.key === "styleNo"}
                    >
                      {f.label}
                    </Checkbox>
                  ))}
              </section>
            ),
          )}
        </Checkbox.Group>
      </Drawer>
      <Drawer
        title="筛选商品"
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        width={400}
        extra={
          <Button
            type="primary"
            onClick={() => {
              const v = filterForm.getFieldsValue();
              const next: Row = {},
                customFilters: Row[] = [];
              for (const [k, value] of Object.entries(v)) {
                if (value === undefined || value === null || value === "")
                  continue;
                if (custom.some((f) => f.id === k))
                  customFilters.push({ id: k, value: String(value) });
                else if (
                  [
                    "categoryId",
                    "brandId",
                    "defaultSupplierId",
                    "year",
                    "season",
                    "status",
                  ].includes(k)
                )
                  next[k] = value;
              }
              if (customFilters.length)
                next.customFilters = JSON.stringify(customFilters);
              setFilters(next);
              q.setPage(1);
              setSelected([]);
              setFilterOpen(false);
            }}
          >
            应用筛选
          </Button>
        }
      >
        <p className="secondary">
          多个条件同时满足；文本自定义字段按包含匹配，其他字段按精确匹配。
        </p>
        <Form form={filterForm} layout="vertical">
          {fields
            .filter(
              (f) =>
                f.custom ||
                [
                  "categoryId",
                  "brandId",
                  "defaultSupplierId",
                  "year",
                  "season",
                  "status",
                ].includes(f.key),
            )
            .map((f) => (
              <Form.Item key={f.key} name={f.key} label={f.label}>
                {control(f)}
              </Form.Item>
            ))}
        </Form>
        <Button onClick={() => filterForm.resetFields()}>重置条件</Button>
      </Drawer>
      <Drawer
        title="新增商品"
        open={creating}
        width={680}
        onClose={() => {
          if (!busy) setCreating(false);
        }}
        extra={
          <Button type="primary" loading={busy} onClick={() => void save(true)}>
            保存商品
          </Button>
        }
      >
        <Form
          form={createForm}
          layout="vertical"
          onValuesChange={() => setSaveKey(crypto.randomUUID())}
          className="product-create-grid"
        >
          {fields
            .filter((f) => !f.computed)
            .map((f) => (
              <Form.Item
                key={f.key}
                label={f.label}
                name={f.key}
                rules={[
                  { required: !!f.required, message: "请填写" + f.label },
                ]}
              >
                {control(f)}
              </Form.Item>
            ))}
        </Form>
      </Drawer>
      {fieldsOpen && (
        <FieldSettings
          definitions={definitions.data || []}
          onClose={() => setFieldsOpen(false)}
          onCreated={(key) => showColumns([...visible, key])}
        />
      )}
      {batch && (
        <BatchEditor
          title="商品档案"
          resource="products"
          fields={fields
            .filter((f) => !f.computed)
            .map((f) =>
              f.custom
                ? {
                    key: f.key,
                    label: f.label,
                    type: undefined,
                    options:
                      f.custom.type === "select"
                        ? f.custom.options.map((x: string) => ({
                            value: x,
                            label: x,
                          }))
                        : undefined,
                  }
                : f,
            )}
          initial={q.items.map((r: Row) => ({ ...r, ...r.customFields }))}
          saveRow={async (body, key, original) => {
            const values: Row = {},
              customFields: Row = {};
            for (const [k, v] of Object.entries(body)) {
              if (custom.some((f) => f.id === k)) {
                const f = custom.find((f) => f.id === k)!;
                if (
                  f.type === "number" &&
                  v != null &&
                  v !== "" &&
                  !Number.isFinite(Number(v))
                )
                  throw new Error("请正确填写" + f.name + "的数值");
                customFields[k] =
                  f.type === "number" && v != null && v !== "" ? Number(v) : v;
              } else values[k] = v;
            }
            if (Object.keys(customFields).length)
              values.customFields = customFields;
            return api(
              "/products" + (original ? "/" + original.id : ""),
              original ? "PATCH" : "POST",
              {
                ...values,
                ...(original ? { expectedUpdatedAt: original.updatedAt } : {}),
              },
              key,
            );
          }}
          defaults={{ status: "ACTIVE" }}
          allowCreate={canCreate}
          allowEdit={canEdit}
          onClose={() => setBatch(false)}
        />
      )}
    </>
  );
}
function FieldSettings({
  definitions,
  onClose,
  onCreated,
}: {
  definitions: Row[];
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const [form] = Form.useForm(),
    [editing, setEditing] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(crypto.randomUUID());
  const type = Form.useWatch("type", form),
    { message } = App.useApp();
  const start = (r?: Row) => {
    setEditing(r || null);
    form.resetFields();
    form.setFieldsValue(
      r
        ? { ...r, options: r.options.join("\n") }
        : { type: "text", active: true },
    );
    setKey(crypto.randomUUID());
  };
  return (
    <Modal
      title="自定义商品字段"
      open
      width={720}
      onCancel={onClose}
      footer={null}
    >
      <p className="secondary">
        字段定义对所有商品共享；可改名或停用，停用不删除已有数据。已有字段类型和选项保持不变。
      </p>
      <div className="product-field-list">
        {definitions.map((f) => (
          <div key={f.id}>
            <span>
              {f.name}{" "}
              <Tag>
                {
                  (
                    {
                      text: "文本",
                      number: "数字",
                      date: "日期",
                      select: "单选",
                    } as Row
                  )[f.type]
                }
              </Tag>
              {!f.active && <Tag>已停用</Tag>}
            </span>
            <Button type="link" onClick={() => start(f)}>
              设置
            </Button>
          </div>
        ))}
      </div>
      <Button icon={<PlusOutlined />} onClick={() => start()}>
        新增字段
      </Button>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ type: "text", active: true }}
        onValuesChange={() => setKey(crypto.randomUUID())}
        onFinish={async (v) => {
          setBusy(true);
          try {
            const b = {
              ...v,
              options:
                v.type === "select"
                  ? String(v.options || "")
                      .split("\n")
                      .map((x) => x.trim())
                      .filter(Boolean)
                  : [],
              ...(editing ? { expectedUpdatedAt: editing.updatedAt } : {}),
            };
            const r = await api(
              "/product-fields" + (editing ? "/" + editing.id : ""),
              editing ? "PATCH" : "POST",
              b,
              key,
            );
            await queryClient.invalidateQueries({
              queryKey: ["product-fields"],
            });
            if (!editing) onCreated(r.data.id);
            message.success("字段已保存");
            start();
          } catch (e) {
            message.error((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
        style={{ marginTop: 16 }}
      >
        <Form.Item
          name="name"
          label="字段名称"
          rules={[{ required: true, message: "请输入字段名称" }]}
        >
          <Input maxLength={40} />
        </Form.Item>
        <Form.Item name="type" label="字段类型">
          <Select
            disabled={!!editing}
            options={[
              { value: "text", label: "文本" },
              { value: "number", label: "数字" },
              { value: "date", label: "日期" },
              { value: "select", label: "单选" },
            ]}
          />
        </Form.Item>
        {type === "select" && (
          <Form.Item
            name="options"
            label="选项（每行一项）"
            rules={[{ required: true }]}
          >
            <Input.TextArea disabled={!!editing} rows={3} />
          </Form.Item>
        )}
        <Form.Item name="active" label="启用" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={busy}>
          {editing ? "保存设置" : "创建字段"}
        </Button>
      </Form>
    </Modal>
  );
}
