import { useQualificationOcr } from "./qualification-ocr";
import { BrandVideo } from "./brand-video";
import { useState, useEffect } from "react";
import { prepareUpload, readUpload } from "./upload-file";
import { qualificationFieldError } from "../../../packages/contracts/src/qualification-validation";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Alert,
  App,
  AutoComplete,
  Badge,
  Button,
  Card,
  Checkbox,
  Drawer,
  Descriptions,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { api, queryClient } from "./api";
import { Header, Row, useCan, when } from "./shared";
import { BatchEditor } from "./batch-editor";
import {
  sizes,
  offReasons,
  splitValues,
} from "../../../packages/contracts/src/supply";
const states: Row = {
  DRAFT: "待填写",
  PENDING: "待审核",
  APPROVED: "审核通过",
  REJECTED: "已驳回",
};
const fileSrc = (id: string) => "/api/v1/supply/files/" + id;
const refresh = () =>
  queryClient.invalidateQueries({
    predicate: (q) => String(q.queryKey[0]).startsWith("supply"),
  });
async function send(path: string, body: unknown, method = "POST") {
  return api("/supply" + path, method, body, crypto.randomUUID());
}
export function SupplierRegister() {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  return (
    <div className="supplier-registration">
      <aside className="supplier-registration-brand">
        <BrandVideo />
        <img src="/xuti-wordmark.png" alt="XUTI 序缇" />
        <div className="supplier-registration-story">
          <span className="supplier-registration-eyebrow">
            XUTI SUPPLY CHAIN
          </span>
          <h1>
            好产品，
            <br />
            从这里连接。
          </h1>
          <p>加入序缇供应链，让产品资料、库存维护与合作交付有序衔接。</p>
          <ol>
            <li>
              <span>01</span>
              <div>
                <strong>邀请码注册</strong>
                <p>获取供应链负责人邀请码，创建专属账号。</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>提交企业资质</strong>
                <p>完善企业、联系人及结算资料，提交审核。</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>开启供应合作</strong>
                <p>审核通过后，上传产品并维护颜色尺码库存。</p>
              </div>
            </li>
          </ol>
        </div>
        <footer>序缇 · 与优质供应商共同成长</footer>
      </aside>
      <main className="supplier-registration-main">
        <header>
          <span>供应商入驻</span>
          <Link to="/supply/profile">已有账号？登录 ↗</Link>
        </header>
        <section className="supplier-registration-form">
          <span className="supplier-registration-step">第一步 · 创建账号</span>
          <h2>{done ? "欢迎加入序缇" : "开启新的合作"}</h2>
          <p className="supplier-registration-intro">
            请填写供应链负责人提供的邀请码，完成注册后即可提交入驻资料。
          </p>
          {done ? (
            <Alert
              type="success"
              title="账号已创建"
              description={
                <Link to="/supply/profile">前往登录并填写入驻材料</Link>
              }
            />
          ) : (
            <Form
              layout="vertical"
              onFinish={async (b) => {
                setBusy(true);
                try {
                  const { confirm, ...body } = b;
                  await api("/supply/register", "POST", body);
                  setDone(true);
                } catch (e) {
                  message.error((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Form.Item
                name="inviteCode"
                label="供应链负责人邀请码"
                rules={[{ required: true }]}
              >
                <Input
                  autoComplete="off"
                  placeholder="输入供应链负责人提供的邀请码"
                />
              </Form.Item>
              <Form.Item
                name="username"
                label="登录用户名"
                rules={[
                  { required: true },
                  {
                    pattern: /^[a-zA-Z0-9_-]{4,40}$/,
                    message: "4至40位字母、数字、下划线或短横线",
                  },
                ]}
              >
                <Input
                  autoComplete="username"
                  placeholder="4–40位字母、数字、下划线或短横线"
                />
              </Form.Item>
              <Form.Item
                name="displayName"
                label="联系人姓名"
                rules={[{ required: true }]}
              >
                <Input maxLength={80} placeholder="请输入联系人姓名" />
              </Form.Item>
              <Form.Item
                name="password"
                label="密码（至少12位）"
                rules={[{ required: true, min: 12 }]}
              >
                <Input.Password
                  autoComplete="new-password"
                  placeholder="设置至少12位密码"
                />
              </Form.Item>
              <Form.Item
                name="confirm"
                label="确认密码"
                dependencies={["password"]}
                rules={[
                  { required: true },
                  ({ getFieldValue }) => ({
                    validator: (_, v) =>
                      v === getFieldValue("password")
                        ? Promise.resolve()
                        : Promise.reject(Error("两次密码不一致")),
                  }),
                ]}
              >
                <Input.Password
                  autoComplete="new-password"
                  placeholder="再次输入密码"
                />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={busy} block>
                创建账号，开始入驻 →
              </Button>
              <p>
                <span className="supplier-registration-note">
                  没有邀请码？请先联系序缇供应链负责人。
                </span>
              </p>
            </Form>
          )}
        </section>
        <footer>企业资质审核通过后开放产品库</footer>
      </main>
    </div>
  );
}
function PhotoUpload({
  value,
  onChange,
  purpose,
  disabled = false,
  onUploaded,
}: {
  value?: string;
  onChange?: (v: string) => void;
  purpose: "QUALIFICATION" | "PRODUCT";
  disabled?: boolean;
  onUploaded?: (file: File, fileId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const { message } = App.useApp();
  const load = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const original = file;
      file = await prepareUpload(file);
      const data = await readUpload(file);
      const r = await send("/files", {
        name: file.name,
        type: file.type,
        data,
        purpose,
      });
      onChange?.(r.data.id);
      await onUploaded?.(original, r.data.id);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Space wrap>
      {value && (
        <Image
          width={72}
          height={60}
          style={{ objectFit: "cover" }}
          src={fileSrc(value)}
        />
      )}{" "}
      {!disabled && (
        <>
          <label className="supply-upload">
            {busy ? "上传中…" : "选择图片"}
            <input
              disabled={busy}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => {
                void load(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <label className="supply-upload">
            拍摄
            <input
              disabled={busy}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => {
                void load(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        </>
      )}
    </Space>
  );
}
const banks = [
  "中国工商银行",
  "中国农业银行",
  "中国银行",
  "中国建设银行",
  "交通银行",
  "中国邮政储蓄银行",
  "招商银行",
  "中信银行",
  "中国光大银行",
  "华夏银行",
  "中国民生银行",
  "广发银行",
  "平安银行",
  "兴业银行",
  "浦发银行",
  "浙商银行",
  "宁波银行",
  "杭州银行",
  "上海银行",
  "北京银行",
  "江苏银行",
];
const required = [{ required: true, message: "必填项不能为空" }];
const fieldRules = (field: string) => [
  {
    validator: (_: unknown, value: unknown) => {
      const error = qualificationFieldError(field, value);
      return error ? Promise.reject(Error(error)) : Promise.resolve();
    },
  },
];
const contactMethods = [
  { value: "email", label: "邮箱" },
  { value: "wechat", label: "微信" },
  { value: "ding", label: "钉钉" },
];
function ContactMethod({
  name,
  readonly,
}: {
  name: string;
  readonly: boolean;
}) {
  return (
    <Form.Item noStyle shouldUpdate>
      {(form) => {
        const contact = form.getFieldValue(name) || {};
        const method =
          contact.method ||
          contactMethods.find((m) => contact[m.value])?.value ||
          "email";
        if (readonly && !contact.method)
          return (
            <Space wrap>
              {contactMethods
                .filter((m) => contact[m.value])
                .map((m) => (
                  <span key={m.value}>
                    {m.label}：{contact[m.value]}
                  </span>
                ))}
            </Space>
          );
        return (
          <>
            <Form.Item label="联系方式（三选一）">
              <Select
                disabled={readonly}
                value={method}
                options={contactMethods}
                onChange={(e) => form.setFieldValue([name, "method"], e)}
              />
            </Form.Item>
            <Form.Item name={[name, "method"]} hidden initialValue={method}>
              <Input />
            </Form.Item>
            <Form.Item
              key={method}
              name={[name, method]}
              label={contactMethods.find((m) => m.value === method)?.label}
              rules={[
                ...required,
                ...(method === "email"
                  ? [{ type: "email" as const, message: "请输入有效邮箱" }]
                  : []),
              ]}
            >
              <Input
                maxLength={method === "email" ? 200 : 100}
                placeholder="请输入所选联系方式"
              />
            </Form.Item>
          </>
        );
      }}
    </Form.Item>
  );
}
export function QualificationFields({
  readonly = false,
  onOcrBusyChange,
}: {
  readonly?: boolean;
  onOcrBusyChange?: (busy: boolean) => void;
}) {
  const form = Form.useFormInstance();
  const ocr = useQualificationOcr(form, readonly);
  useEffect(() => {
    onOcrBusyChange?.(ocr.busy);
    return () => onOcrBusyChange?.(false);
  }, [ocr.busy, onOcrBusyChange]);
  const selectedBank = Form.useWatch("bankName", { form, preserve: true });
  const branch = Form.useWatch("bank", { form, preserve: true });
  const payee = Form.useWatch("payee", { form, preserve: true });
  const company = Form.useWatch("company", { form, preserve: true });
  const bankName =
    selectedBank || banks.find((b) => String(branch || "").includes(b)) || "";
  const [bankSearch, setBankSearch] = useState("");
  const matches = useQuery({
    queryKey: ["supply-banks", bankSearch, bankName],
    queryFn: async () =>
      (
        await api(
          "/supply/banks?q=" +
            encodeURIComponent(bankSearch) +
            "&bank=" +
            encodeURIComponent(bankName),
        )
      ).data,
    enabled: !readonly && !!bankName,
  });
  return (
    <>
      <div className="supply-grid">
        <Form.Item
          name="shortName"
          label="供应商简称"
          rules={fieldRules("shortName")}
          validateTrigger="onBlur"
        >
          <Input />
        </Form.Item>
      </div>
      {(["business", "finance"] as const).map((k) => (
        <section key={k}>
          <h3>{k === "business" ? "商务联系" : "对账联系"}</h3>
          <div className="supply-grid">
            <Form.Item
              name={[k, "name"]}
              label={k === "business" ? "商务联系人" : "财务联系人"}
              rules={fieldRules("name")}
              validateTrigger="onBlur"
            >
              <Input />
            </Form.Item>
            <Form.Item
              name={[k, "phone"]}
              label="手机号"
              rules={fieldRules("phone")}
              validateTrigger="onBlur"
            >
              <Input maxLength={11} />
            </Form.Item>
          </div>
          <ContactMethod name={k} readonly={readonly} />
        </section>
      ))}
      <h3>企业资质</h3>
      <div className="supply-grid">
        {[
          ["company", "入驻主体 / 公司名称"],
          ["creditCode", "统一社会信用代码"],
          ["legalName", "法定代表人"],
          ["legalId", "法人身份证号"],
          ["address", "办公地址"],
        ].map(([k, label]) => (
          <Form.Item
            key={k}
            name={k}
            label={label}
            extra={
              ocr.warning(k) ? (
                <span style={{ color: "#cf1322" }}>{ocr.warning(k)}</span>
              ) : undefined
            }
            rules={fieldRules(k)}
            validateTrigger="onBlur"
            normalize={(v) =>
              ["legalId", "creditCode"].includes(k) ? v.toUpperCase() : v
            }
          >
            <Input
              maxLength={["legalId", "creditCode"].includes(k) ? 18 : 200}
            />
          </Form.Item>
        ))}
      </div>
      <Alert
        type="info"
        title="请上传原件实拍照片；若使用复印件，需加盖红色公章。支持电脑上传、手机相册或拍摄，JPG / PNG / WebP，自动压缩至每张1 MB以下，上传后请核对证件文字清晰度。"
      />
      <div className="supply-grid">
        {[
          ["idFront", "法人身份证正面照"],
          ["idBack", "法人身份证反面照"],
          ["license", "营业执照副本"],
        ].map(([k, label]) => (
          <Form.Item key={k} name={k} label={label} rules={required}>
            <PhotoUpload
              purpose="QUALIFICATION"
              disabled={readonly || ocr.busy}
              onUploaded={k === "idBack" ? undefined : ocr.onUploaded}
            />
          </Form.Item>
        ))}
      </div>
      {ocr.panel}
      <h3>账单结算</h3>
      <div className="supply-grid">
        <Form.Item name="cycle" label="结算周期">
          <Input disabled />
        </Form.Item>
        <Form.Item name="payment" label="打款方式">
          <Input disabled />
        </Form.Item>
        <Form.Item
          name="payee"
          label="收款账户户名"
          rules={fieldRules("payee")}
          validateTrigger="onBlur"
          extra={
            payee &&
            company &&
            String(payee).replace(/\s/g, "") !==
              String(company).replace(/\s/g, "") ? (
              <span style={{ color: "#cf1322" }}>
                对公收款户名与入驻公司名称不同，请核对。此提示不代表银行账号归属核验结果。
              </span>
            ) : undefined
          }
        >
          <Input placeholder="请输入收款人户名" />
        </Form.Item>
        <Form.Item
          name="bankAccount"
          label="银行账号"
          rules={fieldRules("bankAccount")}
          validateTrigger="onBlur"
        >
          <Input placeholder="请输入收款人账号" />
        </Form.Item>
        <Form.Item label="开户银行">
          <AutoComplete
            value={bankName}
            options={banks.map((value) => ({ value }))}
            filterOption={(input, option) =>
              String(option?.value).includes(input)
            }
            onChange={(value) => {
              form.setFieldValue("bankName", value);
              if (bankName && value !== bankName)
                form.setFieldValue("bank", "");
              setBankSearch("");
            }}
            placeholder="选择或输入银行名称"
          />
        </Form.Item>
        <Form.Item name="bankName" hidden>
          <Input />
        </Form.Item>
        <Form.Item
          name="bank"
          label="开户支行"
          rules={fieldRules("bank")}
          validateTrigger="onBlur"
        >
          <AutoComplete
            options={(matches.data || []).map((r: Row) => ({ value: r.name }))}
            disabled={readonly || !bankName}
            onSearch={setBankSearch}
            filterOption={(input, option) =>
              String(option?.value).includes(input.trim())
            }
            placeholder="搜索地区或支行名，未找到可输入完整支行"
            notFoundContent={
              matches.isFetching
                ? "查询中…"
                : "系统暂无匹配支行，请输入完整开户支行"
            }
          />
        </Form.Item>
      </div>
      <Alert
        type="info"
        showIcon
        title="银行账户待核验"
        description="暂未接入银行账户核验服务，无法确认账号归属行及户名是否匹配。开户支行搜索范围为系统已有的生效支行资料，请按银行提供的信息填写，由负责人核对。"
      />
      <h3>开票方式</h3>
      <div className="supply-grid">
        <Form.Item name="invoiceTypes" label="支持开票类型" rules={required}>
          <Checkbox.Group options={["普票", "专票"]} />
        </Form.Item>
        <Form.Item name="taxRates" label="支持开票税点" rules={required}>
          <Checkbox.Group options={["1%", "3%", "6%", "13%"]} />
        </Form.Item>
      </div>
    </>
  );
}
const emptyQualification = {
  business: { name: "", phone: "", email: "", wechat: "", ding: "" },
  finance: { name: "", phone: "", email: "", wechat: "", ding: "" },
  cycle: "月结",
  payment: "对公转账",
  invoiceTypes: [],
  taxRates: [],
};
export function SupplyProfile() {
  const [ocrBusy, setOcrBusy] = useState(false);
  const [editVersion, setEditVersion] = useState(0);
  const q = useQuery({
    queryKey: ["supply-profile"],
    queryFn: async () => (await api("/supply/profile")).data,
    refetchInterval: 30000,
  });
  const [form] = Form.useForm();
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false);
  const { message } = App.useApp();
  const p = q.data;
  const save = async (submit: boolean) => {
    setBusy(true);
    try {
      const doc = submit
        ? await form.validateFields()
        : form.getFieldsValue(true);
      for (const key of ["business", "finance"]) {
        doc[key] = {
          name: "",
          phone: "",
          email: "",
          wechat: "",
          ding: "",
          ...doc[key],
        };
        const method =
          doc[key].method ||
          contactMethods.find((m) => doc[key][m.value])?.value ||
          "email";
        doc[key].method = method;
        for (const m of contactMethods)
          if (m.value !== method) doc[key][m.value] = "";
        if (submit && !doc[key][method]?.trim())
          throw Error("商务和财务联系均需选择并填写一种联系方式");
      }
      await send("/profile", { version: editVersion, submit, document: doc });
      message.success(submit ? "已提交，等待供应链负责人审核" : "草稿已保存");
      setEditing(false);
      await refresh();
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Header
        title="企业资质管理"
        subtitle="入驻及资料更新均需审核；更新通过前，原生效资料保持不变。"
      />
      {q.error && <Alert type="error" title={q.error.message} />}{" "}
      {p && (
        <>
          <Card>
            <Space wrap>
              <Tag
                color={
                  p.state === "REJECTED"
                    ? "red"
                    : p.state === "APPROVED"
                      ? "green"
                      : "orange"
                }
              >
                {states[p.state]}
              </Tag>
              <span>{p.effective ? "已入驻" : "尚未入驻"}</span>
              <span>提交：{when(p.submittedAt)}</span>
              {p.state !== "PENDING" && (
                <Button
                  type="primary"
                  onClick={() => {
                    form.setFieldsValue({ ...emptyQualification, ...p.draft });
                    setEditVersion(p.version);
                    setEditing(true);
                  }}
                >
                  {p.effective ? "修改更新资质" : "填写 / 修改入驻资料"}
                </Button>
              )}
              {p.effective && <Link to="/supply/products">前往产品库</Link>}
            </Space>
            {p.reason && (
              <Alert type="error" title="驳回原因" description={p.reason} />
            )}
          </Card>
          <Tabs
            items={[
              {
                key: "effective",
                label: "当前生效资料",
                children: p.effective ? (
                  <Form
                    layout="vertical"
                    disabled
                    initialValues={p.effective}
                    key={p.version}
                  >
                    <QualificationFields readonly />
                  </Form>
                ) : (
                  <p>审核通过后显示生效资料。</p>
                ),
              },
              {
                key: "submitted",
                label: "最近申请资料",
                children: (
                  <Form
                    layout="vertical"
                    disabled
                    initialValues={p.draft}
                    key={p.version}
                  >
                    <QualificationFields readonly />
                  </Form>
                ),
              },
              {
                key: "history",
                label: "审核记录",
                children: (
                  <Table<Row>
                    rowKey="id"
                    dataSource={p.history}
                    columns={[
                      {
                        title: "状态",
                        dataIndex: "decision",
                        render: (v) => states[v] || "已提交",
                      },
                      { title: "反馈原因", dataIndex: "reason" },
                      { title: "时间", dataIndex: "createdAt", render: when },
                    ]}
                  />
                ),
              },
            ]}
          />
        </>
      )}
      <Drawer
        title="填写企业资质"
        destroyOnHidden
        size="98vw"
        open={editing}
        onClose={() => !busy && setEditing(false)}
        extra={
          <Space>
            <Button
              loading={busy}
              disabled={ocrBusy}
              onClick={() => save(false)}
            >
              保存草稿
            </Button>
            <Button
              type="primary"
              loading={busy}
              disabled={ocrBusy}
              onClick={() => save(true)}
            >
              提交审核
            </Button>
          </Space>
        }
      >
        <Form layout="vertical" form={form}>
          <QualificationFields onOcrBusyChange={setOcrBusy} />
        </Form>
      </Drawer>
    </>
  );
}
export function SupplyReview() {
  const [state, setState] = useState("PENDING"),
    [selected, setSelected] = useState<Row | null>(null),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false);
  const { message, modal } = App.useApp();
  const q = useQuery({
    queryKey: ["supply-applications", state],
    queryFn: async () =>
      (await api("/supply/applications?state=" + state)).data,
    refetchInterval: 30000,
  });
  const invites = useQuery({
    queryKey: ["supply-invites"],
    queryFn: async () => (await api("/supply/invites")).data,
  });
  const action = async (approve: boolean) => {
    setBusy(true);
    try {
      await send(`/applications/${selected!.id}/review`, {
        version: selected!.version,
        approve,
        reason,
      });
      setSelected(null);
      await refresh();
      message.success(
        approve ? "审核通过，资料已生效" : "已驳回，供应商可修改后重提",
      );
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Header
        title="供应商入驻与资质审核"
        subtitle="核对企业、证件及结算材料，审核通过后生效。"
      />
      <Tabs
        items={[
          {
            key: "review",
            label: "申请审核",
            children: (
              <>
                <Select
                  style={{ width: 160 }}
                  value={state}
                  onChange={setState}
                  options={[
                    { value: "", label: "全部" },
                    ...Object.entries(states).map(([value, label]) => ({
                      value,
                      label,
                    })),
                  ]}
                />
                {q.error && <Alert type="error" title={q.error.message} />}
                <Table<Row>
                  rowKey="id"
                  dataSource={q.data || []}
                  columns={[
                    { title: "供应商简称", dataIndex: "shortName" },
                    { title: "企业名称", dataIndex: "company" },
                    {
                      title: "申请类型",
                      dataIndex: "admitted",
                      render: (v) => (v ? "资质更新" : "首次入驻"),
                    },
                    {
                      title: "状态",
                      dataIndex: "state",
                      render: (v) => states[v],
                    },
                    {
                      title: "提交时间",
                      dataIndex: "submittedAt",
                      render: when,
                    },
                    {
                      title: "操作",
                      render: (_, r) => (
                        <Button
                          onClick={async () => {
                            try {
                              setSelected(
                                (await api("/supply/applications/" + r.id))
                                  .data,
                              );
                              setReason("");
                            } catch (e) {
                              message.error((e as Error).message);
                            }
                          }}
                        >
                          查看材料
                        </Button>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: "invite",
            label: "我的邀请码",
            children: (
              <>
                <p>
                  邀请码有效期30天，最多注册100个账号，可随时停用。将邀请码和注册链接交给供应商。
                </p>
                <Button
                  type="primary"
                  onClick={async () => {
                    try {
                      await send("/invites", { days: 30, maxUses: 100 });
                      await refresh();
                    } catch (e) {
                      message.error((e as Error).message);
                    }
                  }}
                >
                  生成邀请码
                </Button>
                <p>注册链接：{location.origin}/supply/register</p>
                <Table<Row>
                  rowKey="id"
                  dataSource={invites.data || []}
                  columns={[
                    {
                      title: "邀请码",
                      dataIndex: "code",
                      render: (v) => (
                        <Typography.Text copyable>{v}</Typography.Text>
                      ),
                    },
                    {
                      title: "已用 / 名额",
                      render: (_, r) => `${r.uses} / ${r.maxUses}`,
                    },
                    { title: "到期时间", dataIndex: "expiresAt", render: when },
                    {
                      title: "状态",
                      dataIndex: "active",
                      render: (v) => (v ? "启用" : "停用"),
                    },
                    {
                      title: "操作",
                      render: (_, r) => (
                        <Button
                          disabled={!r.active}
                          onClick={async () => {
                            try {
                              await send(`/invites/${r.id}/disable`, {});
                              await refresh();
                            } catch (e) {
                              message.error((e as Error).message);
                            }
                          }}
                        >
                          停用
                        </Button>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
        ]}
      />
      <Drawer
        size="98vw"
        open={!!selected}
        title="入驻 / 资质变更材料审核"
        onClose={() => !busy && setSelected(null)}
      >
        {selected && (
          <>
            <Tabs
              items={[
                {
                  key: "new",
                  label: "申请材料",
                  children: (
                    <Form
                      key={selected.id + "draft"}
                      disabled
                      layout="vertical"
                      initialValues={selected.draft}
                    >
                      <QualificationFields readonly />
                    </Form>
                  ),
                },
                {
                  key: "old",
                  label: "当前生效材料（对比）",
                  children: selected.effective ? (
                    <Form
                      key={selected.id + "effective"}
                      disabled
                      layout="vertical"
                      initialValues={selected.effective}
                    >
                      <QualificationFields readonly />
                    </Form>
                  ) : (
                    <p>首次入驻，暂无生效材料。</p>
                  ),
                },
              ]}
            />
            {selected.state === "PENDING" && (
              <>
                <Input.TextArea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="驳回原因必填，请说明需要补正的材料"
                  maxLength={2000}
                />
                <Space style={{ marginTop: 12 }}>
                  <Button danger loading={busy} onClick={() => action(false)}>
                    驳回并反馈原因
                  </Button>
                  <Button
                    type="primary"
                    loading={busy}
                    onClick={() =>
                      modal.confirm({
                        title: "确认材料合格并审核通过？",
                        content: "通过后本次企业资质立即生效。",
                        onOk: () => action(true),
                      })
                    }
                  >
                    审核通过
                  </Button>
                </Space>
              </>
            )}
          </>
        )}
      </Drawer>
    </>
  );
}
const blankProduct = () => ({
  supplierStyle: "",
  name: "",
  material: "",
  sellingPoints: "",
  taxPrice: undefined,
  netPrice: undefined,
  reorderCycle: undefined,
  colors: [],
  sizes: [],
  images: [],
  stock: [],
  stockConfirmed: false,
});
function stockRows(colors: string[], sizes: string[], old: Row[] = []) {
  return colors.flatMap((color) =>
    sizes.map((size) => ({
      color,
      size,
      quantity:
        old.find((s) => s.color === color && s.size === size)?.quantity || 0,
    })),
  );
}
function InventoryEditor({
  value,
  onChange,
  onClose,
}: {
  value: Row;
  onChange: (v: Row) => void | Promise<void>;
  onClose: () => void;
}) {
  const [stock, setStock] = useState<Row[]>(
      stockRows(value.colors, value.sizes, value.stock),
    ),
    [images, setImages] = useState<Row[]>(value.images || []);
  const { message } = App.useApp();
  return (
    <Modal
      title="维护库存明细"
      open
      width="98vw"
      onCancel={onClose}
      onOk={async () => {
        if (
          value.colors.some((c: string) => !images.some((i) => i.color === c))
        ) {
          message.error("每种颜色必须上传颜色图");
          return;
        }
        await onChange({ ...value, stock, images, stockConfirmed: true });
        onClose();
      }}
      okText="完成库存维护"
    >
      <p>
        每一颜色上传实拍图，尺码库存填写非负整数。总库存：
        {stock.reduce((n, s) => n + s.quantity, 0)}
      </p>
      <Table<Row>
        pagination={false}
        rowKey="color"
        scroll={{ x: "max-content" }}
        dataSource={value.colors.map((color: string) => ({ color }))}
        columns={[
          { title: "颜色", dataIndex: "color", fixed: "left" },
          {
            title: "颜色图（必填）",
            render: (_, r) => (
              <PhotoUpload
                purpose="PRODUCT"
                value={images.find((i) => i.color === r.color)?.fileId}
                onChange={(fileId) =>
                  setImages([
                    ...images.filter((i) => i.color !== r.color),
                    { color: r.color, fileId },
                  ])
                }
              />
            ),
          },
          ...value.sizes.map((size: string) => ({
            title: size,
            render: (_: any, r: Row) => (
              <InputNumber
                min={0}
                max={100000000}
                precision={0}
                value={
                  stock.find((s) => s.color === r.color && s.size === size)
                    ?.quantity || 0
                }
                onChange={(v) =>
                  setStock(
                    stock.map((s) =>
                      s.color === r.color && s.size === size
                        ? { ...s, quantity: Number(v) || 0 }
                        : s,
                    ),
                  )
                }
              />
            ),
          })),
          {
            title: "颜色库存",
            render: (_, r) =>
              stock
                .filter((s) => s.color === r.color)
                .reduce((n, s) => n + s.quantity, 0),
          },
        ]}
      />
    </Modal>
  );
}
function ProductEditor({
  initial,
  onClose,
}: {
  initial?: Row;
  onClose: () => void;
}) {
  const [form] = Form.useForm();
  const [doc, setDoc] = useState<Row>(initial?.document || blankProduct()),
    [inventory, setInventory] = useState(false),
    [busy, setBusy] = useState(false);
  const { message } = App.useApp();
  const update = (v: Row) => {
    const next = { ...doc, ...v };
    if (v.colors || v.sizes) {
      next.stock = stockRows(next.colors, next.sizes, doc.stock);
      next.images = doc.images.filter((i: Row) =>
        next.colors.includes(i.color),
      );
      next.stockConfirmed = false;
    }
    setDoc(next);
  };
  return (
    <Drawer
      open
      title={initial ? "编辑供应商产品" : "新增供应商产品"}
      size="98vw"
      onClose={() => !busy && onClose()}
      extra={
        <Button
          type="primary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await form.validateFields();
              await send(
                "/products" + (initial ? "/" + initial.id : ""),
                { version: initial?.version, document: doc },
                initial ? "PATCH" : "POST",
              );
              await refresh();
              message.success("产品已保存");
              onClose();
            } catch (e) {
              if (e instanceof Error) message.error(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          保存产品
        </Button>
      }
    >
      <Form
        form={form}
        initialValues={doc}
        layout="vertical"
        onValuesChange={update}
      >
        <div className="supply-grid">
          {[
            ["supplierStyle", "供应商款号"],
            ["name", "产品名称（30个汉字 / 60个字符）"],
            ["material", "详细材质"],
          ].map(([k, label]) => (
            <Form.Item name={k} label={label} key={k} rules={required}>
              <Input />
            </Form.Item>
          ))}
          <Form.Item name="taxPrice" label="含税供货价" rules={required}>
            <InputNumber min={0} precision={2} />
          </Form.Item>
          <Form.Item name="netPrice" label="不含税供货价" rules={required}>
            <InputNumber min={0} precision={2} />
          </Form.Item>
        </div>
        <Form.Item name="sellingPoints" label="产品卖点（非必填，最多1000字）">
          <Input.TextArea maxLength={1000} showCount rows={4} />
        </Form.Item>
        <Form.Item
          name="reorderCycle"
          label="翻单周期（天）"
          rules={[
            ...required,
            {
              validator: (_, value) =>
                value == null || (Number.isSafeInteger(value) && value >= 0)
                  ? Promise.resolve()
                  : Promise.reject(Error("请填写非负整数")),
            },
          ]}
        >
          <InputNumber step={1} placeholder="请输入非负整数" />
        </Form.Item>
        <Form.Item
          name="colors"
          label="颜色（输入后回车添加）"
          rules={required}
        >
          <Select mode="tags" tokenSeparators={[";", "；"]} open={false} />
        </Form.Item>
        <Form.Item
          name="sizes"
          label="尺码（可选择或输入其他尺码后回车）"
          rules={required}
        >
          <Select
            mode="tags"
            tokenSeparators={[";", "；"]}
            options={sizes.map((value) => ({ value }))}
          />
        </Form.Item>
        <p>
          总库存：{doc.stock.reduce((n: number, s: Row) => n + s.quantity, 0)}　
          {doc.stockConfirmed ? "已维护" : "待维护库存与颜色图"}
        </p>
        <Button
          disabled={!doc.colors.length || !doc.sizes.length}
          onClick={() => setInventory(true)}
        >
          维护库存
        </Button>
        <Alert
          style={{ marginTop: 12 }}
          type="info"
          title="保存后为下架产品；补齐颜色图并维护库存后可上架。序缇款号由内部人员维护。"
        />
      </Form>
      {inventory && (
        <InventoryEditor
          value={doc}
          onChange={setDoc}
          onClose={() => setInventory(false)}
        />
      )}
    </Drawer>
  );
}
async function downloadSheet(name: string, records: Row[]) {
  const Excel = (await import("exceljs")).default;
  const book = new Excel.Workbook();
  const sheet = book.addWorksheet("数据");
  const keys = Object.keys(records[0] || {});
  sheet.columns = keys.map((key) => ({ header: key, key, width: 22 }));
  for (const r of records) sheet.addRow(r);
  const buffer = await book.xlsx.writeBuffer();
  const url = URL.createObjectURL(
    new Blob([buffer as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name + ".xlsx";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function SupplyProducts({ internal = false }: { internal?: boolean }) {
  const [stockEditing, setStockEditing] = useState<Row | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);
  const { message, modal } = App.useApp();
  const [accountId, setAccount] = useState(""),
    [styles, setStyles] = useState(""),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<React.Key[]>([]),
    [editing, setEditing] = useState<Row | null | undefined>(undefined),
    [batch, setBatch] = useState(false),
    [exporting, setExporting] = useState(false),
    [exportType, setExportType] = useState("产品资料"),
    [scope, setScope] = useState("筛选结果");
  const suppliers = useQuery({
    queryKey: ["supply-suppliers"],
    queryFn: async () => (await api("/supply/suppliers")).data,
    enabled: internal,
  });
  const admission = useQuery({
    queryKey: ["supply-profile"],
    queryFn: async () => (await api("/supply/profile")).data,
    enabled: !internal,
  });
  const params = { ...(internal ? { accountId } : {}), styles: search, status };
  const list = useQuery({
    queryKey: ["supply-products", params, page],
    queryFn: () =>
      api(
        "/supply/products?" +
          new URLSearchParams({ ...params, page: String(page) }),
      ),
    enabled: internal ? !!accountId : !!admission.data?.effective,
  });
  const exportData = async () => {
    setExporting(true);
    try {
      if (scope === "已勾选" && !selected.length) throw Error("请先勾选产品");
      const out: Row[] = [];
      let p = 1,
        total = 1;
      while (out.length < total) {
        const res = await api(
          "/supply/products?" +
            new URLSearchParams({
              ...params,
              ...(scope === "全部产品" ? { styles: "", status: "" } : {}),
              pageSize: "500",
              page: String(p++),
            }),
        );
        total = res.total;
        out.push(...res.data);
        if (!res.data.length) break;
      }
      const chosen =
        scope === "已勾选" ? out.filter((x) => selected.includes(x.id)) : out;
      const records: Row[] = [];
      for (const item of chosen) {
        const d = item.document,
          base = {
            序缇款号: item.xutiStyle,
            供应商款号: item.supplierStyle,
            产品名称: d.name,
          };
        if (exportType === "产品资料")
          records.push({
            ...base,
            详细材质: d.material,
            产品卖点: d.sellingPoints || "",
            含税供货价: d.taxPrice,
            不含税供货价: d.netPrice,
            "翻单周期（天）": d.reorderCycle ?? "",
            颜色: d.colors.join("；"),
            尺码: d.sizes.join("；"),
            总库存: d.stock.reduce((n: number, s: Row) => n + s.quantity, 0),
            状态: item.status === "ON" ? "上架" : "下架",
            下架原因: item.offReasons.join("；"),
            颜色图片: d.images
              .map(
                (i: Row) => i.color + ":" + location.origin + fileSrc(i.fileId),
              )
              .join("；"),
          });
        else if (exportType === "按款")
          records.push({
            ...base,
            总库存: d.stock.reduce((n: number, s: Row) => n + s.quantity, 0),
          });
        else if (exportType === "按颜色")
          for (const color of d.colors)
            records.push({
              ...base,
              颜色: color,
              库存: d.stock
                .filter((s: Row) => s.color === color)
                .reduce((n: number, s: Row) => n + s.quantity, 0),
            });
        else if (exportType === "按尺码")
          for (const size of d.sizes)
            records.push({
              ...base,
              尺码: size,
              库存: d.stock
                .filter((s: Row) => s.size === size)
                .reduce((n: number, s: Row) => n + s.quantity, 0),
            });
        else
          for (const s of d.stock)
            records.push({
              ...base,
              颜色: s.color,
              尺码: s.size,
              库存: s.quantity,
            });
      }
      if (!records.length) throw Error("没有可导出的产品");
      await downloadSheet(exportType, records);
      message.success("导出完成");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  };
  const shelf = (r: Row) => {
    if (r.status === "OFF") {
      if (
        !Number.isSafeInteger(r.document.reorderCycle) ||
        r.document.reorderCycle < 0
      ) {
        message.warning("请先编辑产品，补充翻单周期后再上架");
        setEditing(r);
        return;
      }
      void send(`/products/${r.id}/actions`, {
        version: r.version,
        status: "ON",
      })
        .then(refresh)
        .catch((e) => message.error(e.message));
      return;
    }
    let reasons: string[] = [],
      other = "";
    modal.confirm({
      title: "下架产品",
      content: (
        <>
          <Checkbox.Group
            options={offReasons}
            onChange={(v) => (reasons = v as string[])}
          />
          <Input.TextArea
            placeholder="选择其他原因时必填"
            onChange={(e) => (other = e.target.value)}
          />
        </>
      ),
      onOk: async () => {
        try {
          await send(`/products/${r.id}/actions`, {
            version: r.version,
            status: "OFF",
            reasons: reasons.map((s) =>
              s === "其他原因" ? "其他原因：" + other.trim() : s,
            ),
          });
          await refresh();
        } catch (e) {
          message.error((e as Error).message);
          throw e;
        }
      },
    });
  };
  return (
    <>
      <Header
        title={internal ? "供应链产品库" : "供应商产品库"}
        subtitle="按颜色、尺码维护库存；上架表示此款可上线售卖。"
        extra={
          !internal && admission.data?.effective ? (
            <Space>
              <Button onClick={() => setBatch(true)}>表格批量上传</Button>
              <Button type="primary" onClick={() => setEditing(null)}>
                新增产品
              </Button>
            </Space>
          ) : undefined
        }
      />
      {!internal && admission.data && !admission.data.effective && (
        <Alert
          type="info"
          title={
            <span>
              入驻审核通过后可使用产品库。
              <Link to="/supply/profile">填写或查看入驻资料</Link>
            </span>
          }
        />
      )}
      <Space wrap style={{ marginBottom: 12 }}>
        {internal && (
          <Select
            placeholder="选择供应商"
            style={{ width: 200 }}
            value={accountId || undefined}
            options={(suppliers.data || []).map((s: Row) => ({
              value: s.id,
              label: s.name,
            }))}
            onChange={(v) => {
              setAccount(v);
              setPage(1);
              setSelected([]);
            }}
          />
        )}
        <Input.Search
          style={{ width: 340 }}
          value={styles}
          placeholder="单个款号，多个款号用 ; 或 ；分隔"
          onChange={(e) => setStyles(e.target.value)}
          onSearch={(v) => {
            setSearch(v);
            setPage(1);
            setSelected([]);
          }}
        />
        <Select
          value={status}
          options={[
            { value: "", label: "全部产品" },
            { value: "ON", label: "上架" },
            { value: "OFF", label: "下架" },
          ]}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
            setSelected([]);
          }}
        />
      </Space>
      <Card>
        <Space wrap>
          <Select
            value={scope}
            onChange={setScope}
            options={["筛选结果", "已勾选", "全部产品"].map((value) => ({
              value,
            }))}
          />
          <Select
            value={exportType}
            onChange={setExportType}
            options={[
              "产品资料",
              "按款",
              "按颜色",
              "按尺码",
              "颜色尺码明细",
            ].map((value) => ({ value }))}
          />
          <Button
            loading={exporting}
            disabled={internal ? !accountId : !admission.data?.effective}
            onClick={exportData}
          >
            导出 Excel
          </Button>
          <span>已选 {selected.length} 款</span>
        </Space>
        {list.error && <Alert type="error" title={list.error.message} />}
        <Table<Row>
          rowKey="id"
          loading={list.isLoading}
          scroll={{ x: 1700 }}
          dataSource={list.data?.data || []}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: setSelected,
            preserveSelectedRowKeys: true,
          }}
          pagination={{
            current: page,
            total: list.data?.total,
            pageSize: 20,
            onChange: setPage,
            showSizeChanger: false,
          }}
          columns={[
            {
              title: "编号",
              render: (_, r, i) =>
                String((page - 1) * 20 + i + 1).padStart(2, "0"),
            },
            {
              title: "序缇款号",
              dataIndex: "xutiStyle",
              render: (v, r) => (
                <>
                  {v || "待补充"}
                  {internal && (
                    <Button
                      type="link"
                      onClick={() => {
                        let code = v;
                        modal.confirm({
                          title: "维护序缇款号",
                          content: (
                            <Input
                              defaultValue={v}
                              onChange={(e) => (code = e.target.value)}
                            />
                          ),
                          onOk: async () => {
                            try {
                              await send(`/products/${r.id}/actions`, {
                                version: r.version,
                                xutiStyle: code,
                              });
                              await refresh();
                            } catch (e) {
                              message.error((e as Error).message);
                              throw e;
                            }
                          },
                        });
                      }}
                    >
                      编辑
                    </Button>
                  )}
                </>
              ),
            },
            { title: "供应商款号", dataIndex: "supplierStyle" },
            {
              title: "产品图",
              render: (_, r) => (
                <Image.PreviewGroup
                  items={r.document.images.map((i: Row) => ({
                    src: fileSrc(i.fileId),
                  }))}
                >
                  {r.document.images.length ? (
                    <Badge count={r.document.images.length}>
                      <Image
                        width={60}
                        height={60}
                        style={{ objectFit: "cover" }}
                        src={fileSrc(r.document.images[0].fileId)}
                      />
                    </Badge>
                  ) : (
                    "待补图"
                  )}
                </Image.PreviewGroup>
              ),
            },
            { title: "产品名称", render: (_, r) => r.document.name },
            { title: "详细材质", render: (_, r) => r.document.material },
            {
              title: "产品详情",
              render: (_, r, i) => (
                <Button
                  type="link"
                  onClick={() =>
                    setDetail({
                      ...r,
                      serial: String((page - 1) * 20 + i + 1).padStart(2, "0"),
                    })
                  }
                >
                  产品详情
                </Button>
              ),
            },
            { title: "含税供货价", render: (_, r) => r.document.taxPrice },
            { title: "不含税供货价", render: (_, r) => r.document.netPrice },
            {
              title: "翻单周期（天，必填）",
              render: (_, r) =>
                r.document.reorderCycle ?? <Tag color="orange">待补充</Tag>,
            },
            { title: "颜色", render: (_, r) => r.document.colors.join("、") },
            { title: "尺码", render: (_, r) => r.document.sizes.join("、") },
            {
              title: "库存维护",
              render: (_, r) => (
                <>
                  {r.document.stock.reduce(
                    (n: number, s: Row) => n + s.quantity,
                    0,
                  )}
                  <br />
                  {!internal && (
                    <Button
                      type="link"
                      onClick={() => {
                        if (r.document.reorderCycle == null) {
                          message.info(
                            "请先补充翻单周期，可在编辑产品中继续维护库存",
                          );
                          setEditing(r);
                        } else setStockEditing(r);
                      }}
                    >
                      维护库存
                    </Button>
                  )}
                </>
              ),
            },
            {
              title: "状态 / 原因",
              render: (_, r) => (
                <>
                  {r.status === "ON" ? "上架" : "下架"}
                  <br />
                  {r.offReasons.join("、")}
                </>
              ),
            },
            {
              title: "操作",
              fixed: "right",
              render: (_, r) =>
                !internal && (
                  <Space>
                    <Button type="link" onClick={() => setEditing(r)}>
                      编辑
                    </Button>
                    <Button type="link" onClick={() => shelf(r)}>
                      {r.status === "ON" ? "下架" : "上架"}
                    </Button>
                  </Space>
                ),
            },
          ]}
        />
      </Card>
      <Drawer
        title="产品详情"
        open={!!detail}
        onClose={() => setDetail(null)}
        size="98vw"
      >
        {detail && (
          <>
            <Descriptions
              bordered
              column={{ xs: 1, sm: 2 }}
              items={[
                { key: "serial", label: "自动编号", children: detail.serial },
                {
                  key: "style",
                  label: "序缇款号",
                  children: detail.xutiStyle || "待补充",
                },
                {
                  key: "name",
                  label: "产品名称",
                  children: detail.document.name,
                },
                {
                  key: "material",
                  label: "详细材质",
                  children: detail.document.material,
                },
                {
                  key: "tax",
                  label: "含税供货价",
                  children: detail.document.taxPrice,
                },
                {
                  key: "net",
                  label: "不含税供货价",
                  children: detail.document.netPrice,
                },
                {
                  key: "reorderCycle",
                  label: "翻单周期（天）",
                  children: detail.document.reorderCycle ?? "待补充",
                },
                {
                  key: "colors",
                  label: "颜色",
                  children: detail.document.colors.join("、"),
                },
                {
                  key: "sizes",
                  label: "尺码",
                  children: detail.document.sizes.join("、"),
                },
                {
                  key: "status",
                  label: "上架 / 下架状态",
                  children:
                    detail.status === "ON"
                      ? "上架"
                      : `下架${detail.offReasons.length ? "：" + detail.offReasons.join("、") : ""}`,
                },
              ]}
            />
            <Typography.Title level={5}>产品图</Typography.Title>
            <Image.PreviewGroup>
              <Space wrap>
                {detail.document.images.length
                  ? detail.document.images.map((item: Row) => (
                      <div key={item.color}>
                        <Image
                          width={100}
                          height={100}
                          style={{ objectFit: "cover" }}
                          alt={item.color}
                          src={fileSrc(item.fileId)}
                        />
                        <div>{item.color}</div>
                      </div>
                    ))
                  : "待补图"}
              </Space>
            </Image.PreviewGroup>
            <Typography.Title level={5}>库存明细表</Typography.Title>
            <Table<Row>
              size="small"
              pagination={false}
              scroll={{ x: "max-content" }}
              rowKey="color"
              dataSource={detail.document.colors.map((color: string) => ({
                color,
              }))}
              columns={[
                { title: "颜色", dataIndex: "color" },
                ...detail.document.sizes.map((size: string) => ({
                  title: size,
                  key: size,
                  render: (_: unknown, row: Row) =>
                    detail.document.stock.find(
                      (s: Row) => s.color === row.color && s.size === size,
                    )?.quantity ?? 0,
                })),
                {
                  title: "颜色库存",
                  render: (_, row) =>
                    detail.document.stock
                      .filter((s: Row) => s.color === row.color)
                      .reduce((n: number, s: Row) => n + s.quantity, 0),
                },
              ]}
            />
            <Typography.Paragraph>
              总库存：
              {detail.document.stock.reduce(
                (n: number, s: Row) => n + s.quantity,
                0,
              )}
            </Typography.Paragraph>
            <Typography.Title level={5}>产品卖点</Typography.Title>
            <Typography.Paragraph
              style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
            >
              {detail.document.sellingPoints || "未填写"}
            </Typography.Paragraph>
          </>
        )}
      </Drawer>
      {stockEditing && (
        <InventoryEditor
          value={stockEditing.document}
          onClose={() => setStockEditing(null)}
          onChange={async (document) => {
            try {
              await send(
                "/products/" + stockEditing.id,
                { version: stockEditing.version, document },
                "PATCH",
              );
              await refresh();
              message.success("库存已保存");
            } catch (e) {
              message.error((e as Error).message);
              throw e;
            }
          }}
        />
      )}
      {editing !== undefined && (
        <ProductEditor
          initial={editing || undefined}
          onClose={() => setEditing(undefined)}
        />
      )}{" "}
      {batch && (
        <BatchEditor
          title="批量上传供应商产品"
          fields={[
            { key: "supplierStyle", label: "供应商款号", required: true },
            { key: "name", label: "产品名称", required: true },
            { key: "material", label: "详细材质", required: true },
            { key: "sellingPoints", label: "产品卖点（非必填，最多1000字）" },
            {
              key: "taxPrice",
              label: "含税供货价",
              required: true,
              type: "number",
            },
            {
              key: "netPrice",
              label: "不含税供货价",
              required: true,
              type: "number",
            },
            {
              key: "reorderCycle",
              label: "翻单周期（天）",
              required: true,
              type: "number",
              min: 0,
            },
            { key: "colors", label: "颜色（分号分隔）", required: true },
            { key: "sizes", label: "尺码（分号分隔）", required: true },
          ]}
          saveRow={async (body, key) => {
            const colors = splitValues(String(body.colors)),
              sizeList = splitValues(String(body.sizes));
            return api(
              "/supply/products",
              "POST",
              {
                document: {
                  ...body,
                  colors,
                  sizes: sizeList,
                  stock: stockRows(colors, sizeList),
                  images: [],
                  stockConfirmed: false,
                },
              },
              key,
            );
          }}
          onClose={() => {
            setBatch(false);
            void refresh();
          }}
        />
      )}
    </>
  );
}
