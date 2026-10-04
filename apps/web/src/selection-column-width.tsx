import { useState } from "react";
import { InputNumber, Modal, Select, Space } from "antd";

const pixelsPerCentimeter = 96 / 2.54;

export function SelectionColumnWidthModal({ columns, onApply, onCancel }: {
  columns: { key: string; label: string; width: number }[];
  onApply: (pixels: number) => void;
  onCancel: () => void;
}) {
  const [unit, setUnit] = useState<"px" | "cm">("px");
  // Keep pixels as the source value so switching units does not accumulate rounding errors.
  const [pixels, setPixels] = useState<number | null>(columns[0].width);
  const roundedPixels = pixels === null ? null : Math.round(pixels);
  const valid = roundedPixels !== null && Number.isFinite(roundedPixels) && roundedPixels >= 80;
  const value = pixels === null ? null : unit === "cm" ? Number((pixels / pixelsPerCentimeter).toFixed(2)) : pixels;
  const apply = () => { if (valid) onApply(roundedPixels!); };
  return <Modal title="设置列宽" open width={420} okText="确定" cancelText="取消" onCancel={onCancel} onOk={apply} okButtonProps={{ disabled: !valid }}>
    <p>{columns.length === 1 ? columns[0].label : `已选择 ${columns.length} 列，确定后统一设置列宽。`}</p>
    <Space>
      <label htmlFor="selection-column-width">列宽</label>
      <InputNumber id="selection-column-width" aria-label="列宽数值" autoFocus value={value} min={unit === "px" ? 80 : 2.12} precision={unit === "px" ? 0 : 2} step={unit === "px" ? 1 : 0.1} style={{ width: 140 }} onChange={value => setPixels(value === null ? null : Number(value) * (unit === "cm" ? pixelsPerCentimeter : 1))} onPressEnter={apply}/>
      <Select aria-label="列宽单位" value={unit} options={[{ value: "px", label: "像素 (px)" }, { value: "cm", label: "厘米 (cm)" }]} onChange={setUnit} style={{ width: 120 }}/>
    </Space>
    <p className="selection-column-width-help">{valid ? `应用宽度：${roundedPixels} px。` : "请输入有效列宽。"}最小列宽为 80 px（约 2.12 cm）。</p>
    <p className="selection-column-width-help">厘米按网页标准换算：1 cm ≈ 37.80 px，实际显示尺寸随屏幕和缩放变化。</p>
  </Modal>;
}
