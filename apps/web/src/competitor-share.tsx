import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Empty,
  Input,
  Modal,
  Popconfirm,
  QRCode,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import { CopyOutlined, LinkOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { QueryState } from "./shared";
import {
  competitorShareScopeLabel,
  type CompetitorShareFilters,
} from "../../../packages/contracts/src/competitor-sharing";
import type { CompetitorBrand } from "../../../packages/contracts/src/competitor-analysis";
import "./compass-share.css";

type Share = {
  id: string;
  brandNames: string[];
  filters: CompetitorShareFilters;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
};
const when = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });

export function CompetitorSharePanel({
  open,
  onClose,
  brands,
  filters,
  ready,
}: {
  open: boolean;
  onClose: () => void;
  brands: CompetitorBrand[];
  filters: CompetitorShareFilters;
  ready: boolean;
}) {
  const { message } = App.useApp();
  const [days, setDays] = useState<1 | 7 | 30>(7);
  const [busy, setBusy] = useState(false),
    [revoking, setRevoking] = useState("");
  const [created, setCreated] = useState<{
    id: string;
    url: string;
    expiresAt: string;
  } | null>(null);
  const input = useRef<React.ComponentRef<typeof Input>>(null);
  const pending = useRef<{ body: string; key: string } | null>(null);
  const history = useQuery({
    queryKey: ["competitor-shares"],
    queryFn: () => api("/analytics/competitors/shares"),
    enabled: open,
  });
  useEffect(() => {
    if (!open) setCreated(null);
  }, [open]);
  const create = async () => {
    if (!ready || !brands.length) return;
    const body = { days, brandIds: brands.map((b) => b.id), filters };
    const fingerprint = JSON.stringify(body);
    if (pending.current?.body !== fingerprint)
      pending.current = { body: fingerprint, key: crypto.randomUUID() };
    setBusy(true);
    try {
      const { data } = await api(
        "/analytics/competitors/shares",
        "POST",
        body,
        pending.current.key,
      );
      if (!/^\/share\/competitors\/[a-f0-9]{64}$/.test(data.path))
        throw new Error("分享地址无效，请刷新后重试");
      setCreated({
        id: data.id,
        url: new URL(data.path, location.origin).href,
        expiresAt: data.expiresAt,
      });
      pending.current = null;
      void history.refetch();
      message.success("分享链接已创建");
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      message.success("链接已复制");
    } catch {
      input.current?.select();
      message.info("请复制已选中的链接");
    }
  };
  const revoke = async (id: string) => {
    setRevoking(id);
    try {
      await api(`/analytics/competitors/shares/${id}/revoke`, "POST", {});
      if (created?.id === id) setCreated(null);
      await history.refetch();
      message.success("分享已关闭，链接无法再读取数据");
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setRevoking("");
    }
  };
  return (
    <Modal
      title="分享竞品分析"
      open={open}
      onCancel={() => !busy && onClose()}
      footer={
        <Button disabled={busy} onClick={onClose}>
          完成
        </Button>
      }
      width={600}
    >
      <Alert
        type="info"
        showIcon
        title="持有链接的人无需账号登录即可查看"
        description="分享选定品牌的概览、分布图表、商品 TOP20、价格、材质和图片。数据随最新采集结果更新，品牌、筛选和排序范围固定；外部只能查看。"
      />
      <div className="compass-share-create">
        <strong>
          本次品牌：{brands.map((b) => b.name).join("、") || "暂无可分享品牌"}
        </strong>
        <span className="secondary">{competitorShareScopeLabel(filters)}</span>
        <Space wrap>
          <span>有效期</span>
          <Select
            aria-label="分享有效期"
            value={days}
            onChange={setDays}
            disabled={busy}
            options={[
              { value: 1, label: "1 天" },
              { value: 7, label: "7 天" },
              { value: 30, label: "30 天" },
            ]}
            style={{ width: 100 }}
          />
          <Button
            type="primary"
            icon={<LinkOutlined aria-hidden="true" />}
            loading={busy}
            disabled={!ready || !brands.length}
            onClick={() => void create()}
          >
            创建分享链接
          </Button>
        </Space>
        {!ready && (
          <small>
            请等待当前品牌和筛选结果读取完成后创建，仍可关闭已有分享。
          </small>
        )}
      </div>
      {created && (
        <section className="compass-share-result" aria-label="新建分享链接">
          <QRCode value={created.url} size={148} />
          <div>
            <Input
              ref={input}
              readOnly
              value={created.url}
              aria-label="外部分享链接"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Space wrap>
              <Button
                icon={<CopyOutlined aria-hidden="true" />}
                onClick={() => void copy()}
              >
                复制链接
              </Button>
              <a href={created.url} target="_blank" rel="noopener noreferrer">
                预览分享页
              </a>
            </Space>
            <small>有效至 {when(created.expiresAt)}。手机扫码即可查看。</small>
          </div>
        </section>
      )}
      <h4>我创建的链接</h4>
      <QueryState error={history.error} reload={() => history.refetch()} />
      {history.isLoading ? (
        <Spin />
      ) : (
        <div className="compass-share-history">
          {((history.data?.data as Share[]) || []).map((share) => {
            const active =
              !share.revokedAt &&
              new Date(share.expiresAt).getTime() > Date.now();
            return (
              <div key={share.id}>
                <div>
                  <strong>{share.brandNames.join("、")}</strong>
                  <small>{competitorShareScopeLabel(share.filters)}</small>
                  <small>
                    创建于 {when(share.createdAt)} · 有效至{" "}
                    {when(share.expiresAt)}
                  </small>
                </div>
                {active ? (
                  <Popconfirm
                    title="关闭后，持有此链接的人将无法继续读取数据。"
                    okText="关闭分享"
                    cancelText="取消"
                    onConfirm={() => revoke(share.id)}
                  >
                    <Button danger size="small" loading={revoking === share.id}>
                      关闭分享
                    </Button>
                  </Popconfirm>
                ) : (
                  <Tag>{share.revokedAt ? "已关闭" : "已过期"}</Tag>
                )}
              </div>
            );
          })}
          {!history.error && !history.data?.data.length && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无分享链接"
            />
          )}
        </div>
      )}
      <p className="competitor-scope-note">
        链接仅在创建后显示，请及时复制保存。修改分享范围需创建新链接；可在此关闭原链接。已打开的分享页每30秒同步一次数据。
      </p>
    </Modal>
  );
}
