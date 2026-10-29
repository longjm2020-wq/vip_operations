import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { CloudSyncOutlined, LoginOutlined } from "@ant-design/icons";
import { api, queryClient } from "./api";
import { useUser, when, type Row } from "./shared";
import {
  jushuitanLoginActive,
  jushuitanScope,
} from "../../../packages/contracts/src/jushuitan-inventory";

const names: Record<string, string> = {
  QUEUED: "等待同步",
  RUNNING: "同步中",
  COMPLETE: "已完成",
  FAILED: "未完成",
};
const sessionNames: Record<string, string> = {
  DISCONNECTED: "未登录",
  READY: "会话已保存",
  LOGIN_REQUIRED: "需重新登录",
  ERROR: "需检查登录",
};
function JushuitanMatches({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState(""),
    [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["jushuitan-matches", code, page],
    queryFn: () =>
      api(
        `/inventory/jushuitan/matches?skuCode=${encodeURIComponent(code)}&page=${page}`,
      ),
  });
  return (
    <Modal
      open
      title="聚水潭库存合并明细"
      width={1050}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      <Space orientation="vertical" style={{ width: "100%" }} size={16}>
        <Alert
          type="info"
          title="按明确条码映射汇总，不按款号格式猜测"
          description="商品编码或其它属性5精确对应网站条码；颜色、尺码一致后汇总。每个聚水潭原始商品只计一次。以下数量为各原始商品的贡献值。"
        />
        <Input.Search
          aria-label="查询合并条码"
          placeholder="输入完整网站编码或聚水潭商品编码"
          allowClear
          onSearch={(value) => {
            setCode(value.trim());
            setPage(1);
          }}
        />
        {q.error && <Alert type="error" title={(q.error as Error).message} />}
        <Table
          size="small"
          rowKey="sourceSku"
          loading={q.isFetching}
          dataSource={q.data?.data ?? []}
          scroll={{ x: 900 }}
          pagination={{
            current: page,
            pageSize: 50,
            total: q.data?.total ?? 0,
            onChange: setPage,
            showSizeChanger: false,
          }}
          columns={[
            { title: "网站商品编码", dataIndex: "targetCode", width: 190 },
            { title: "聚水潭原始编码", dataIndex: "sourceSku", width: 220 },
            { title: "其它属性5", dataIndex: "mappedCode", width: 190 },
            { title: "颜色及尺码", dataIndex: "colorSize" },
            {
              title: "实际库存",
              render: (_: unknown, r: Row) => r.quantities.physicalQty,
            },
            {
              title: "可用数",
              render: (_: unknown, r: Row) => r.quantities.availableQty,
            },
          ]}
        />
      </Space>
    </Modal>
  );
}
function JushuitanLogin({
  id,
  onClose,
  onSaved,
}: {
  id: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { message } = App.useApp(),
    [busy, setBusy] = useState(false),
    [text, setText] = useState("");
  const down = useRef<{ x: number; y: number; frameId: string } | null>(null),
    saved = useRef(false);
  const q = useQuery({
    queryKey: ["jushuitan-login", id],
    queryFn: async () => (await api(`/inventory/jushuitan/login/${id}`)).data,
    refetchInterval: (query) =>
      jushuitanLoginActive.includes(query.state.data?.status ?? "QUEUED")
        ? 1500
        : false,
    staleTime: 0,
    gcTime: 0,
  });
  const l = q.data,
    ready = l?.status === "WAITING" && !!l?.frameId && !busy;
  useEffect(() => {
    if (l?.status === "SAVED" && !saved.current) {
      saved.current = true;
      onSaved();
    }
  }, [l?.status, onSaved]);
  const action = async (payload: Row) => {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/inventory/jushuitan/login/${id}/action`, "POST", payload);
      await q.refetch();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    if (jushuitanLoginActive.includes(l?.status ?? "QUEUED")) {
      try {
        await api(`/inventory/jushuitan/login/${id}/cancel`, "POST", {});
      } catch (e) {
        message.error((e as Error).message);
        return;
      }
    }
    setText("");
    queryClient.removeQueries({ queryKey: ["jushuitan-login", id] });
    onClose();
  };
  return (
    <Modal
      open
      title="登录聚水潭并保存会话"
      width={1160}
      onCancel={() => void close()}
      destroyOnHidden
      footer={
        <Space wrap>
          <Button onClick={() => void close()}>
            {l?.status === "SAVED" ? "完成" : "关闭登录窗口"}
          </Button>
          <Button
            type="primary"
            disabled={!ready}
            loading={l?.status === "CHECKING"}
            onClick={() => void action({ type: "CHECK" })}
          >
            核验杭州总仓并保存会话
          </Button>
        </Space>
      }
    >
      <Space orientation="vertical" size={12} style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          title="首次在下方云端浏览器登录，后续同步无需本机浏览器在线"
          description={`登录后打开「商品 → 商品库存」，核对${jushuitanScope.company}、${jushuitanScope.warehouse}。保存后的登录会话加密保留；平台要求验证或登录过期时需重新登录。`}
        />
        {q.error && <Alert type="error" title={(q.error as Error).message} />}
        {l?.note && (
          <Alert
            type={
              l.status === "SAVED"
                ? "success"
                : ["FAILED", "EXPIRED"].includes(l.status)
                  ? "error"
                  : "info"
            }
            title={l.note}
          />
        )}
        {l?.frame ? (
          <div
            style={{
              position: "relative",
              border: "1px solid var(--ant-color-border)",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <img
              src={l.frame}
              alt="聚水潭云端登录画面，点击操作，可拖动完成手动验证"
              draggable={false}
              style={{
                display: "block",
                width: "100%",
                touchAction: "none",
                cursor: ready ? "pointer" : "wait",
              }}
              onPointerDown={(e) => {
                if (!ready) return;
                const rect = e.currentTarget.getBoundingClientRect();
                down.current = {
                  x: (e.clientX - rect.left) / rect.width,
                  y: (e.clientY - rect.top) / rect.height,
                  frameId: l.frameId,
                };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerCancel={() => {
                down.current = null;
              }}
              onPointerUp={(e) => {
                const start = down.current;
                down.current = null;
                if (!start || !ready) return;
                const rect = e.currentTarget.getBoundingClientRect(),
                  end = {
                    x: Math.max(
                      0,
                      Math.min(1, (e.clientX - rect.left) / rect.width),
                    ),
                    y: Math.max(
                      0,
                      Math.min(1, (e.clientY - rect.top) / rect.height),
                    ),
                  };
                const { frameId, x, y } = start;
                void action(
                  Math.hypot(x - end.x, y - end.y) > 0.015
                    ? { type: "DRAG", frameId, from: { x, y }, to: end }
                    : { type: "CLICK", frameId, point: end },
                );
              }}
            />
          </div>
        ) : l?.status === "SAVED" ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="会话已保存，可以关闭窗口并立即同步"
          />
        ) : (
          <div style={{ padding: 30, textAlign: "center" }}>
            <Spin
              spinning={jushuitanLoginActive.includes(l?.status ?? "QUEUED")}
              tip="正在打开聚水潭"
            >
              <div style={{ height: 80 }} />
            </Spin>
          </div>
        )}
        {l?.status !== "SAVED" && (
          <>
            <Typography.Text type="secondary">
              先点击画面中的输入框，再在此输入并发送。画面会遮盖输入内容；密码和验证码仅临时加密传递，发送后清空。
            </Typography.Text>
            <Space.Compact style={{ width: "100%" }}>
              <Input.Password
                aria-label="向聚水潭输入账号、密码或验证码"
                autoComplete="off"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={!ready}
                maxLength={512}
                placeholder="输入当前选中字段的内容"
              />
              <Button
                disabled={!ready || !text}
                onClick={() => {
                  const value = text;
                  setText("");
                  void action({ type: "TEXT", frameId: l.frameId, value });
                }}
              >
                发送输入
              </Button>
            </Space.Compact>
            <Space wrap>
              <Button
                disabled={!ready}
                onClick={() =>
                  void action({ type: "KEY", frameId: l.frameId, key: "Tab" })
                }
              >
                下一输入框
              </Button>
              <Button
                disabled={!ready}
                onClick={() =>
                  void action({ type: "KEY", frameId: l.frameId, key: "Enter" })
                }
              >
                回车
              </Button>
              <Button
                disabled={!ready}
                onClick={() =>
                  void action({
                    type: "SCROLL",
                    frameId: l.frameId,
                    deltaY: -500,
                  })
                }
              >
                向上滚动
              </Button>
              <Button
                disabled={!ready}
                onClick={() =>
                  void action({
                    type: "SCROLL",
                    frameId: l.frameId,
                    deltaY: 500,
                  })
                }
              >
                向下滚动
              </Button>
              <Button
                disabled={!ready}
                onClick={() => void action({ type: "REFRESH" })}
              >
                刷新画面页面
              </Button>
            </Space>
          </>
        )}
      </Space>
    </Modal>
  );
}
export function JushuitanInventory({ onView }: { onView: () => void }) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(""),
    [loginId, setLoginId] = useState<string | null>(null),
    [matches, setMatches] = useState(false);
  const [enabled, setEnabled] = useState(false),
    [interval, setIntervalValue] = useState(30),
    [dirty, setDirty] = useState(false);
  const { message } = App.useApp(),
    user = useUser(),
    manager =
      user.permissions.includes("inventory.adjust") &&
      user.roleCodes?.includes("SUPER_ADMIN");
  const q = useQuery({
    queryKey: ["jushuitan-inventory"],
    queryFn: async () => (await api("/inventory/jushuitan")).data,
    enabled: open,
    refetchInterval: open ? 3000 : false,
  });
  const s = q.data,
    active = s?.runs?.some((r: Row) =>
      ["QUEUED", "RUNNING"].includes(r.status),
    );
  useEffect(() => {
    if (s && !dirty) {
      setEnabled(s.enabled);
      setIntervalValue(s.intervalMinutes);
    }
  }, [s, dirty]);
  const refresh = async () => {
    await q.refetch();
    await queryClient.invalidateQueries({ queryKey: ["/inventory/summary"] });
  };
  const run = async (action: string) => {
    setBusy(action);
    try {
      const b =
        action === "settings"
          ? { version: s.version, enabled, intervalMinutes: interval }
          : {};
      const result = await api(`/inventory/jushuitan/${action}`, "POST", b);
      if (action === "login") setLoginId(result.data.id);
      else
        message.success(
          action === "sync"
            ? "已开始后台导出同步，可在下方查看进度"
            : action === "disconnect"
              ? "会话已移除，定时同步已关闭"
              : "同步设置已保存",
        );
      setDirty(false);
      await refresh();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <Button
        aria-label="聚水潭同步"
        icon={<CloudSyncOutlined />}
        onClick={() => setOpen(true)}
      >
        聚水潭同步
      </Button>
      <Drawer
        title="聚水潭表格同步"
        size={660}
        open={open}
        onClose={() => setOpen(false)}
        destroyOnHidden
      >
        <Space orientation="vertical" size={18} style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            title="登录一次，点击同步自动导出并匹配"
            description="仅查询网站已有商品编码/条码，通过聚水潭网页分批导出。商品编码或其它属性5精确匹配后，按相同颜色尺码汇总。无需开放平台应用或API密钥。"
          />
          {q.error && <Alert type="error" title={(q.error as Error).message} />}
          {!s ? (
            <Spin />
          ) : (
            <>
              <Descriptions
                column={1}
                size="small"
                items={[
                  { key: "company", label: "公司", children: s.companyName },
                  {
                    key: "warehouse",
                    label: "同步仓库",
                    children: s.warehouseName,
                  },
                  {
                    key: "session",
                    label: "登录状态",
                    children: (
                      <Tag
                        color={
                          s.sessionStatus === "READY" ? "success" : "default"
                        }
                      >
                        {sessionNames[s.sessionStatus] ?? "未登录"}
                      </Tag>
                    ),
                  },
                  {
                    key: "saved",
                    label: "会话保存",
                    children: s.sessionSavedAt
                      ? when(s.sessionSavedAt)
                      : "尚未保存",
                  },
                  {
                    key: "check",
                    label: "最近核验",
                    children: s.sessionCheckedAt
                      ? when(s.sessionCheckedAt)
                      : "尚未核验",
                  },
                ]}
              />
              {!s.workerOnline && (
                <Alert
                  type="warning"
                  title="云端同步进程离线，请稍后刷新状态"
                />
              )}
              {s.errorNote && <Alert type="warning" title={s.errorNote} />}
              {manager ? (
                <>
                  <Space wrap>
                    <Button
                      icon={<LoginOutlined />}
                      aria-label={
                        s.configured ? "重新登录聚水潭" : "登录聚水潭"
                      }
                      disabled={
                        !!busy ||
                        active ||
                        !s.encryptionReady ||
                        !s.workerOnline
                      }
                      loading={busy === "login"}
                      onClick={() => void run("login")}
                    >
                      {s.configured ? "重新登录聚水潭" : "登录聚水潭"}
                    </Button>
                    <Button
                      type="primary"
                      icon={<CloudSyncOutlined />}
                      aria-label="立即同步"
                      loading={busy === "sync" || active}
                      disabled={
                        !!busy ||
                        active ||
                        s.sessionStatus !== "READY" ||
                        !s.workerOnline ||
                        dirty
                      }
                      onClick={() => void run("sync")}
                    >
                      立即同步
                    </Button>
                    {s.configured && (
                      <Popconfirm
                        title="移除已保存的登录会话？"
                        description="将停止定时同步，保留上一次完整库存供参考。"
                        onConfirm={() => run("disconnect")}
                      >
                        <Button danger disabled={!!busy}>
                          移除会话
                        </Button>
                      </Popconfirm>
                    )}
                  </Space>
                  {!s.encryptionReady && (
                    <Alert
                      type="warning"
                      title="服务器会话加密未就绪，请管理员检查同步进程配置"
                    />
                  )}
                  <Divider style={{ margin: "4px 0" }} />
                  <Space wrap>
                    <Switch
                      aria-label="定时同步"
                      checked={enabled}
                      disabled={!s.configured || s.sessionStatus !== "READY"}
                      onChange={(v) => {
                        setEnabled(v);
                        setDirty(true);
                      }}
                    />
                    <span>定时同步</span>
                    <Select
                      aria-label="同步间隔"
                      value={interval}
                      options={[15, 30, 60].map((value) => ({
                        value,
                        label: `每${value}分钟`,
                      }))}
                      onChange={(v) => {
                        setIntervalValue(v);
                        setDirty(true);
                      }}
                    />
                    <Button
                      disabled={!dirty || !!busy || active}
                      loading={busy === "settings"}
                      onClick={() => void run("settings")}
                    >
                      保存设置
                    </Button>
                  </Space>
                  <Typography.Text type="secondary">
                    会话失效时会停止定时同步并提示重新登录。同步只读取杭州总仓，不修改聚水潭或网站内部库存台账。
                  </Typography.Text>
                </>
              ) : (
                <Alert type="info" title="请由超级管理员登录或发起同步。" />
              )}
              <Space wrap>
                <Button onClick={() => void refresh()}>刷新状态</Button>
                <Button
                  disabled={!s.activeRunId}
                  onClick={() => {
                    onView();
                    setOpen(false);
                  }}
                >
                  查看聚水潭库存
                </Button>
                <Button
                  disabled={!s.activeRunId}
                  onClick={() => setMatches(true)}
                >
                  查看合并明细
                </Button>
                <Typography.Link href="/help?chapter=38-jushuitan-inventory.md">
                  同步说明
                </Typography.Link>
              </Space>
              <Typography.Title level={5} style={{ margin: 0 }}>
                同步记录
              </Typography.Title>
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={s.runs}
                scroll={{ x: 560 }}
                columns={[
                  {
                    title: "发起时间",
                    dataIndex: "createdAt",
                    render: when,
                    width: 155,
                  },
                  {
                    title: "进度",
                    dataIndex: "status",
                    render: (v: string, r: Row) => (
                      <Space orientation="vertical" size={2}>
                        <Tag
                          color={
                            v === "COMPLETE"
                              ? "success"
                              : v === "FAILED"
                                ? "error"
                                : "processing"
                          }
                        >
                          {names[v]}
                        </Tag>
                        <Typography.Text type="secondary">
                          {r.stage}
                        </Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: "导出 / 匹配 / 网站商品",
                    render: (_: unknown, r: Row) =>
                      `${r.exportedCount} / ${r.receivedCount} / ${r.requestedCount}`,
                  },
                ]}
                expandable={{
                  expandedRowRender: (r: Row) => (
                    <Space orientation="vertical" style={{ width: "100%" }}>
                      {r.errorNote && (
                        <Alert type="error" title={r.errorNote} />
                      )}
                      <span>
                        仓库：{r.warehouseName} ·{" "}
                        {r.triggerType === "SCHEDULED" ? "定时" : "手动"} ·{" "}
                        {r.finishedAt ? when(r.finishedAt) : "尚未完成"}
                      </span>
                      {r.sourceFileName && (
                        <span>原始文件：{r.sourceFileName}</span>
                      )}
                      {!!r.missingCodes?.length && (
                        <span style={{ overflowWrap: "anywhere" }}>
                          网站未匹配编码（最多50个）：
                          {r.missingCodes.join("、")}
                        </span>
                      )}
                    </Space>
                  ),
                }}
              />
              <Typography.Text type="secondary">
                数量直接取自导出表；可用数不重新计算。未匹配商品显示暂无数据，校验失败保留上次完整结果。
              </Typography.Text>
            </>
          )}
        </Space>
      </Drawer>
      {loginId && (
        <JushuitanLogin
          id={loginId}
          onClose={() => setLoginId(null)}
          onSaved={() => {
            void refresh();
          }}
        />
      )}
      {matches && <JushuitanMatches onClose={() => setMatches(false)} />}
    </>
  );
}
