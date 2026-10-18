import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Drawer,
  Form,
  InputNumber,
  Select,
  Space,
  Tooltip,
} from "antd";
import { CalculatorOutlined } from "@ant-design/icons";
import {
  inventoryReferencePeriods,
  type InventoryReferencePeriod,
} from "../../../packages/contracts/src/inventory-summary";
import { inventoryReferenceMethodLabels } from "../../../packages/contracts/src/compass-inventory-reference";
import { api, queryClient } from "./api";
import type { Row } from "./shared";
import {
  replenishmentPolicySchema,
  type ReplenishmentPolicy,
} from "../../../packages/contracts/src/inventory-replenishment";

const number = (value: number) =>
  value.toLocaleString("zh-CN", { maximumFractionDigits: 4 });

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
      message.success("计算配置已按账号保存");
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Tooltip title={open ? null : "计算配置"}>
        <Button
          aria-label="计算配置"
          icon={<CalculatorOutlined />}
          onClick={load}
          loading={loading}
        />
      </Tooltip>
      <Drawer
        title="计算面板"
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
          按当前账号保存到服务器，跨电脑、浏览器恢复；应用于当前账号查看的所有条码。按实际情况调整交期后重新估算。
        </p>
        <Form form={form} layout="vertical" disabled={saving}>
          <h3>渠道日销与退货率</h3>
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
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0 20px",
            }}
          >
            <Form.Item
              name="dailySalesMethod"
              label="渠道日销参考取值"
              rules={[{ required: true }]}
            >
              <Select
                aria-label="渠道日销参考取值"
                options={Object.entries(inventoryReferenceMethodLabels).map(
                  ([value, label]) => ({ value, label }),
                )}
              />
            </Form.Item>
            <Form.Item
              name="returnRateMethod"
              label="退货率参考取值"
              rules={[{ required: true }]}
            >
              <Select
                aria-label="退货率参考取值"
                options={Object.entries(inventoryReferenceMethodLabels).map(
                  ([value, label]) => ({ value, label }),
                )}
              />
            </Form.Item>
          </div>
          <p>
            中位数取排序后的中间值；众数取最高频次，多个数并列时取这些数的均值；平均值为有效每日记录合计÷有效天数。明确的0参与计算，缺失不补0。
          </p>
          <p>
            预估销退数 = 所选期间销量合计 ×
            退货率参考。报表每日退货率可能跨销售批次，仅作经营参考。
          </p>
          <h3>补货与可售天数</h3>
          <p>
            补货日均固定采用完整逐日销量的平均值；缺少完整记录时使用已维护的人工日销，并标注来源。可售天数
            = 可售库存÷补货日均。
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0 20px",
            }}
          >
            <Form.Item
              name="purchaseLeadDays"
              label="采购交期（天）"
              rules={[{ required: true }]}
              extra="通常3–20天，初始按20天"
            >
              <InputNumber
                min={1}
                max={365}
                precision={0}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              name="reviewDays"
              label="补货复核间隔（天）"
              rules={[{ required: true }]}
              extra="初始每天复核一次"
            >
              <InputNumber
                min={1}
                max={90}
                precision={0}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              name="returnDaysMin"
              label="最短可再售回仓周期（天）"
              rules={[{ required: true }]}
            >
              <InputNumber
                min={1}
                max={365}
                precision={0}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              name="returnDaysMax"
              label="最长可再售回仓周期（天）"
              rules={[{ required: true }]}
            >
              <InputNumber
                min={1}
                max={365}
                precision={0}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              name="resalableRate"
              label="退回商品预计可再售比例（%）"
              rules={[{ required: true }]}
            >
              <InputNumber
                min={0}
                max={100}
                precision={2}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              name="safetyDays"
              label="额外安全库存（天）"
              rules={[{ required: true }]}
              extra="初始为0；尚未按缺货容忍度设置缓冲"
            >
              <InputNumber
                min={0}
                max={90}
                precision={0}
                style={{ width: "100%" }}
              />
            </Form.Item>
          </div>
          <p>
            回仓周期从销售发货日开始，截止质检合格可再售。未来第1天发货的商品，按15天周期最早在第16天重新可售。
          </p>
          <Form.Item
            name="confirmedReturnRate"
            label="已核验的订单批次退货率（%，可留空）"
            extra="填写后用于本账号所有条码的补货估算，请仅在该概率适用于这些商品时填写。留空时，报表参考退货率只用于回仓情景试算，不抵扣主建议。"
          >
            <InputNumber
              min={0}
              max={100}
              precision={4}
              placeholder="未核验，暂不抵扣"
              style={{ width: "100%" }}
            />
          </Form.Item>
        </Form>
        <Alert
          type="info"
          showIcon
          title="主建议按补货日均、交期、复核间隔和安全库存估算。"
          description="只模拟未来新发货的延迟退回，不将过去30天的预估销退数当作待回仓库存。没有预计可售日期的在途、进货仓数量需人工核对，暂不抵扣。保存参数不会下采购单或调整库存。"
        />
      </Drawer>
    </>
  );
}

function PlanDetails({ plan }: { plan: Row }) {
  const p = plan.policy as ReplenishmentPolicy;
  return (
    <div>
      {plan.demand.reason && <div>{plan.demand.reason}</div>}
      <div>
        {plan.demand.source === "report_mean"
          ? `期间销量 ${number(plan.demand.salesQty)} ÷ 完整 ${plan.demand.days} 天`
          : "人工维护日销"}
        ；补货日均 {number(plan.demand.dailySales)} 件
      </div>
      <div>
        采购交期 {p.purchaseLeadDays} 天 + 复核间隔 {p.reviewDays} 天；安全库存{" "}
        {p.safetyDays} 天
      </div>
      <div>
        当前可售 {number(plan.availableQty)} 件；未抵扣退货的需求{" "}
        {number(plan.grossQuantity)} 件
      </div>
      <div>
        从销售发货至可再售 {p.returnDaysMin}–{p.returnDaysMax} 天；预计可再售{" "}
        {number(p.resalableRate * 100)}%
      </div>
      {plan.scenarioReturnRate == null ? (
        <div>
          缺少有效退货概率，暂不估算回仓；大于100%的报表退货比不能作为概率。
        </div>
      ) : (
        <>
          <div>
            {p.confirmedReturnRate == null
              ? "报表参考退货率情景（未核验订单批次）"
              : "人工核验订单批次退货率"}
            ：{number(plan.scenarioReturnRate * 100)}%
          </div>
          <div>
            {plan.horizonDays} 天内未来新发货预计可再售回仓：
            {number(plan.expectedReusableReturnsMin)}–
            {number(plan.expectedReusableReturnsMax)} 件
          </div>
          <div>
            抵扣情景需求：{number(plan.returnAdjustedQuantityMin)}–
            {number(plan.returnAdjustedQuantityMax)} 件；
            {p.confirmedReturnRate == null
              ? "主建议未抵扣"
              : "主建议采用最长回仓周期"}
          </div>
        </>
      )}
      {plan.unconfirmedInboundQty > 0 && (
        <div>
          另有在途及进货仓 {number(plan.unconfirmedInboundQty)}{" "}
          件，预计可售日未知，未抵扣；下单前核对，避免重复采购。
        </div>
      )}
      {plan.shortageBeforeArrival > 0 && (
        <div>
          到货前预计缺口 {number(plan.shortageBeforeArrival)}{" "}
          件，需评估加急或调拨；常规采购不能解决交期内缺货。
        </div>
      )}
      <div>
        既往订单待退回数量未知，不重复计入；未来发货按可满足需求的情景估算。尚未校准季节、促销及缺货造成的销量损失。
      </div>
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
    value == null
      ? "补货日均为0"
      : number(Number(value)) +
        (field === "coverageDays"
          ? "天"
          : field === "replenishmentQty"
            ? "件"
            : "");
  return (
    <Tooltip trigger={["hover", "focus"]} title={<PlanDetails plan={plan} />}>
      <span tabIndex={0}>
        {text}
        {field === "replenishmentQty" &&
          (plan.unconfirmedInboundQty > 0 ||
            plan.shortageBeforeArrival > 0) && (
            <span style={{ marginLeft: 6, color: "#ad6800", fontSize: 12 }}>
              需核对
            </span>
          )}
      </span>
    </Tooltip>
  );
}

export function replenishmentExportNote(row: Row) {
  const plan = row.replenishmentPlan;
  if (!plan) return "";
  if (plan.quantity == null) return `补货数据不足：${plan.demand.reason}`;
  const p = plan.policy;
  return (
    `补货按${plan.demand.source === "report_mean" ? "完整逐日日均" : "人工日销"}；交期${p.purchaseLeadDays}天+复核${p.reviewDays}天+安全库存${p.safetyDays}天；` +
    `回仓${p.returnDaysMin}–${p.returnDaysMax}天（销售发货至可再售），可再售${number(p.resalableRate * 100)}%；` +
    (p.confirmedReturnRate == null
      ? "订单批次退货率未核验，主建议不抵扣退货；"
      : `人工核验退货率${number(p.confirmedReturnRate * 100)}%，按最长回仓周期抵扣未来新发货的预计退货；`) +
    `未抵扣退货需求${plan.grossQuantity}件；回仓情景需求${plan.returnAdjustedQuantityMin ?? "—"}–${plan.returnAdjustedQuantityMax ?? "—"}件；` +
    `预计可售日未知的在途及进货仓${plan.unconfirmedInboundQty}件未抵扣；到货前预计缺口${plan.shortageBeforeArrival}件；既往订单待回仓不作估计；需人工核对`
  );
}
