import { useState } from "react";
import { Button, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { AgentAiModel } from "../../../packages/contracts/src/agentai";
import {
  classifySmartModel,
  defaultSmartFilterPolicy,
  evaluateAgentAiPricingChannels,
  resolveSmartWeights,
  type EvaluatedChannel,
  type SmartChannelOverride,
  type SmartModelsSettingsState,
} from "../../../packages/contracts/src/smart-models";

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

function evaluateChannelsForModel(
  model: AgentAiModel,
  smartSettings?: SmartModelsSettingsState,
) {
  const raw = model.pricing?.channels || [];
  const category = classifySmartModel(model.model, model.type);
  const weights = smartSettings
    ? resolveSmartWeights(smartSettings.preset, smartSettings.weights)
    : undefined;
  return evaluateAgentAiPricingChannels(
    model.model,
    model.name,
    category,
    raw,
    {
      vision: model.vision,
      tools: model.parameters.includes("tools"),
      structured: model.parameters.includes("structured_outputs"),
      verified: Boolean(model.chatVerifiedAt),
      weights,
      policy: smartSettings?.filterPolicy || defaultSmartFilterPolicy,
      overrides: smartSettings?.channelOverrides || [],
    },
  );
}

export function AgentAiPrice({
  model,
  smartSettings,
}: {
  model: AgentAiModel;
  smartSettings?: SmartModelsSettingsState;
}) {
  const rawChannels = model.pricing?.channels || [];
  const evaluated = evaluateChannelsForModel(model, smartSettings);
  const active = evaluated.filter((c) => !c.shielded);
  const shieldedCount = evaluated.length - active.length;
  const displayPool = active.length ? active : rawChannels;

  const input = agentAiPriceRange(displayPool.map((c) => c.inputPerMillionRmb));
  const output = agentAiPriceRange(
    displayPool.map((c) => c.outputPerMillionRmb),
  );
  const total = agentAiPriceRange(displayPool.map((c) => c.defaultTotalRmb));
  if (!input && !output && !total)
    return <Typography.Text type="secondary">价格待同步</Typography.Text>;

  const top = active[0];
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
      <Space size={4} wrap>
        {top ? (
          <Tag color="green">
            智选 {active.length}/{evaluated.length} · {top.scores.overall}分
          </Tag>
        ) : (
          <Tag color="orange">暂无达标渠道</Tag>
        )}
        {shieldedCount > 0 && (
          <Tag color="default">已屏蔽 {shieldedCount}</Tag>
        )}
      </Space>
      <Typography.Text type="secondary">
        {rawChannels.length} 个渠道 · 展开查看智选评分与表现
      </Typography.Text>
    </Space>
  );
}

export function AgentAiPriceChannels({
  model,
  smartSettings,
  onOverrideChannel,
}: {
  model: AgentAiModel;
  smartSettings?: SmartModelsSettingsState;
  onOverrideChannel?: (
    channelKey: string,
    action: SmartChannelOverride["action"] | null,
  ) => void;
}) {
  const [showShielded, setShowShielded] = useState(false);
  const evaluated = evaluateChannelsForModel(model, smartSettings);
  const active = evaluated.filter((c) => !c.shielded);
  const shielded = evaluated.filter((c) => c.shielded);
  const hideShielded =
    (smartSettings?.filterPolicy.hideShielded ?? true) &&
    active.length > 0 &&
    !showShielded;
  const visible = hideShielded ? active : evaluated;

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="small">
      <Space
        style={{ width: "100%", justifyContent: "space-between" }}
        wrap
        size="small"
      >
        <Typography.Text type="secondary">
          以下为账号实付价。已按稳定、价格、速度、质量 4 维度评分并自动过滤低分渠道；实际结算以本次参数与供应商回执为准。
        </Typography.Text>
        {shielded.length > 0 && active.length > 0 && (
          <Button
            size="small"
            type="link"
            onClick={() => setShowShielded((v) => !v)}
          >
            {showShielded
              ? `隐藏已屏蔽渠道 (${shielded.length})`
              : `查看已屏蔽渠道 (${shielded.length})`}
          </Button>
        )}
      </Space>
      <Table<EvaluatedChannel>
        size="small"
        pagination={false}
        rowKey={(c, i) => `${c.channelKey}-${i}`}
        dataSource={visible}
        scroll={{ x: 760 }}
        columns={[
          {
            title: "渠道",
            render: (_, c) => (
              <Space direction="vertical" size={2}>
                <span>
                  {c.vendor} · {c.laneNo ?? "—"}
                </span>
                <Space size={4} wrap>
                  {c.recommended && <Tag color="green">推荐首选</Tag>}
                  {c.overrideAction === "pin" && <Tag color="blue">已置顶</Tag>}
                  {c.shielded && (
                    <Tooltip title={c.shieldReasons.join("；")}>
                      <Tag color="red">已屏蔽</Tag>
                    </Tooltip>
                  )}
                </Space>
              </Space>
            ),
          },
          {
            title: "四维智选评分",
            width: 210,
            render: (_, c) => (
              <Space direction="vertical" size={2}>
                <span>
                  综合 <strong>{c.scores.overall}</strong> 分
                </span>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  稳 {c.scores.stability} · 价 {c.scores.price} · 速{" "}
                  {c.scores.speed} · 质 {c.scores.quality}
                </Typography.Text>
                {c.shielded && c.shieldReasons.length > 0 && (
                  <Typography.Text type="danger" style={{ fontSize: 11 }}>
                    {c.shieldReasons[0]}
                  </Typography.Text>
                )}
              </Space>
            ),
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
          ...(onOverrideChannel
            ? [
                {
                  title: "干预",
                  width: 110,
                  render: (_: unknown, c: EvaluatedChannel) => (
                    <Space direction="vertical" size={2}>
                      {c.overrideAction ? (
                        <Button
                          size="small"
                          type="link"
                          onClick={() => onOverrideChannel(c.channelKey, null)}
                        >
                          恢复默认
                        </Button>
                      ) : c.shielded ? (
                        <Button
                          size="small"
                          type="link"
                          onClick={() =>
                            onOverrideChannel(c.channelKey, "unshield")
                          }
                        >
                          解除屏蔽
                        </Button>
                      ) : (
                        <Space size={4}>
                          <Button
                            size="small"
                            type="link"
                            onClick={() => onOverrideChannel(c.channelKey, "pin")}
                          >
                            置顶
                          </Button>
                          <Button
                            size="small"
                            type="link"
                            danger
                            onClick={() =>
                              onOverrideChannel(c.channelKey, "block")
                            }
                          >
                            屏蔽
                          </Button>
                        </Space>
                      )}
                    </Space>
                  ),
                },
              ]
            : []),
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
