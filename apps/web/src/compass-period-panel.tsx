import { Button } from "antd";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import { useEffect, useRef } from "react";
import {
  compassPeriodRange,
  type CompassDateRange,
} from "../../../packages/contracts/src/compass-analytics";

export type CompassCalendarPeriod = "month" | "quarter" | "year";
export const compassCalendarLabels = {
  month: "月份",
  quarter: "季度",
  year: "年份",
};
const monthNames = [
  "一月",
  "二月",
  "三月",
  "四月",
  "五月",
  "六月",
  "七月",
  "八月",
  "九月",
  "十月",
  "十一月",
  "十二月",
];

export function CompassPeriodPanel({
  period,
  year,
  selectedRange,
  maxEnd,
  onYear,
  onSelect,
  onClose,
}: {
  period: CompassCalendarPeriod;
  year: number;
  selectedRange: CompassDateRange | null;
  maxEnd: string;
  onYear: (year: number) => void;
  onSelect: (range: CompassDateRange) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const decade = Math.floor(year / 10) * 10;
  const yearMode = period === "year";
  const values = Array.from(
    { length: yearMode ? 10 : period === "month" ? 12 : 4 },
    (_, index) => index,
  );
  useEffect(() => {
    const selected = root.current?.querySelector<HTMLButtonElement>(
      '.compass-period-option[aria-pressed="true"]',
    );
    const first = root.current?.querySelector<HTMLButtonElement>(
      ".compass-period-option:not(:disabled)",
    );
    (selected || first)?.focus({ preventScroll: true });
  }, [period]);
  return (
    <div
      ref={root}
      className={`compass-period-panel compass-period-panel-${period}`}
      role="dialog"
      aria-label={`选择统计${compassCalendarLabels[period]}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="compass-period-panel-header">
        <Button
          type="text"
          size="small"
          aria-label={yearMode ? "前十年" : "上一年"}
          disabled={yearMode ? decade <= 10 : year <= 1}
          icon={<LeftOutlined />}
          onClick={() => onYear(year - (yearMode ? 10 : 1))}
        />
        <strong>
          {yearMode ? `${decade} 年 — ${decade + 9} 年` : `${year} 年`}
        </strong>
        <Button
          type="text"
          size="small"
          aria-label={yearMode ? "后十年" : "下一年"}
          disabled={
            (yearMode ? decade + 10 : year + 1) > Number(maxEnd.slice(0, 4))
          }
          icon={<RightOutlined />}
          onClick={() => onYear(year + (yearMode ? 10 : 1))}
        />
      </div>
      <div className="compass-period-grid">
        {values.map((index) => {
          const optionYear = yearMode ? decade + index : year;
          const month =
            period === "month"
              ? index + 1
              : period === "quarter"
                ? index * 3 + 1
                : 1;
          const start = `${String(optionYear).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
          const disabled = start > maxEnd || optionYear < 1;
          const value = disabled
            ? null
            : compassPeriodRange(period, start, maxEnd);
          const selected = value !== null && selectedRange?.[0] === value[0];
          const label = yearMode
            ? `${optionYear}`
            : period === "month"
              ? monthNames[index]
              : `第${["一", "二", "三", "四"][index]}季度`;
          return (
            <button
              key={index}
              type="button"
              className="compass-period-option"
              disabled={disabled}
              aria-pressed={selected}
              aria-label={
                yearMode
                  ? `${optionYear}年`
                  : `${optionYear}年${period === "month" ? `${month}月` : label}`
              }
              onClick={() => value && onSelect(value)}
            >
              <span>{label}</span>
              {period === "quarter" && (
                <small>
                  {month}月、{month + 1}月、{month + 2}月
                </small>
              )}
            </button>
          );
        })}
      </div>
      <div className="compass-period-panel-footer">
        <span>可选截止日：{maxEnd}</span>
        <Button type="text" size="small" onClick={onClose}>
          取消
        </Button>
      </div>
    </div>
  );
}
