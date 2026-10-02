import { App, Button, DatePicker, Select, Space, Tooltip } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useMemo } from "react";
import "dayjs/locale/zh-cn";
import zhCN from "antd/es/date-picker/locale/zh_CN";
import {
  compassPeriodRange,
  compassRecentDays,
  shanghaiDate,
  shiftCompassDate,
  type CompassDateRange,
  type CompassPeriod,
} from "../../../packages/contracts/src/compass-analytics";
export function CompassDateFilter({
  period,
  range,
  sourceEnd,
  onChange,
}: {
  period: CompassPeriod;
  range: CompassDateRange | null;
  sourceEnd?: string;
  onChange: (period: CompassPeriod, range: CompassDateRange | null) => void;
}) {
  const { message } = App.useApp(),
    maxEnd = shiftCompassDate(shanghaiDate(), -1),
    anchor = sourceEnd || maxEnd,
    displayed = range || compassPeriodRange(period, anchor, maxEnd);
  const pickerValue = useMemo<[Dayjs, Dayjs]>(
    () => [dayjs(displayed[0]), dayjs(displayed[1])],
    [displayed[0], displayed[1]],
  );
  return (
    <Space wrap className="compass-date-filter">
      <span className="secondary">统计日期</span>
      <div
        className="compass-recent-buttons"
        role="group"
        aria-label="快捷统计日期"
      >
        {compassRecentDays.map((days) => {
          const value = `recent:${days}` as CompassPeriod;
          return (
            <Button
              key={days}
              type="text"
              size="small"
              aria-pressed={period === value}
              onClick={() =>
                onChange(
                  value,
                  range
                    ? compassPeriodRange(value, displayed[1], maxEnd)
                    : null,
                )
              }
            >
              近 {days} 天
            </Button>
          );
        })}
      </div>
      <Tooltip title="最近周期相对截止日期；自然周从周一开始，当前自然周期截至昨日。">
        <Select
          aria-label="统计日期"
          style={{ width: 120 }}
          virtual={false}
          placeholder="更多周期"
          value={period.startsWith("recent:") ? undefined : period}
          options={[
            {
              label: "自然周期",
              options: [
                { value: "day", label: "日" },
                { value: "week", label: "周" },
                { value: "month", label: "月" },
                { value: "quarter", label: "季" },
                { value: "year", label: "年" },
              ],
            },
            { value: "custom", label: "自定义" },
          ]}
          onChange={(value: CompassPeriod) => {
            if (value === "custom") onChange(value, displayed);
            else
              onChange(value, compassPeriodRange(value, displayed[1], maxEnd));
          }}
        />
      </Tooltip>
      <label className="compass-sr-only" htmlFor="compass-range-start">
        统计开始日期
      </label>
      <label className="compass-sr-only" htmlFor="compass-range-end">
        统计截止日期
      </label>
      <DatePicker.RangePicker
        id={{ start: "compass-range-start", end: "compass-range-end" }}
        locale={zhCN}
        format="YYYY-MM-DD"
        allowClear={false}
        style={{ width: 285, maxWidth: "100%" }}
        value={pickerValue}
        maxDate={dayjs(maxEnd)}
        disabledDate={(date, info) =>
          date.format("YYYY-MM-DD") > maxEnd ||
          Boolean(info.from && Math.abs(date.diff(info.from, "day")) > 365)
        }
        onChange={(dates) => {
          if (!dates?.[0] || !dates?.[1]) return;
          if (dates[1].diff(dates[0], "day") > 365) {
            message.warning("统计区间最多支持 366 天");
            return;
          }
          onChange("custom", [
            dates[0].format("YYYY-MM-DD"),
            dates[1].format("YYYY-MM-DD"),
          ]);
        }}
      />
      {range && (
        <Button
          type="link"
          onClick={() =>
            onChange(period.startsWith("recent:") ? period : "recent:7", null)
          }
        >
          最新报表
        </Button>
      )}
    </Space>
  );
}
