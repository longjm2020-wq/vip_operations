import { useState } from "react";
import {
  Alert,
  App,
  Button,
  DatePicker,
  Drawer,
  Form,
  InputNumber,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
} from "antd";
import { CalculatorOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import {
  inventoryReferencePeriods,
  type InventoryReferencePeriod,
} from "../../../packages/contracts/src/inventory-summary";
import { inventoryReferenceMethodLabels } from "../../../packages/contracts/src/compass-inventory-reference";
import { api, queryClient } from "./api";
import type { Row } from "./shared";
import {
  replenishmentPolicySchema,
  replenishmentServiceLevels,
  replenishmentStatusLabels,
  type ReplenishmentPolicy,
  type ReplenishmentStatus,
} from "../../../packages/contracts/src/inventory-replenishment";

const number = (value: number) =>
  value.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
const grid = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 20px" } as const;

export function InventoryCalculationPanel({
  referencePeriod,
  onSaved,
}: {
  referencePeriod: InventoryReferencePeriod;
  onSaved: (period: InventoryReferencePeriod) => void;
}) {
  const [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
    [revision, setRevision] = useState(0);
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const load = async () => {
    setLoading(true);
    try {
      const result = (await api("/inventory/replenishment-policy")).data;
      const policy = replenishmentPolicySchema.parse(result.policy);
      setRevision(result.revision);
      form.setFieldsValue({
        ...policy,
        referencePeriod,
        resalableRate: policy.resalableRate * 100,
        recentWeight: policy.recentWeight * 100,
        stopDate: policy.stopDate ? dayjs(policy.stopDate) : null,
        confirmedReturnRate:
          policy.confirmedReturnRate == null
            ? null
            : policy.confirmedReturnRate * 100,
      });
      setOpen(true);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const save = async () => {
    try {
      const values = await form.validateFields();
      const parsed = replenishmentPolicySchema.safeParse({
        ...values,
        resalableRate: values.resalableRate / 100,
        recentWeight: values.recentWeight / 100,
        stopDate: values.stopDate ? dayjs(values.stopDate).format("YYYY-MM-DD") : null,
        confirmedReturnRate:
          values.confirmedReturnRate == null
            ? null
            : values.confirmedReturnRate / 100,
      });
      if (!parsed.success) {
        message.error(parsed.error.issues[0].message);
        return;
      }
      setSaving(true);
      await api("/inventory/replenishment-policy", "POST", {
        revision,
        policy: parsed.data,
      });
      onSaved(parsed.data.referencePeriod);
      await queryClient.invalidateQueries({ queryKey: ["/inventory/summary"] });
      setOpen(false);
      message.success("补货配置已按账号保存");
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSaving(false);
    }
  };
  const days = (name: string, label: string, min: number, max: number, extra?: string) => (
    <Form.Item name={name} label={label} rules={[{ required: true }]} extra={extra}>
      <InputNumber min={min} max={max} precision={0} style={{ width: "100%" }} />
    </Form.Item>
  );
  return (
    <>
      <Tooltip title={open ? null : "补货配置"}>
        <Button
          aria-label="补货配置"
          icon={<CalculatorOutlined />}
          onClick={load}
          loading={loading}
        >
          补货配置
        </Button>
      </Tooltip>
      <Drawer
        title="补货配置"
        forceRender
        open={open}
        onClose={() => !saving && setOpen(false)}
        size={720}
        footer={
          <Space style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button disabled={saving} onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="primary" loading={saving} onClick={save}>
              保存并重算
            </Button>
          </Space>
        }
      >
        <p>
          按当前账号保存到服务器，适用于当前账号查看的所有条码。补货只给出建议，不会下采购单或调整库存。
        </p>
        <Form form={form} layout="vertical" disabled={saving}>
          <h3>1. 需求估计（补货日均）</h3>
          <Form.Item
            name="referencePeriod"
            label="报表周期（保存为默认）"
            rules={[{ required: true }]}
          >
            <Select
              aria-label="报表周期（保存为默认）"
              options={[...inventoryReferencePeriods]}
            />
          </Form.Item>
          <div style={grid}>
            <Form.Item
              name="recentWeight"
              label="近7天权重（%）"
              rules={[{ required: true }]}
              extra="补货日均 = (1−权重)×周期日均 + 权重×近7天日均；默认30%"
            >
              <InputNumber min={0} max={100} precision={0} style={{ width: "100%" }} />
            </Form.Item>
            {days("minValidDays", "最少有效在售天数", 1, 60, "不足时改用人工日销或显示数据不足")}
            <Form.Item
              name="excludeStockoutDays"
              label="剔除缺货日"
              valuePropName="checked"
              extra="当天唯品会可售库存为0且无销量，不计入日均分母"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name="capSpikes"
              label="截断异常峰值"
              valuePropName="checked"
              extra="单日销量高于 Q3+3×IQR（至少2×Q3、3件）按上限计入"
            >
              <Switch />
            </Form.Item>
          </div>
          <p className="secondary">
            罗盘当天没有该条码记录（未上架、新品上架前）不计入分母，也不补0。
          </p>
          <h3>2. 覆盖周期与安全库存</h3>
          <div style={grid}>
            {days("purchaseLeadDays", "采购交期（天）", 1, 365, "下单到可售的天数，初始20天")}
            {days("reviewDays", "补货复核间隔（天）", 1, 90, "多久看一次补货，初始每天")}
            <Form.Item
              name="serviceLevel"
              label="服务水平（不缺货概率）"
              rules={[{ required: true }]}
              extra="安全库存 = z × 日销标准差 × √(交期+复核)"
            >
              <Select
                aria-label="服务水平"
                options={Object.entries(replenishmentServiceLevels).map(([value, item]) => ({
                  value,
                  label: item.z == null ? item.label : `${item.label}（z=${item.z}）`,
                }))}
              />
            </Form.Item>
            {days("safetyDays", "额外安全库存（天）", 0, 90, "在统计安全库存之外再加的天数")}
          </div>
          <h3>3. 下单规则</h3>
          <div style={grid}>
            {days("minOrderQty", "最小起订量（件）", 0, 1_000_000, "0 表示不限制")}
            {days("packSize", "装箱倍数（件）", 1, 100_000, "建议量向上取整到该倍数")}
            <Form.Item
              name="stopDate"
              label="季末停止销售日期（可留空）"
              extra="到货晚于此日期时不建议补货；否则只覆盖到该日期"
            >
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            {days("overstockDays", "滞销阈值（可售天数）", 1, 730, "可售天数超过此值标为滞销")}
          </div>
          <h3>4. 退货回仓</h3>
          <div style={grid}>
            {days("returnDaysMin", "最短可再售回仓周期（天）", 1, 365)}
            {days("returnDaysMax", "最长可再售回仓周期（天）", 1, 365)}
            <Form.Item
              name="resalableRate"
              label="退回商品预计可再售比例（%）"
              rules={[{ required: true }]}
            >
              <InputNumber min={0} max={100} precision={2} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              name="confirmedReturnRate"
              label="已核验的订单批次退货率（%，可留空）"
              extra="留空时不抵扣主建议，报表退货率只用于情景试算"
            >
              <InputNumber
                min={0}
                max={100}
                precision={4}
                placeholder="未核验，暂不抵扣"
                style={{ width: "100%" }}
              />
            </Form.Item>
          </div>
          <h3>渠道日销与退货率参考列</h3>
          <div style={grid}>
            <Form.Item name="dailySalesMethod" label="渠道日销参考取值" rules={[{ required: true }]}>
              <Select
                aria-label="渠道日销参考取值"
                options={Object.entries(inventoryReferenceMethodLabels).map(
                  ([value, label]) => ({ value, label }),
                )}
              />
            </Form.Item>
            <Form.Item name="returnRateMethod" label="退货率参考取值" rules={[{ required: true }]}>
              <Select
                aria-label="退货率参考取值"
                options={Object.entries(inventoryReferenceMethodLabels).map(
                  ([value, label]) => ({ value, label }),
                )}
              />
            </Form.Item>
          </div>
          <p className="secondary">这两项只影响「渠道日销参考」「退货率」列，不参与补货日均。</p>
        </Form>
        <Alert
          type="info"
          showIcon
          title="补货建议 = 补货日均 × (交期 + 复核 + 额外安全天数) + 统计安全库存 − 在仓总库存，再按起订量和装箱倍数取整。"
          description="在仓总库存按当前账号「计算字段」中的仓库总数公式计算。采购在途、调拨在途、进货仓没有预计可售日期，不抵扣，下单前请人工核对，避免重复采购。"
        />
      </Drawer>
    </>
  );
}

function PlanDetails({ plan }: { plan: Row }) {
  const p = plan.policy as ReplenishmentPolicy;
  const d = plan.demand;
  return (
    <div>
      {d.reason && <div>{d.reason}</div>}
      {d.source === "report_weighted" ? (
        <>
          <div>
            有效在售 {d.validDays} 天（剔除缺货 {d.stockoutDays?.length ?? 0} 天、无记录 {d.noRecordDays} 天）
          </div>
          <div>
            周期日均 {number(d.windowMean)}
            {d.recentMean != null
              ? `；近7天日均 ${number(d.recentMean)}（${d.recentDays} 天，权重 ${number(d.recentWeight * 100)}%）`
              : "；近7天有效天数不足3天，未加权"}
          </div>
          {d.cappedDays?.length > 0 && (
            <div>
              峰值截断（上限 {number(d.cap)} 件）：
              {d.cappedDays.map((c: Row) => `${c.date.slice(5)} ${c.salesQty}→${number(c.cappedQty)}`).join("、")}
            </div>
          )}
        </>
      ) : d.source === "report_mean" ? (
        <div>期间销量 {number(d.salesQty)} ÷ 完整 {d.days} 天</div>
      ) : d.source === "manual" ? (
        <div>人工维护日销</div>
      ) : null}
      {d.dailySales != null && <div>补货日均 {number(d.dailySales)} 件</div>}
      {plan.status === "MISSING" && plan.warningCodes?.includes("MISSING_STOCK") && (
        <div>{plan.availableStockLabel ?? "在仓总库存"}无法计算（未匹配聚水潭或尚未在「计算字段配置」保存公式），暂不估算。</div>
      )}
      {plan.quantity != null && (
        <>
          <div>
            覆盖 {plan.horizonDays} 天（交期 {p.purchaseLeadDays} + 复核 {p.reviewDays}
            {plan.daysToStop != null ? `，季末剩余 ${plan.daysToStop} 天` : ""}）+ 额外 {p.safetyDays} 天
          </div>
          <div>
            统计安全库存{" "}
            {plan.serviceLevelZ == null
              ? "未启用"
              : d.stdDev == null
                ? "无法计算（缺少逐日波动）"
                : `${number(plan.safetyStock)} 件 = ${plan.serviceLevelZ} × σ${number(d.stdDev)} × √${plan.horizonDays}`}
          </div>
          <div>
            目标库存 {number(plan.targetStock)} − {plan.availableStockLabel ?? "在仓总库存"} {number(plan.availableQty)} → {plan.rawQuantity} 件
            {plan.quantity !== plan.rawQuantity &&
              `，按起订量 ${p.minOrderQty} / 装箱 ${p.packSize} 取整为 ${plan.quantity} 件`}
          </div>
          {plan.scenarioReturnRate != null && (
            <div>
              {p.confirmedReturnRate == null ? "报表退货率情景（未核验，不抵扣）" : "已核验退货率"}{" "}
              {number(plan.scenarioReturnRate * 100)}%：抵扣后 {number(plan.returnAdjustedQuantityMin)}–
              {number(plan.returnAdjustedQuantityMax)} 件
            </div>
          )}
          {plan.unconfirmedInboundQty > 0 && (
            <div>
              另有在途及进货仓 {number(plan.unconfirmedInboundQty)} 件，预计可售日未知，未抵扣；下单前核对。
            </div>
          )}
          {plan.shortageBeforeArrival > 0 && (
            <div>
              到货前预计缺口 {number(plan.shortageBeforeArrival)} 件，常规采购来不及，需评估加急或调拨。
            </div>
          )}
          {plan.status === "SEASON_END" && <div>按交期到货已晚于季末停止销售日期，不建议补货。</div>}
        </>
      )}
    </div>
  );
}

export function ReplenishmentValue({
  row,
  field,
}: {
  row: Row;
  field: "planningDailySales" | "coverageDays" | "replenishmentQty";
}) {
  const plan = row.replenishmentPlan;
  if (!plan || plan.demand.dailySales == null)
    return (
      <Tooltip title={plan?.demand.reason || "补货数据尚未加载"}>
        <span tabIndex={0}>数据不足</span>
      </Tooltip>
    );
  const value = row[field];
  const text =
    field === "replenishmentQty" && value == null
      ? "暂不估算"
      : value == null
        ? field === "coverageDays" ? "日均为0" : "—"
        : number(Number(value)) +
          (field === "coverageDays" ? "天" : field === "replenishmentQty" ? "件" : "");
  return (
    <Tooltip trigger={["hover", "focus"]} title={<PlanDetails plan={plan} />}>
      <span tabIndex={0}>
        {text}
        {field === "replenishmentQty" &&
          (plan.unconfirmedInboundQty > 0 || plan.shortageBeforeArrival > 0) && (
            <span style={{ marginLeft: 6, color: "var(--app-warning)", fontSize: 12 }}>
              需核对
            </span>
          )}
      </span>
    </Tooltip>
  );
}

const statusColors: Record<ReplenishmentStatus, string> = {
  MISSING: "default",
  SEASON_END: "purple",
  URGENT: "red",
  REORDER: "orange",
  OVERSTOCK: "blue",
  OK: "green",
};

export function replenishmentStatusText(row: Row) {
  const status = row.replenishmentPlan?.status as ReplenishmentStatus | undefined;
  return status ? replenishmentStatusLabels[status] : "";
}

export function ReplenishmentStatusTag({ row }: { row: Row }) {
  const plan = row.replenishmentPlan;
  if (!plan) return <span>—</span>;
  const status = plan.status as ReplenishmentStatus;
  return (
    <Tooltip trigger={["hover", "focus"]} title={<PlanDetails plan={plan} />}>
      <Tag tabIndex={0} color={statusColors[status]}>
        {replenishmentStatusLabels[status]}
      </Tag>
    </Tooltip>
  );
}

export function replenishmentExportNote(row: Row) {
  const plan = row.replenishmentPlan;
  if (!plan) return "";
  if (plan.quantity == null)
    return `补货数据不足：${plan.demand.reason ?? (plan.warningCodes?.includes("MISSING_STOCK") ? "在仓总库存无法计算" : "")}`;
  const p = plan.policy as ReplenishmentPolicy;
  const d = plan.demand;
  const demandText =
    d.source === "report_weighted"
      ? `补货日均${number(d.dailySales)}（有效${d.validDays}天，剔除缺货${d.stockoutDays?.length ?? 0}天，截断峰值${d.cappedDays?.length ?? 0}天，近7天权重${number((d.recentWeight ?? 0) * 100)}%）`
      : d.source === "manual"
        ? `人工日销${number(d.dailySales)}`
        : `完整逐日日均${number(d.dailySales)}`;
  return (
    `${demandText}；覆盖${plan.horizonDays}天+额外${p.safetyDays}天；` +
    `安全库存${plan.serviceLevelZ == null ? "未启用" : `${number(plan.safetyStock)}件(服务水平${p.serviceLevel}%)`}；` +
    `目标库存${number(plan.targetStock)}−${plan.availableStockLabel ?? "在仓总库存"}${number(plan.availableQty)}=${plan.rawQuantity}件` +
    (plan.quantity !== plan.rawQuantity ? `，取整后${plan.quantity}件` : "") +
    `；状态${replenishmentStatusLabels[plan.status as ReplenishmentStatus]}` +
    (p.confirmedReturnRate == null ? "；退货率未核验不抵扣" : `；按核验退货率${number(p.confirmedReturnRate * 100)}%抵扣`) +
    (plan.unconfirmedInboundQty > 0 ? `；在途及进货仓${plan.unconfirmedInboundQty}件未抵扣需核对` : "") +
    (plan.shortageBeforeArrival > 0 ? `；到货前缺口${plan.shortageBeforeArrival}件` : "")
  );
}
