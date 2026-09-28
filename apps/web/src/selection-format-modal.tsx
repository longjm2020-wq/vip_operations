import { useState } from "react";
import { Modal, Tabs, Select, InputNumber, Space } from "antd";
import { formatSelectionValue, type CellNumberFormat } from "../../../packages/contracts/src/selection-format";

export type FormatPatch = { cellNumberFormats?: CellNumberFormat; cellAlignments?: string; cellVerticalAlignments?: string; cellColors?: string; cellTextColors?: string };
const formats = [
  ["general", "常规"], ["number", "数值"], ["currency", "货币"], ["accounting", "会计专用"],
  ["date", "日期"], ["time", "时间"], ["percent", "百分比"], ["fraction", "分数"],
  ["scientific", "科学记数"], ["text", "文本"], ["thousands", "千位分隔样式"], ["special", "特殊（六位编号）"], ["custom", "自定义（预设格式）"],
];
export function SelectionFormatModal({ count, sample, initial, onCancel, onApply }: { count: number; sample: unknown; initial: FormatPatch; onCancel: () => void; onApply: (patch: FormatPatch) => void }) {
  const [patch, setPatch] = useState<FormatPatch>({});
  const values = { ...initial, ...patch };
  const format = values.cellNumberFormats || { type: "general", decimals: 2, pattern: "0.00" };
  const changeFormat = (change: Partial<CellNumberFormat>) => setPatch(current => ({ ...current, cellNumberFormats: { ...format, ...change } }));
  const selectStyle = (label: string, key: Exclude<keyof FormatPatch, "cellNumberFormats">, options: { value: string; label: string }[]) => <label className="selection-format-field">{label}<Select aria-label={label} placeholder="保持原设置" value={values[key]} options={options} onChange={value => setPatch(current => ({ ...current, [key]: value }))} /></label>;
  return <Modal open title={`设置单元格格式 · ${count} 个单元格`} width={460} okText="应用" cancelText="取消" onCancel={onCancel} onOk={() => onApply(patch)} okButtonProps={{ disabled: !Object.keys(patch).length }}>
    <Tabs items={[
      { key: "number", label: "数字格式", children: <Space orientation="vertical" style={{ width: "100%" }} size={16}>
        <Select aria-label="数字格式" style={{ width: "100%" }} value={format.type} options={formats.map(([value, label]) => ({ value, label }))} onChange={type => changeFormat({ type })} />
        {["number", "currency", "accounting", "percent", "scientific", "thousands"].includes(format.type) && <label className="selection-format-field">小数位数<InputNumber aria-label="小数位数" min={0} max={8} precision={0} value={format.decimals} onChange={value => changeFormat({ decimals: value ?? 2 })} /></label>}
        {format.type === "custom" && <label className="selection-format-field">格式样式<Select aria-label="格式样式" value={format.pattern} options={["0", "0.00", "#,##0", "#,##0.00", "0%", "0.00%", "yyyy-MM-dd", "yyyy/M/d", "HH:mm:ss", "000000"].map(value => ({ value, label: value }))} onChange={pattern => changeFormat({ pattern })} /></label>}
        <div className="selection-format-preview">示例：{formatSelectionValue(sample, format) || "（空单元格）"}</div>
        <p className="selection-format-note">仅改变显示，不改写原始内容。日期接受 YYYY-MM-DD，时间接受 HH:mm[:ss]。图片、颜色和尺码保留原展示；无法转换的内容按原文显示。自定义提供预设样式。</p>
      </Space> },
      { key: "cell", label: "单元格", children: <Space orientation="vertical" style={{ width: "100%" }} size={16}>
        {selectStyle("水平对齐", "cellAlignments", [{ value: "left", label: "左对齐" }, { value: "center", label: "居中" }, { value: "right", label: "右对齐" }])}
        {selectStyle("垂直对齐", "cellVerticalAlignments", [{ value: "top", label: "顶端对齐" }, { value: "middle", label: "垂直居中" }, { value: "bottom", label: "底端对齐" }])}
        {selectStyle("背景填色", "cellColors", [["NONE", "无填色"], ["ORANGE", "橙色"], ["YELLOW", "黄色"], ["GREEN", "绿色"], ["BLUE", "蓝色"], ["PINK", "粉色"]].map(([value, label]) => ({ value, label })))}
      </Space> },
      { key: "text", label: "文本", children: selectStyle("字体颜色", "cellTextColors", [["", "默认颜色"], ["#262626", "黑色"], ["#cf1322", "红色"], ["#d46b08", "橙色"], ["#ad8b00", "金色"], ["#389e0d", "绿色"], ["#0958d9", "蓝色"], ["#531dab", "紫色"], ["#c41d7f", "粉色"], ["#595959", "灰色"]].map(([value, label]) => ({ value, label }))) },
    ]} />
  </Modal>;
}
