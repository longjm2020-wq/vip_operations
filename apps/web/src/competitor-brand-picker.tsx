import { Button, Checkbox, Space } from "antd";
import type { CompetitorBrand } from "../../../packages/contracts/src/competitor-analysis";

export function CompetitorBrandPicker({
  brands,
  value,
  onChange,
  disabled = false,
  label = "选择采集品牌",
}: {
  brands: CompetitorBrand[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  label?: string;
}) {
  const selected = brands.filter((brand) => value.includes(brand.id));
  return (
    <div className="competitor-brand-picker" role="group" aria-label={label}>
      <Space wrap className="competitor-brand-picker-heading">
        <strong>{label}</strong>
        <span>
          已选 {selected.length} / {brands.length} 个品牌
        </span>
        <Button
          size="small"
          disabled={disabled}
          onClick={() => onChange(brands.map((b) => b.id))}
        >
          全选
        </Button>
        <Button size="small" disabled={disabled} onClick={() => onChange([])}>
          清空
        </Button>
      </Space>
      <Checkbox.Group
        className="competitor-brand-picker-options"
        value={selected.map((b) => b.id)}
        disabled={disabled}
        onChange={(ids) => onChange(ids as string[])}
        options={brands.map((b) => ({ label: b.name, value: b.id }))}
      />
      {!selected.length && (
        <div className="competitor-muted">请至少选择一个品牌</div>
      )}
    </div>
  );
}
