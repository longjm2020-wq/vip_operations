import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Empty,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  smartCategoryLabels,
  smartModelCategories,
  smartPresetLabels,
  smartPresetWeights,
  smartRoleMeta,
  type EvaluatedChannel,
  type EvaluatedSmartModel,
  type RelayStationProtocol,
  type RelayStationView,
  type RoleAllocation,
  type SmartChannelOverride,
  type SmartModelCategory,
  type SmartModelsOverview,
  type SmartModelsSettingsState,
  type SmartStrategyPreset,
} from "../../../packages/contracts/src/smart-models";
import { api } from "./api";
import { QueryState } from "./shared";

const tierLabel: Record<EvaluatedSmartModel["tier"], string> = {
  flagship: "旗舰强能力",
  standard: "均衡标准",
  fast: "极速低成本",
};

const tierColor: Record<EvaluatedSmartModel["tier"], string> = {
  flagship: "purple",
  standard: "blue",
  fast: "cyan",
};

const roleSelectablePresets: Exclude<SmartStrategyPreset, "custom">[] = [
  "balanced",
  "quality_first",
  "speed_cost",
  "cost_first",
  "stability_first",
];

function ScoreBadges({ scores }: { scores: EvaluatedSmartModel["scores"] }) {
  return (
    <Space direction="vertical" size={2}>
      <span>
        综合 <strong>{scores.overall}</strong> 分
      </span>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        稳 {scores.stability} · 价 {scores.price} · 速 {scores.speed} · 质{" "}
        {scores.quality}
      </Typography.Text>
    </Space>
  );
}

export function SmartModelPanel({ onApplied }: { onApplied?: () => void }) {
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ["smart-models"],
    queryFn: async () =>
      (await api("/ai-model-management/smart")).data as SmartModelsOverview,
  });
  return (
    <>
      <QueryState error={q.error} reload={() => q.refetch()} />
      {q.data && (
        <SmartModelBody
          data={q.data}
          reload={async () => {
            await Promise.all([
              q.refetch(),
              client.invalidateQueries({ queryKey: ["ai-model-management"] }),
              client.invalidateQueries({ queryKey: ["agentai-settings"] }),
              client.invalidateQueries({ queryKey: ["assistant-capabilities"] }),
              client.invalidateQueries({ queryKey: ["employee-catalog"] }),
            ]);
            onApplied?.();
          }}
        />
      )}
    </>
  );
}

function SmartModelBody({
  data,
  reload,
}: {
  data: SmartModelsOverview;
  reload: () => Promise<void>;
}) {
  const { message, modal } = App.useApp();
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState<SmartModelsSettingsState>(data.settings);
  const [policyDirty, setPolicyDirty] = useState(false);

  // New relay station form
  const [stationName, setStationName] = useState("");
  const [stationUrl, setStationUrl] = useState("");
  const [stationKey, setStationKey] = useState("");
  const [stationProtocol, setStationProtocol] =
    useState<RelayStationProtocol>("auto");

  // Filter state for model/channel list
  const [categoryTab, setCategoryTab] = useState<"all" | SmartModelCategory>(
    "all",
  );
  const [search, setSearch] = useState("");
  const [showShielded, setShowShielded] = useState(false);

  useEffect(() => {
    setDraft(data.settings);
    setPolicyDirty(false);
  }, [data.settings]);

  const runAction = async (
    tag: string,
    op: () => Promise<unknown>,
    okMsg: string,
  ) => {
    setBusy(tag);
    try {
      await op();
      await reload();
      if (okMsg) message.success(okMsg);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const connectRelayStation = () => {
    if (!stationUrl.trim() || !stationKey.trim()) {
      message.warning("请填写中转站链接与 API Key");
      return;
    }
    void runAction(
      "add-station",
      async () => {
        const created = (
          await api("/ai-model-management/smart/stations", "POST", {
            name: stationName.trim() || undefined,
            baseUrl: stationUrl.trim(),
            protocol: stationProtocol,
            enabled: true,
            apiKey: stationKey.trim(),
          })
        ).data as RelayStationView;
        await api(
          `/ai-model-management/smart/stations/${created.id}/sync`,
          "POST",
          {},
          undefined,
          { readTimeoutMs: 60000 },
        );
        setStationName("");
        setStationUrl("");
        setStationKey("");
      },
      "中转站已接入并自动完成分类优选解析",
    );
  };

  const savePolicy = (nextState: SmartModelsSettingsState = draft) => {
    const sum =
      nextState.weights.stability +
      nextState.weights.price +
      nextState.weights.speed +
      nextState.weights.quality;
    if (nextState.preset === "custom" && Math.abs(sum - 100) > 0.01) {
      message.warning(`自定义四个维度权重之和需为 100%（当前为 ${sum}%）`);
      return;
    }
    void runAction(
      "save-policy",
      () =>
        api("/ai-model-management/smart/policy", "POST", {
          version: data.settings.version,
          enabled: nextState.enabled,
          preset: nextState.preset,
          weights: nextState.weights,
          filterPolicy: nextState.filterPolicy,
          rolePolicies: nextState.rolePolicies,
          channelOverrides: nextState.channelOverrides,
        }),
      "智选策略与过滤规则已保存",
    );
  };

  const overrideChannel = (
    channelKey: string,
    action: SmartChannelOverride["action"] | null,
  ) => {
    const next: SmartModelsSettingsState = {
      ...data.settings,
      channelOverrides: [
        ...data.settings.channelOverrides.filter(
          (o) => o.channelKey !== channelKey,
        ),
        ...(action ? [{ channelKey, action }] : []),
      ],
    };
    savePolicy(next);
  };

  const applyAllocations = () =>
    void runAction(
      "apply",
      async () => {
        const res = (
          await api("/ai-model-management/smart/apply", "POST", {})
        ).data as {
          applied: { feature: string; label: string }[];
          skipped: { feature: string; reason: string }[];
        };
        if (res.skipped.length && !res.applied.length) {
          message.warning(
            `暂无可直接应用的功能（${res.skipped[0]?.reason || "请先验证对应模型"}）`,
          );
          return;
        }
        message.info(
          `已应用 ${res.applied.length} 项默认配置${res.skipped.length ? `，另有 ${res.skipped.length} 项需先验证或配置密钥` : ""}`,
        );
      },
      "",
    );

  const visibleModels = data.models.filter((m) => {
    if (categoryTab !== "all" && m.category !== categoryTab) return false;
    if (!showShielded && data.settings.filterPolicy.hideShielded && m.shielded)
      return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return `${m.modelName} ${m.modelId} ${m.stationName} ${m.recommendReason}`
      .toLowerCase()
      .includes(q);
  });

  const weightSum =
    draft.weights.stability +
    draft.weights.price +
    draft.weights.speed +
    draft.weights.quality;

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      {!data.encryptionReady && (
        <Alert
          type="error"
          showIcon
          message="服务器加密密钥未就绪"
          description="请管理员先配置 COMPASS_MAIL_KEY，才能加密保存中转站 API Key。"
        />
      )}

      <Alert
        type="info"
        showIcon
        icon={<ThunderboltOutlined />}
        message={`智选模型 · 已优选 ${data.summary.activeChannels} 个高价值渠道，自动屏蔽 ${data.summary.shieldedChannels} 个低分渠道`}
        description="按稳定、价格、速度、质量 4 个维度综合评分；综合评估不达标或连续失败渠道会自动屏蔽，工作台 AI 员工（编排、执行、修图、视频）在自动模式下实时按角色匹配最佳模型。"
      />

      {/* 1. Relay station quick connector */}
      <Card size="small" title="接入算力中转站（输入链接自动分类与优选）">
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          <Space wrap style={{ width: "100%" }}>
            <Input
              aria-label="中转站名称"
              placeholder="中转站名称（可选，默认取域名）"
              value={stationName}
              onChange={(e) => setStationName(e.target.value)}
              style={{ width: 200 }}
              disabled={!!busy}
            />
            <Input
              aria-label="中转站链接"
              placeholder="HTTPS 中转站链接，如 https://relay.example.com/v1"
              value={stationUrl}
              onChange={(e) => setStationUrl(e.target.value)}
              style={{ width: 320 }}
              disabled={!!busy}
            />
            <Input.Password
              aria-label="中转站 API Key"
              autoComplete="new-password"
              placeholder="粘贴中转站 API Key"
              value={stationKey}
              onChange={(e) => setStationKey(e.target.value)}
              style={{ width: 220 }}
              disabled={!!busy}
            />
            <Select
              aria-label="中转站协议"
              value={stationProtocol}
              onChange={setStationProtocol}
              style={{ width: 170 }}
              disabled={!!busy}
              options={[
                { value: "auto", label: "自动识别协议" },
                { value: "agentai", label: "AgentAI 计费协议" },
                { value: "openai", label: "OpenAI 兼容协议" },
              ]}
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              loading={busy === "add-station"}
              disabled={!!busy || !data.encryptionReady}
              onClick={connectRelayStation}
            >
              接入并智能解析
            </Button>
          </Space>

          {data.stations.length > 0 && (
            <Table<RelayStationView>
              size="small"
              pagination={false}
              rowKey="id"
              dataSource={data.stations}
              columns={[
                {
                  title: "中转站",
                  render: (_, st) => (
                    <Space direction="vertical" size={0}>
                      <strong>{st.name}</strong>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {st.baseUrl}
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: "协议与状态",
                  render: (_, st) => (
                    <Space size={4} wrap>
                      <Tag>
                        {st.protocol === "agentai"
                          ? "AgentAI 计费"
                          : st.protocol === "openai"
                            ? "OpenAI 兼容"
                            : "待识别"}
                      </Tag>
                      {st.enabled ? (
                        st.catalogAt ? (
                          <Tag color="green">已解析 {st.modelCount} 模型</Tag>
                        ) : (
                          <Tag color="gold">待同步目录</Tag>
                        )
                      ) : (
                        <Tag>已停用</Tag>
                      )}
                      {st.errorNote && (
                        <Tooltip title={st.errorNote}>
                          <Tag color="red">异常</Tag>
                        </Tooltip>
                      )}
                    </Space>
                  ),
                },
                {
                  title: "自动分类统计",
                  render: (_, st) => (
                    <Space size={4} wrap>
                      {smartModelCategories.map((cat) =>
                        st.categoryCounts[cat] > 0 ? (
                          <Tag key={cat}>
                            {smartCategoryLabels[cat]} {st.categoryCounts[cat]}
                          </Tag>
                        ) : null,
                      )}
                    </Space>
                  ),
                },
                {
                  title: "操作",
                  width: 220,
                  render: (_, st) => (
                    <Space size={4}>
                      <Button
                        size="small"
                        icon={<ReloadOutlined />}
                        loading={busy === `sync-${st.id}`}
                        disabled={!!busy}
                        onClick={() =>
                          void runAction(
                            `sync-${st.id}`,
                            () =>
                              api(
                                `/ai-model-management/smart/stations/${st.id}/sync`,
                                "POST",
                                {},
                                undefined,
                                { readTimeoutMs: 60000 },
                              ),
                            `${st.name} 目录与分类已同步`,
                          )
                        }
                      >
                        同步
                      </Button>
                      <Switch
                        size="small"
                        aria-label={`启用中转站 ${st.name}`}
                        checked={st.enabled}
                        disabled={!!busy}
                        onChange={(enabled) =>
                          void runAction(
                            `toggle-${st.id}`,
                            () =>
                              api("/ai-model-management/smart/stations", "POST", {
                                id: st.id,
                                version: st.version,
                                name: st.name,
                                baseUrl: st.baseUrl,
                                protocol: st.protocol,
                                enabled,
                              }),
                            enabled ? "中转站已启用" : "中转站已停用",
                          )
                        }
                      />
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        disabled={!!busy}
                        onClick={() =>
                          modal.confirm({
                            title: `删除中转站「${st.name}」？`,
                            content: "删除后将清除该站加密密钥并停用其模型路由。",
                            onOk: () =>
                              runAction(
                                `del-${st.id}`,
                                () =>
                                  api(
                                    `/ai-model-management/smart/stations/${st.id}/delete`,
                                    "POST",
                                    {},
                                  ),
                                "中转站已删除",
                              ),
                          })
                        }
                      />
                    </Space>
                  ),
                },
              ]}
            />
          )}
        </Space>
      </Card>

      {/* 2. Role-based smart allocations */}
      <Card
        size="small"
        title="按智能体用途自动分配最佳模型"
        extra={
          <Button
            type="primary"
            size="small"
            icon={<SafetyCertificateOutlined />}
            loading={busy === "apply"}
            disabled={!!busy}
            onClick={applyAllocations}
          >
            一键应用智选方案到全站功能
          </Button>
        }
      >
        <Table<RoleAllocation>
          size="small"
          pagination={false}
          rowKey="role"
          dataSource={data.roleAllocations}
          scroll={{ x: 780 }}
          columns={[
            {
              title: "智能体 / 用途",
              width: 220,
              render: (_, r) => (
                <Space direction="vertical" size={2}>
                  <strong>{r.label}</strong>
                  <Tag>{smartCategoryLabels[r.category]}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {r.description}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: "优选策略",
              width: 170,
              render: (_, r) => (
                <Select
                  size="small"
                  aria-label={`${r.label}策略`}
                  style={{ width: 155 }}
                  value={draft.rolePolicies[r.role] || smartRoleMeta[r.role].defaultPreset}
                  onChange={(val) => {
                    setDraft((prev) => ({
                      ...prev,
                      rolePolicies: { ...prev.rolePolicies, [r.role]: val },
                    }));
                    setPolicyDirty(true);
                  }}
                  options={roleSelectablePresets.map((p) => ({
                    value: p,
                    label: smartPresetLabels[p],
                  }))}
                />
              ),
            },
            {
              title: "首选推荐模型与渠道",
              render: (_, r) =>
                r.primary ? (
                  <Space direction="vertical" size={2}>
                    <Space size={4} wrap>
                      <strong>{r.primary.modelName}</strong>
                      <Tag color="green">{r.primary.stationName}</Tag>
                      <Tag color={tierColor[r.primary.tier]}>
                        {tierLabel[r.primary.tier]}
                      </Tag>
                    </Space>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {r.primary.recommendReason}
                      {r.backup ? ` · 备选：${r.backup.modelName}` : ""}
                    </Typography.Text>
                  </Space>
                ) : (
                  <Typography.Text type="secondary">{r.reason}</Typography.Text>
                ),
            },
            {
              title: "评分与屏蔽",
              width: 180,
              render: (_, r) =>
                r.primary ? (
                  <Space direction="vertical" size={2}>
                    <ScoreBadges scores={r.primary.scores} />
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      可选 {r.candidateCount} 个 · 已屏蔽 {r.shieldedCount} 个
                    </Typography.Text>
                  </Space>
                ) : (
                  <Tag color="orange">已屏蔽 {r.shieldedCount} 个</Tag>
                ),
            },
          ]}
        />
      </Card>

      {/* 3. Policy & threshold tuning */}
      <Collapse
        size="small"
        items={[
          {
            key: "policy",
            label: `价值最大化权重与自动屏蔽规则（当前：${smartPresetLabels[draft.preset]} · 最低成功率 ${draft.filterPolicy.minSuccessRate}% · 最低分 ${draft.filterPolicy.minScore}）`,
            children: (
              <Space direction="vertical" size="small" style={{ width: "100%" }}>
                <Space wrap>
                  <span>
                    启用智选路由：
                    <Switch
                      size="small"
                      checked={draft.enabled}
                      onChange={(enabled) => {
                        setDraft((d) => ({ ...d, enabled }));
                        setPolicyDirty(true);
                      }}
                    />
                  </span>
                  <span>
                    全局预设：
                    <Select
                      size="small"
                      style={{ width: 185 }}
                      value={draft.preset}
                      onChange={(preset: SmartStrategyPreset) => {
                        setDraft((d) => ({
                          ...d,
                          preset,
                          weights:
                            preset === "custom"
                              ? d.weights
                              : smartPresetWeights[preset],
                        }));
                        setPolicyDirty(true);
                      }}
                      options={(
                        Object.keys(smartPresetLabels) as SmartStrategyPreset[]
                      ).map((k) => ({
                        value: k,
                        label: smartPresetLabels[k],
                      }))}
                    />
                  </span>
                  <span>
                    隐藏已屏蔽渠道：
                    <Switch
                      size="small"
                      checked={draft.filterPolicy.hideShielded}
                      onChange={(hideShielded) => {
                        setDraft((d) => ({
                          ...d,
                          filterPolicy: { ...d.filterPolicy, hideShielded },
                        }));
                        setPolicyDirty(true);
                      }}
                    />
                  </span>
                  <span>
                    仅保留实测渠道：
                    <Switch
                      size="small"
                      checked={draft.filterPolicy.requireLiveStats}
                      onChange={(requireLiveStats) => {
                        setDraft((d) => ({
                          ...d,
                          filterPolicy: { ...d.filterPolicy, requireLiveStats },
                        }));
                        setPolicyDirty(true);
                      }}
                    />
                  </span>
                </Space>

                <Space wrap>
                  {(
                    [
                      ["stability", "稳定权重%"],
                      ["price", "价格权重%"],
                      ["speed", "速度权重%"],
                      ["quality", "质量权重%"],
                    ] as const
                  ).map(([field, label]) => (
                    <span key={field}>
                      {label}：
                      <InputNumber
                        size="small"
                        min={0}
                        max={100}
                        style={{ width: 72 }}
                        value={draft.weights[field]}
                        onChange={(v) => {
                          if (v === null) return;
                          setDraft((d) => ({
                            ...d,
                            preset: "custom",
                            weights: { ...d.weights, [field]: Number(v) },
                          }));
                          setPolicyDirty(true);
                        }}
                      />
                    </span>
                  ))}
                  {draft.preset === "custom" && (
                    <Typography.Text
                      type={Math.abs(weightSum - 100) <= 0.01 ? "secondary" : "danger"}
                    >
                      合计 {weightSum}%
                    </Typography.Text>
                  )}
                </Space>

                <Space wrap>
                  <span>
                    最低 24h 成功率(%)：
                    <InputNumber
                      size="small"
                      min={0}
                      max={100}
                      style={{ width: 72 }}
                      value={draft.filterPolicy.minSuccessRate}
                      onChange={(v) => {
                        if (v === null) return;
                        setDraft((d) => ({
                          ...d,
                          filterPolicy: {
                            ...d.filterPolicy,
                            minSuccessRate: Number(v),
                          },
                        }));
                        setPolicyDirty(true);
                      }}
                    />
                  </span>
                  <span>
                    最低综合分：
                    <InputNumber
                      size="small"
                      min={0}
                      max={95}
                      style={{ width: 72 }}
                      value={draft.filterPolicy.minScore}
                      onChange={(v) => {
                        if (v === null) return;
                        setDraft((d) => ({
                          ...d,
                          filterPolicy: {
                            ...d.filterPolicy,
                            minScore: Number(v),
                          },
                        }));
                        setPolicyDirty(true);
                      }}
                    />
                  </span>
                  <span>
                    同模型最大溢价倍数：
                    <InputNumber
                      size="small"
                      min={1.1}
                      max={20}
                      step={0.1}
                      style={{ width: 76 }}
                      value={draft.filterPolicy.maxPriceMultiplier}
                      onChange={(v) => {
                        if (v === null) return;
                        setDraft((d) => ({
                          ...d,
                          filterPolicy: {
                            ...d.filterPolicy,
                            maxPriceMultiplier: Number(v),
                          },
                        }));
                        setPolicyDirty(true);
                      }}
                    />
                  </span>
                  <Button
                    type="primary"
                    size="small"
                    loading={busy === "save-policy"}
                    disabled={!policyDirty && !busy}
                    onClick={() => savePolicy()}
                  >
                    保存智选策略
                  </Button>
                </Space>
              </Space>
            ),
          },
        ]}
      />

      {/* 4. Categorized smart model & channel browser */}
      <Card size="small" title="分类模型渠道优选榜单">
        <Space
          style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }}
          wrap
        >
          <Tabs
            size="small"
            activeKey={categoryTab}
            onChange={(key) => setCategoryTab(key as "all" | SmartModelCategory)}
            items={[
              {
                key: "all",
                label: `全部 (${data.summary.recommendedModels})`,
              },
              ...smartModelCategories.map((cat) => ({
                key: cat,
                label: `${smartCategoryLabels[cat]} (${
                  data.models.filter((m) => m.category === cat && !m.shielded)
                    .length
                })`,
              })),
            ]}
          />
          <Space wrap>
            <Input
              allowClear
              placeholder="搜索模型、中转站或推荐理由"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 220 }}
            />
            <span>
              显示已屏蔽 ({data.summary.shieldedModels})：
              <Switch
                size="small"
                checked={showShielded}
                onChange={setShowShielded}
              />
            </span>
          </Space>
        </Space>

        <Table<EvaluatedSmartModel>
          size="small"
          rowKey="key"
          dataSource={visibleModels}
          pagination={{ pageSize: 8, showSizeChanger: false }}
          locale={{
            emptyText: (
              <Empty description="暂无匹配的可选模型（可接入中转站或调整屏蔽门槛）" />
            ),
          }}
          scroll={{ x: 860 }}
          expandable={{
            rowExpandable: (m) => m.channels.length > 0,
            expandedRowRender: (m) => (
              <Table<EvaluatedChannel>
                size="small"
                pagination={false}
                rowKey="channelKey"
                dataSource={m.channels}
                columns={[
                  {
                    title: "渠道",
                    render: (_, c) => (
                      <Space size={4} wrap>
                        <span>
                          {c.vendor} · {c.laneNo ?? "默认"}
                        </span>
                        {c.recommended && <Tag color="green">推荐</Tag>}
                        {c.overrideAction === "pin" && (
                          <Tag color="blue">置顶</Tag>
                        )}
                        {c.shielded && <Tag color="red">已屏蔽</Tag>}
                      </Space>
                    ),
                  },
                  {
                    title: "四维评分",
                    render: (_, c) => <ScoreBadges scores={c.scores} />,
                  },
                  {
                    title: "价格",
                    render: (_, c) => c.priceLabel,
                  },
                  {
                    title: "表现数据",
                    render: (_, c) =>
                      c.statsSource === "live"
                        ? `${c.successRate24h !== null ? `成功率 ${c.successRate24h}%` : "成功率暂无"} · ${c.avgResponseSeconds ? `${c.avgResponseSeconds}s` : "耗时暂无"}`
                        : c.localTelemetry?.requests
                          ? `本站 ${c.localTelemetry.requests} 次 · 成功率 ${c.localTelemetry.successRate ?? 0}%`
                          : c.statsSource === "estimate"
                            ? "估测数据，待实测"
                            : "待实测",
                  },
                  {
                    title: "说明与操作",
                    render: (_, c) => (
                      <Space size={4} wrap>
                        <Typography.Text
                          type={c.shielded ? "danger" : "secondary"}
                          style={{ fontSize: 11 }}
                        >
                          {c.shielded
                            ? c.shieldReasons.join("；")
                            : c.recommendReason}
                        </Typography.Text>
                        {c.overrideAction ? (
                          <Button
                            size="small"
                            type="link"
                            onClick={() => overrideChannel(c.channelKey, null)}
                          >
                            恢复默认
                          </Button>
                        ) : c.shielded ? (
                          <Button
                            size="small"
                            type="link"
                            onClick={() =>
                              overrideChannel(c.channelKey, "unshield")
                            }
                          >
                            解除屏蔽
                          </Button>
                        ) : (
                          <Space size={2}>
                            <Button
                              size="small"
                              type="link"
                              onClick={() =>
                                overrideChannel(c.channelKey, "pin")
                              }
                            >
                              置顶
                            </Button>
                            <Button
                              size="small"
                              type="link"
                              danger
                              onClick={() =>
                                overrideChannel(c.channelKey, "block")
                              }
                            >
                              屏蔽
                            </Button>
                          </Space>
                        )}
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          }}
          columns={[
            {
              title: "模型与来源",
              render: (_, m) => (
                <Space direction="vertical" size={2}>
                  <Space size={4} wrap>
                    <strong>{m.modelName}</strong>
                    <Tag>{smartCategoryLabels[m.category]}</Tag>
                    <Tag>{m.stationName}</Tag>
                    <Tag color={tierColor[m.tier]}>{tierLabel[m.tier]}</Tag>
                    {m.shielded && (
                      <Tag icon={<StopOutlined />} color="red">
                        已屏蔽
                      </Tag>
                    )}
                    {!m.shielded && m.verified && (
                      <Tag icon={<CheckCircleOutlined />} color="green">
                        已验证
                      </Tag>
                    )}
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {m.modelId}
                    {m.vision ? " · 识图" : ""}
                    {m.tools ? " · 工具" : ""}
                    {m.structured ? " · 结构化" : ""}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: "四维评分",
              width: 195,
              render: (_, m) => <ScoreBadges scores={m.scores} />,
            },
            {
              title: "优选渠道",
              width: 210,
              render: (_, m) => (
                <Space direction="vertical" size={2}>
                  <span>
                    可用 {m.activeChannels}/{m.totalChannels} 渠道
                  </span>
                  {m.bestChannel && (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {m.bestChannel.vendor} · {m.bestChannel.priceLabel}
                    </Typography.Text>
                  )}
                  <Typography.Text
                    type={m.shielded ? "danger" : "secondary"}
                    style={{ fontSize: 11 }}
                  >
                    {m.recommendReason}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: "验证",
              width: 110,
              render: (_, m) =>
                m.stationKind === "relay" && m.category === "chat" ? (
                  <Button
                    size="small"
                    loading={busy === `probe-${m.stationId}-${m.modelId}`}
                    disabled={!!busy}
                    onClick={() =>
                      void runAction(
                        `probe-${m.stationId}-${m.modelId}`,
                        () =>
                          api(
                            `/ai-model-management/smart/stations/${m.stationId}/probe`,
                            "POST",
                            { model: m.modelId },
                            undefined,
                            { readTimeoutMs: 50000 },
                          ),
                        `${m.modelName} 测速验证通过`,
                      )
                    }
                  >
                    {m.verified ? "重新测速" : "测速验证"}
                  </Button>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {m.verified ? "已验证" : "待验证"}
                  </Typography.Text>
                ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
