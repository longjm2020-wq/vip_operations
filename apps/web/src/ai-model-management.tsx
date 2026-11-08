import { BailianChatSettings } from "./bailian-chat-settings";
import { useState, type ReactNode } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  Modal,
  Select,
  Table,
  Tag,
  Tooltip,
} from "antd";
import {
  ArrowRightOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type {
  AiManagement,
  AiManagementRow,
} from "../../../packages/contracts/src/ai-management";
import type { AssistantVoiceStatus } from "../../../packages/contracts/src/assistant-voice";
import type { RealtimeStatus } from "../../../packages/contracts/src/assistant-realtime";
import { api } from "./api";
import { Header, QueryState, useUser } from "./shared";
import { ServiceSettings } from "./aigc/settings";
import { RealtimeVoiceSettings } from "./realtime-voice-settings";
import { VoiceSettings } from "./assistant-realtime-panel";
import "./ai-model-management.css";

const count = (n: number | null) =>
  n === null ? "未知" : n.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
const money = (n: number) =>
  n.toLocaleString("zh-CN", { maximumSignificantDigits: 10 });
const time = (date: string | null) =>
  date ? new Date(date).toLocaleString("zh-CN", { hour12: false }) : "暂无记录";
const color = {
  ready: "green",
  configured: "gold",
  unconfigured: "default",
  disabled: "default",
  unavailable: "red",
  local: "blue",
};

function VoiceConnections({
  kind,
  saved,
}: {
  kind: string;
  saved: () => void;
}) {
  const user = useUser();
  const realtime = useQuery({
    queryKey: ["assistant-realtime", user.id],
    enabled: true,
    queryFn: async () =>
      (await api("/my-workspace/assistant/realtime")).data as RealtimeStatus,
  });
  const audio = useQuery({
    queryKey: ["assistant-voice", user.id],
    enabled: kind === "voice_audio" || kind === "browser_dictation",
    queryFn: async () =>
      (await api("/my-workspace/assistant/voice")).data as AssistantVoiceStatus,
  });
  return kind === "voice_realtime" ? (
    <RealtimeVoiceSettings query={realtime} />
  ) : (
    <>
      <QueryState error={audio.error} reload={() => audio.refetch()} />
      {audio.data && (
        <VoiceSettings
          realtime={realtime.data}
          key={audio.data.version}
          value={audio.data}
          saved={async () => {
            await audio.refetch();
            saved();
          }}
        />
      )}
    </>
  );
}

export function AiModelManagementPage({
  connections,
}: {
  connections: ReactNode;
}) {
  const user = useUser();
  const client = useQueryClient();
  const { message } = App.useApp();
  const [days, setDays] = useState(30),
    [search, setSearch] = useState(""),
    [group, setGroup] = useState("全部功能");
  const [busy, setBusy] = useState<string>(),
    [connectionsOpen, setConnectionsOpen] = useState(false),
    [drawer, setDrawer] = useState<string>(),
    [detail, setDetail] = useState<AiManagementRow>();
  const q = useQuery({
    queryKey: ["ai-model-management", days],
    queryFn: async () =>
      (await api(`/ai-model-management?days=${days}`)).data as AiManagement,
  });
  const refresh = () =>
    client.invalidateQueries({ queryKey: ["ai-model-management"] });
  const data = q.data;
  const all = data?.features || [];
  const items = all.filter(
    (row) =>
      (group === "全部功能" || row.group === group) &&
      `${row.name} ${row.model} ${row.source}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const change = async (row: AiManagementRow, model: string) => {
    if (model === row.selection) return;
    setBusy(row.id);
    try {
      await api("/ai-model-management", "POST", {
        feature: row.id,
        model,
        revision: row.revision,
      });
      await Promise.all([
        refresh(),
        client.invalidateQueries({ queryKey: ["assistant-capabilities"] }),
        client.invalidateQueries({ queryKey: ["compass-ai-settings"] }),
      ]);
      message.success(
        `${row.name}的默认模型已更新${row.group === "AIGC" ? "，约 10 秒内生效" : ""}`,
      );
    } catch (e) {
      message.error((e as Error).message);
      await refresh();
    } finally {
      setBusy(undefined);
    }
  };
  const configure = (row: AiManagementRow) =>
    setDrawer(row.mode === "voice" ? row.id : "aigc");
  const canAigc =
    user.permissions.includes("aigc.manage") &&
    user.permissions.includes("aigc.use");
  return (
    <div className="ai-management">
      <Header
        title="AI 模型管理"
        subtitle="按功能管理模型、连接和实际消耗"
        extra={
          <>
            <Button
              icon={<SettingOutlined />}
              aria-label="OpenRouter 连接配置"
              onClick={() => setConnectionsOpen(true)}
            >
              连接配置
            </Button>
            <Button onClick={() => setDrawer("bailian-chat")}>
              百炼聊天连接
            </Button>
            <Button
              icon={<ReloadOutlined />}
              aria-label="刷新模型管理"
              loading={q.isFetching}
              onClick={() => q.refetch()}
            >
              刷新
            </Button>
          </>
        }
      />
      <QueryState error={q.error} reload={() => q.refetch()} />
      <div className="ai-management-overview">
        <div>
          <strong>{all.length}</strong>
          <span>已登记功能</span>
        </div>
        <div>
          <strong>{all.filter((r) => r.status === "ready").length}</strong>
          <span>已验证或调用成功</span>
        </div>
        <div>
          <strong>
            {
              all.filter((r) =>
                ["unconfigured", "disabled", "unavailable"].includes(r.status),
              ).length
            }
          </strong>
          <span>待配置或已关闭</span>
        </div>
        <p>
          每个 AI
          功能都在此登记。切换默认模型后，新请求使用新配置；对话或项目的单独选择优先。
        </p>
      </div>
      <Card className="ai-management-card">
        <div className="ai-management-toolbar">
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索功能、模型或 API 来源"
            aria-label="搜索 AI 功能"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            aria-label="功能分类"
            value={group}
            onChange={setGroup}
            options={["全部功能", ...new Set(all.map((row) => row.group))].map(
              (value) => ({ value, label: value }),
            )}
          />
          <Select
            aria-label="用量统计周期"
            value={days}
            onChange={setDays}
            options={[
              { value: 1, label: "近 24 小时" },
              { value: 7, label: "近 7 天" },
              { value: 30, label: "近 30 天" },
              { value: 90, label: "近 90 天" },
              { value: 0, label: "全部已记录" },
            ]}
          />
        </div>
        <Table<AiManagementRow>
          rowKey="id"
          loading={q.isLoading}
          dataSource={items}
          pagination={false}
          scroll={{ x: 1360 }}
          size="middle"
          locale={{ emptyText: <Empty description="没有匹配的 AI 功能" /> }}
          columns={[
            {
              title: "功能",
              dataIndex: "name",
              width: 170,
              fixed: "left",
              render: (_, row) => (
                <div className="ai-management-feature">
                  <strong>{row.name}</strong>
                  <span>{row.group}</span>
                </div>
              ),
            },
            {
              title: "功能入口",
              width: 95,
              render: (_, row) => (
                <Link to={row.href} aria-label={`打开${row.name}`}>
                  直达 <ArrowRightOutlined />
                </Link>
              ),
            },
            {
              title: "正在使用的模型",
              width: 270,
              render: (_, row) => (
                <div className="ai-management-model">
                  <Tooltip title={row.model}>
                    <code>{row.model}</code>
                  </Tooltip>
                  {row.mode === "select" ? (
                    <Select
                      aria-label={`${row.name}的默认模型`}
                      value={row.selection}
                      loading={busy === row.id}
                      disabled={!!busy || (row.group === "AIGC" && !canAigc)}
                      showSearch
                      optionFilterProp="label"
                      onChange={(model) => void change(row, model)}
                      options={[
                        ...(!row.choices.some(
                          (choice) => choice.value === row.selection,
                        )
                          ? [
                              {
                                value: row.selection,
                                label: `${row.model}（当前配置）`,
                                disabled: true,
                              },
                            ]
                          : []),
                        ...row.choices.map((choice) => ({
                          value: choice.value,
                          label:
                            choice.label +
                            (choice.available ? "" : " · 未配置密钥"),
                          disabled: !choice.available,
                        })),
                      ]}
                    />
                  ) : row.mode !== "fixed" ? (
                    <Button
                      size="small"
                      onClick={() => configure(row)}
                      disabled={row.mode === "aigc" && !canAigc}
                    >
                      切换 / 配置
                    </Button>
                  ) : (
                    <span className="secondary">由本地或浏览器提供</span>
                  )}
                </div>
              ),
            },
            {
              title: "模型能力边界",
              width: 245,
              render: (_, row) => (
                <div className="ai-management-boundary">{row.boundary}</div>
              ),
            },
            {
              title: "API 来源",
              width: 205,
              render: (_, row) => (
                <div className="ai-management-source">
                  {row.source}
                  {row.id === "assistant_chat" && (
                    <Button
                      size="small"
                      type="link"
                      onClick={() => setDrawer("bailian-chat")}
                    >
                      百炼聊天连接
                    </Button>
                  )}
                  {row.group === "AIGC" && canAigc && (
                    <Button
                      size="small"
                      type="link"
                      onClick={() => setDrawer("aigc")}
                    >
                      连接配置
                    </Button>
                  )}
                </div>
              ),
            },
            {
              title: "接通状态",
              width: 165,
              render: (_, row) => (
                <>
                  <Tag color={color[row.status]}>{row.statusText}</Tag>
                  {row.usage.lastSuccessAt && (
                    <span className="ai-management-small">
                      {time(row.usage.lastSuccessAt)}
                    </span>
                  )}
                </>
              ),
            },
            {
              title: "Token / 积分 / 金额",
              width: 210,
              render: (_, row) => (
                <div className="ai-management-usage">
                  {row.id === "product_ocr" ? (
                    <span>本站模型 API 费用：0</span>
                  ) : row.mode === "fixed" ? (
                    <span>未知 · 浏览器未提供账单</span>
                  ) : (
                    <>
                      <span>
                        Token：<strong>{count(row.usage.totalTokens)}</strong>
                      </span>
                      {(row.usage.inputVideoSeconds != null ||
                        row.usage.outputVideoSeconds != null) && (
                        <span>
                          视频秒数：输入{" "}
                          {count(row.usage.inputVideoSeconds ?? null)} / 输出{" "}
                          {count(row.usage.outputVideoSeconds ?? null)}
                        </span>
                      )}
                      {row.usage.billableImages != null && (
                        <span>
                          计费参考图：{count(row.usage.billableImages)} 张
                        </span>
                      )}
                      {row.usage.inputCharacters != null && (
                        <span>
                          合成输入字符：{count(row.usage.inputCharacters)}
                        </span>
                      )}
                      <span>
                        {row.usage.amounts.length
                          ? row.usage.amounts
                              .map((a) => `${money(a.amount)} ${a.unit}`)
                              .join("；")
                          : "积分 / 金额：未知"}
                      </span>
                      <span className="secondary">
                        {row.usage.requests
                          ? `${count(row.usage.requests)} 次请求 · ${count(row.usage.unknown)} 次无用量回执`
                          : "暂无调用记录"}
                      </span>
                    </>
                  )}
                  <Button
                    type="link"
                    size="small"
                    onClick={() => setDetail(row)}
                  >
                    查看明细说明
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Card>
      <p className="ai-management-note">
        {data?.catalogNotice || "读取真实模型配置与已记录用量…"}
      </p>
      {data?.recordingSince && (
        <p className="ai-management-note">
          统一计量自 {time(data.recordingSince)}{" "}
          开始；仅补录已有供应商回执的经营分析历史。不同币种、供应商积分分别统计，不折算为估算账单。
        </p>
      )}
      <Modal
        title="OpenRouter 连接"
        open={connectionsOpen}
        width={460}
        centered
        footer={null}
        destroyOnHidden
        onCancel={() => {
          setConnectionsOpen(false);
          void refresh();
        }}
      >
        {connections}
      </Modal>
      <Drawer
        title={
          drawer === "aigc"
            ? "AIGC 模型与工作流连接"
            : drawer === "bailian-chat"
              ? "百炼聊天连接"
              : "语音模型配置"
        }
        open={!!drawer}
        width={680}
        destroyOnHidden
        onClose={() => {
          setDrawer(undefined);
          void refresh();
        }}
      >
        {drawer === "bailian-chat" ? (
          <BailianChatSettings
            saved={() => {
              void refresh();
              void client.invalidateQueries({
                queryKey: ["assistant-capabilities"],
              });
            }}
          />
        ) : drawer === "aigc" ? (
          canAigc ? (
            <ServiceSettings
              onSaved={() => {
                void refresh();
              }}
            />
          ) : (
            <Alert type="warning" title="需要 AIGC 使用与管理权限" />
          )
        ) : drawer ? (
          <VoiceConnections
            kind={drawer}
            saved={() => {
              void refresh();
            }}
          />
        ) : null}
      </Drawer>
      <Drawer
        title={detail?.name}
        open={!!detail}
        width={540}
        destroyOnHidden
        onClose={() => setDetail(undefined)}
      >
        {detail && (
          <div className="ai-management-detail">
            <p>{detail.usageNote}</p>
            <dl>
              <dt>统计范围</dt>
              <dd>{days ? `近 ${days} 天` : "全部已记录"}</dd>
              <dt>输入 / 输出 / 总 Token</dt>
              <dd>
                {count(detail.usage.inputTokens)} /{" "}
                {count(detail.usage.outputTokens)} /{" "}
                {count(detail.usage.totalTokens)}
              </dd>
              <dt>已返回的消耗</dt>
              {(detail.usage.inputVideoSeconds != null ||
                detail.usage.outputVideoSeconds != null) && (
                <dd>
                  供应商视频用量：输入{" "}
                  {count(detail.usage.inputVideoSeconds ?? null)} 秒 / 输出{" "}
                  {count(detail.usage.outputVideoSeconds ?? null)}{" "}
                  秒；计费参考图 {count(detail.usage.billableImages ?? null)} 张
                </dd>
              )}
              {detail.usage.inputCharacters != null && (
                <dd>语音合成输入字符：{count(detail.usage.inputCharacters)}</dd>
              )}
              <dd>
                {detail.usage.amounts.length
                  ? detail.usage.amounts.map((a) => (
                      <div key={a.unit}>
                        {money(a.amount)} {a.unit}
                      </div>
                    ))
                  : "未知：供应商未返回或尚无记录"}
              </dd>
              <dt>请求数 / 已确认型号成功 / 失败</dt>
              <dd>
                {count(detail.usage.requests)} / {count(detail.usage.succeeded)}{" "}
                / {count(detail.usage.failed)}
              </dd>
              <dt>统计范围内首条记录</dt>
              <dd>{time(detail.usage.firstRecordedAt)}</dd>
              <dt>最近实际请求型号</dt>
              <dd>{detail.usage.lastModel || "暂无记录"}</dd>
              <dt>最近失败代码</dt>
              <dd>{detail.usage.lastError || "暂无"}</dd>
            </dl>
            <Alert
              type="info"
              title="未知不等于免费"
              description="未返回用量、浏览器直连音频和历史缺失数据不会被填成零。已显示数字也可能只覆盖部分请求；供应商最终账单为准。"
            />
          </div>
        )}
      </Drawer>
    </div>
  );
}
