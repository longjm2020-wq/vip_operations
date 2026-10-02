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

type Share = {
  id: string;
  reportDate: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
};
const dateTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });

export function CompassSharePanel({
  open,
  onClose,
  reportId,
  reportDate,
}: {
  open: boolean;
  onClose: () => void;
  reportId?: string;
  reportDate?: string;
}) {
  const { message } = App.useApp();
  const [days, setDays] = useState<1 | 7 | 30>(7),
    [busy, setBusy] = useState(false),
    [revoking, setRevoking] = useState("");
  const [created, setCreated] = useState<{
    id: string;
    url: string;
    expiresAt: string;
  } | null>(null);
  const input = useRef<React.ComponentRef<typeof Input>>(null);
  const history = useQuery({
    queryKey: ["compass-report-shares"],
    queryFn: () => api("/analytics/compass/shares"),
    enabled: open,
  });
  useEffect(() => {
    if (!open) setCreated(null);
  }, [open]);
  const create = async () => {
    if (!reportId) return;
    setBusy(true);
    try {
      const { data } = await api("/analytics/compass/shares", "POST", {
        days,
        reportId,
      });
      if (!/^\/share\/compass\/[a-f0-9]{64}$/.test(data.path))
        throw new Error("分享地址无效，请刷新后重试");
      setCreated({
        id: data.id,
        url: new URL(data.path, window.location.origin).href,
        expiresAt: data.expiresAt,
      });
      await history.refetch();
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
      await api(`/analytics/compass/shares/${id}/revoke`, "POST", {});
      if (created?.id === id) setCreated(null);
      await history.refetch();
      message.success("链接已撤销，外部访问立即失效");
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setRevoking("");
    }
  };
  return (
    <Modal
      title="分享 AI 经营分析"
      open={open}
      onCancel={onClose}
      footer={<Button onClick={onClose}>完成</Button>}
      width={560}
      className="compass-share-panel"
    >
      <Alert
        type="info"
        showIcon
        title="持有链接的人无需登录即可查看"
        description="分享内容包含当前报告的销售、退货、库存、商品图片和完整解读。链接保存报告快照，后续刷新分析不会改变已分享内容。"
      />
      <div className="compass-share-create">
        <span className="secondary">
          {reportId
            ? `数据截至 ${reportDate}`
            : "当前没有可分享的已生成报告，仍可撤销已有链接。"}
        </span>
        <Space wrap>
          <span>有效期</span>
          <Select
            aria-label="分享有效期"
            value={days}
            onChange={setDays}
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
            disabled={!reportId}
            onClick={() => void create()}
          >
            创建分享链接
          </Button>
        </Space>
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
              <Button icon={<CopyOutlined aria-hidden="true" />} onClick={() => void copy()}>
                复制链接
              </Button>
              <a href={created.url} target="_blank" rel="noopener noreferrer">
                预览分享页
              </a>
            </Space>
            <small>
              有效至 {dateTime(created.expiresAt)}。手机扫码即可查看。
            </small>
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
            const expired = new Date(share.expiresAt).getTime() <= Date.now(),
              active = !share.revokedAt && !expired;
            return (
              <div key={share.id}>
                <div>
                  <strong>{share.reportDate} 报告</strong>
                  <small>创建于 {dateTime(share.createdAt)}</small>
                  <small>有效至 {dateTime(share.expiresAt)}</small>
                </div>
                {active ? (
                  <Popconfirm
                    title="撤销后，持有此链接的人将无法继续查看。"
                    okText="撤销链接"
                    cancelText="取消"
                    onConfirm={() => revoke(share.id)}
                  >
                    <Button danger size="small" loading={revoking === share.id}>
                      撤销链接
                    </Button>
                  </Popconfirm>
                ) : (
                  <Tag>{share.revokedAt ? "已撤销" : "已过期"}</Tag>
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
      <p className="ai-report-footnote">
        链接只在创建后显示，请及时复制保存。需要重新发送时可创建新链接；过期或撤销后可随时创建新的分享。
      </p>
    </Modal>
  );
}
