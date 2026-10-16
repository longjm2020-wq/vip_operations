import { Button, Input, InputNumber, Select } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import type { SelectionField } from "./selection-field-types";
import {
  defaultVipTagPriceLimitConfig,
  isSelectionComputedField,
  normalizeVipTagPriceCategory,
  selectionVipTagPriceLimitConfigSchema,
  type VipTagPriceLimitConfig,
} from "../../../packages/contracts/src/selection-vip-tag-price-limit.js";
import "./selection-vip-tag-price-limit-settings.css";

export function vipTagPriceLimitSourceFields(field: SelectionField, columns: SelectionField[]) {
  return columns.filter(source => !source.deleted && source.key !== field.key && !isSelectionComputedField(source) && ["text", "single"].includes(source.type || source.fallbackType || "text"));
}

export function initializeVipTagPriceLimitSettings(field: SelectionField, columns: SelectionField[]): SelectionField {
  if (field.type !== "vipTagPriceLimit" || field.vipTagPriceLimitConfig) return field;
  const sources = vipTagPriceLimitSourceFields(field, columns);
  const source = ["三级类目", "三级品类", "三级分类"].map(label => sources.find(candidate => normalizeVipTagPriceCategory(candidate.label) === label)).find(Boolean);
  return { ...field, vipTagPriceLimitConfig: defaultVipTagPriceLimitConfig(source?.key || "") };
}

export function vipTagPriceLimitSettingsError(field: SelectionField, columns: SelectionField[]): string | null {
  if (field.type !== "vipTagPriceLimit") return null;
  const config = field.vipTagPriceLimitConfig;
  if (!config?.sourceKey) return "请选择三级类目来源字段";
  if (!vipTagPriceLimitSourceFields(field, columns).some(source => source.key === config.sourceKey)) return "三级类目来源字段已不可用，请重新选择有效的文本或单选字段";
  if (config.rules.length > 500) return "吊牌限价匹配规则最多500条";
  const categories = new Set<string>();
  for (const [index, rule] of config.rules.entries()) {
    const category = normalizeVipTagPriceCategory(rule.category);
    if (!category || category.length > 80) return `第${index + 1}条规则的三级类目须为1至80字`;
    if (categories.has(category)) return `第${index + 1}条规则的三级类目“${category}”已存在，请合并重复规则`;
    categories.add(category);
    if (!Number.isFinite(rule.limit) || rule.limit < 0 || rule.limit > 999999999.99 || rule.limit !== Math.round(rule.limit * 100) / 100) return `第${index + 1}条规则的吊牌限价须为0至999999999.99的金额，最多两位小数`;
  }
  const parsed = selectionVipTagPriceLimitConfigSchema.safeParse(config);
  return parsed.success ? null : parsed.error.issues[0]?.message || "请检查吊牌限价匹配规则";
}

export function SelectionVipTagPriceLimitSettings({ field, columns, onChange }: {
  field: SelectionField;
  columns: SelectionField[];
  onChange: (config: VipTagPriceLimitConfig) => void;
}) {
  const config = field.vipTagPriceLimitConfig || defaultVipTagPriceLimitConfig("");
  const sources = vipTagPriceLimitSourceFields(field, columns);
  const sourceAvailable = sources.some(source => source.key === config.sourceKey);
  const sourceOptions = sources.map(source => ({ value: source.key, label: source.label }));
  if (config.sourceKey && !sourceAvailable) sourceOptions.unshift({ value: config.sourceKey, label: "原来源字段不可用，请重新选择" });
  const changeRule = (index: number, patch: Partial<VipTagPriceLimitConfig["rules"][number]>) => onChange({ ...config, rules: config.rules.map((rule, position) => position === index ? { ...rule, ...patch } : rule) });
  return <fieldset className="selection-vip-tag-price-limit-settings">
    <legend>唯品吊牌限价设置</legend>
    <label>三级类目来源字段<Select aria-label="三级类目来源字段" showSearch optionFilterProp="label" placeholder="请选择文本或单选类目字段" value={config.sourceKey || undefined} options={sourceOptions} status={config.sourceKey && !sourceAvailable ? "error" : undefined} onChange={sourceKey => onChange({ ...config, sourceKey })} /></label>
    <p>根据来源字段的完整类目名称自动匹配，忽略首尾空格及全角、半角差异。来源为空或未匹配时留空；不模糊匹配，也不根据上级类目推断。</p>
    <div className="selection-vip-tag-price-limit-rules">
      <table aria-label="吊牌限价匹配规则">
        <thead><tr><th scope="col">三级类目</th><th scope="col">吊牌限价（元）</th><th scope="col"><span className="selection-vip-tag-price-limit-action-label">操作</span></th></tr></thead>
        <tbody>{config.rules.map((rule, index) => <tr key={index}>
          <td><Input aria-label={`第${index + 1}条三级类目`} maxLength={80} value={rule.category} placeholder="输入完整三级类目" onChange={event => changeRule(index, { category: event.target.value })} /></td>
          <td><InputNumber<number> aria-label={`第${index + 1}条吊牌限价`} value={Number.isFinite(rule.limit) ? rule.limit : null} placeholder="限价" onChange={limit => changeRule(index, { limit: limit ?? Number.NaN })} /></td>
          <td><Button type="text" danger icon={<DeleteOutlined />} aria-label={`删除第${index + 1}条限价规则`} onClick={() => onChange({ ...config, rules: config.rules.filter((_, position) => position !== index) })} /></td>
        </tr>)}</tbody>
      </table>
      {!config.rules.length && <p className="selection-vip-tag-price-limit-empty">暂无匹配规则，添加后填写类目及限价。</p>}
    </div>
    <Button type="dashed" block aria-label="新增三级类目规则" icon={<PlusOutlined />} disabled={config.rules.length >= 500} onClick={() => onChange({ ...config, rules: [...config.rules, { category: "", limit: Number.NaN }] })}>新增三级类目规则</Button>
    <p>最多500条规则，同一类目只能有一条，限价为非负金额，最多两位小数。点击窗口「保存」后生效；类目或规则更新会重新匹配所有行。此类型为自动计算结果，不支持逐格手填，切换类型保留原有手填内容。</p>
  </fieldset>;
}
