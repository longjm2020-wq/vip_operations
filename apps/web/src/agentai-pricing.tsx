import { Space, Table, Tag, Typography } from "antd";
import type {
  AgentAiModel,
  AgentAiPriceChannel,
} from "../../../packages/contracts/src/agentai";

const amount = (n: number) =>
  n.toLocaleString("zh-CN", { maximumSignificantDigits: 6 });
export function agentAiPriceRange(values: (number | null)[]) {
  const valid = values.filter(
    (n): n is number => n !== null && Number.isFinite(n) && n >= 0,
  );
  if (!valid.length) return null;
  const low = Math.min(...valid),
    high = Math.max(...valid);
  return low === high ? `¥${amount(low)}` : `¥${amount(low)}～${amount(high)}`;
}
export function AgentAiPrice({ model }: { model: AgentAiModel }) {
  const channels = model.pricing?.channels || [];
  const input = agentAiPriceRange(channels.map((c) => c.inputPerMillionRmb));
  const output = agentAiPriceRange(channels.map((c) => c.outputPerMillionRmb));
  const total = agentAiPriceRange(channels.map((c) => c.defaultTotalRmb));
  if (!input && !output && !total)
    return <Typography.Text type="secondary">价格待同步</Typography.Text>;
  return (
    <Space direction="vertical" size={2}>
      {model.type === "chat" && input && <span>输入 {input} / 百万 Token</span>}
      {model.type === "chat" && output && (
        <span>输出 {output} / 百万 Token</span>
      )}
      {(model.type !== "chat" || (!input && !output)) && total && (
        <>
          <span>{total}</span>
          <Typography.Text type="secondary">默认参数整单参考价</Typography.Text>
        </>
      )}
      <Typography.Text type="secondary">
        {channels.length} 个渠道 · 展开查看计费与表现
      </Typography.Text>
    </Space>
  );
}
export function AgentAiPriceChannels({ model }: { model: AgentAiModel }) {
  return (
    <Space direction="vertical" style={{ width: "100%" }} size="small">
      <Typography.Text type="secondary">
        以下为账号实付价。整单参考价对应供应商默认参数；本次价格由实际时长、清晰度、档位与素材决定。渠道由智能调度选择。
      </Typography.Text>
      <Table<AgentAiPriceChannel>
        size="small"
        pagination={false}
        rowKey={(c, i) => `${c.vendor}-${c.laneNo}-${i}`}
        dataSource={model.pricing?.channels || []}
        scroll={{ x: 610 }}
        columns={[
          {
            title: "渠道",
            render: (_, c) => `${c.vendor} · ${c.laneNo ?? "—"}`,
          },
          {
            title: "计费与价格",
            render: (_, c) => (
              <Space direction="vertical" size={2}>
                <Tag>
                  {c.billingMethod || c.billingUnit || "计费方式待同步"}
                </Tag>
                {c.inputPerMillionRmb !== null && (
                  <span>输入 ¥{amount(c.inputPerMillionRmb)} / 百万 Token</span>
                )}
                {c.outputPerMillionRmb !== null && (
                  <span>
                    输出 ¥{amount(c.outputPerMillionRmb)} / 百万 Token
                  </span>
                )}
                {c.defaultTotalRmb !== null && (
                  <span>默认参数整单 ¥{amount(c.defaultTotalRmb)}</span>
                )}
              </Space>
            ),
          },
          {
            title: "近 24 小时表现",
            render: (_, c) =>
              c.statsSource === "live" ? (
                <Space direction="vertical" size={2}>
                  <span>
                    {c.successRate24h === null
                      ? "成功率暂无"
                      : `成功率 ${amount(c.successRate24h)}%`}
                  </span>
                  <span>
                    {c.avgResponseSeconds !== null && c.avgResponseSeconds > 0
                      ? `平均耗时 ${amount(c.avgResponseSeconds)} 秒`
                      : "耗时暂无有效统计"}
                  </span>
                </Space>
              ) : (
                <Typography.Text type="secondary">
                  {c.statsSource === "estimate"
                    ? "估测数据，暂无实测表现"
                    : "暂无实测数据"}
                </Typography.Text>
              ),
          },
        ]}
      />
      {model.pricing?.generatedAt && (
        <Typography.Text type="secondary">
          供应商价目时间：
          {new Date(model.pricing.generatedAt).toLocaleString("zh-CN")}
        </Typography.Text>
      )}
    </Space>
  );
}
