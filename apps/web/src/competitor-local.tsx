import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Progress, Space, Tag } from "antd";
import type { CompetitorBrand } from "../../../packages/contracts/src/competitor-analysis";
import {
  localCollectorUrl,
  localCollectorVersion,
} from "../../../packages/contracts/src/competitor-local";
import {
  LocalCompetitorRun,
  localCollectorRequest,
} from "./competitor-local-run";
import { api } from "./api";

export function CompetitorLocalUpdate({
  open,
  brands,
  onClose,
  onSaved,
}: {
  open: boolean;
  brands: CompetitorBrand[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [, render] = useState(0);
  const [connected, setConnected] = useState(false),
    [checking, setChecking] = useState(false),
    [error, setError] = useState("");
  const runRef = useRef<LocalCompetitorRun | null>(null);
  const alive = useRef(true),
    savedRef = useRef(onSaved);
  savedRef.current = onSaved;
  const run = runRef.current;
  async function detect() {
    setChecking(true);
    setError("");
    try {
      const result = await localCollectorRequest("PING", crypto.randomUUID());
      if (result.version !== localCollectorVersion)
        throw Error("采集助手版本已更新，请重新下载并在扩展管理页重新加载");
      setConnected(true);
    } catch (e) {
      setConnected(false);
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    if (open) void detect();
  }, [open]);
  useEffect(() => {
    alive.current = true;
    const warn = (e: BeforeUnloadEvent) => {
      if (runRef.current?.running) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      alive.current = false;
      runRef.current?.stop();
      window.removeEventListener("beforeunload", warn);
    };
  }, []);
  async function start() {
    const next = new LocalCompetitorRun(brands, {
      request: localCollectorRequest,
      save: (path, body, key) => api(path, "POST", body, key),
      changed: () => {
        if (alive.current) render((n) => n + 1);
      },
      saved: () => savedRef.current(),
    });
    runRef.current = next;
    await next.start();
  }
  const invalid = brands.filter(
    (b) => !b.brandSn || !localCollectorUrl(b.searchUrl),
  );
  return (
    <Modal
      title="本机更新竞品数据"
      open={open}
      width={720}
      onCancel={() => {
        if (!run?.running) onClose();
      }}
      maskClosable={false}
      styles={{
        body: { maxHeight: "calc(100dvh - 260px)", overflowY: "auto" },
      }}
      footer={
        <Space wrap>
          <Button disabled={run?.running} onClick={onClose}>
            关闭
          </Button>
          {run && !run.done && !run.stopped && (
            <Button
              onClick={() => void run.focus().catch((e) => setError(e.message))}
            >
              查看采集页面
            </Button>
          )}
          {run?.running ? (
            <Button onClick={() => run.pause()}>暂停更新</Button>
          ) : run && !run.done && !run.stopped ? (
            <>
              <Button onClick={() => run.stop()}>停止本次更新</Button>
              <Button
                type="primary"
                disabled={!connected}
                onClick={() => void run.start()}
              >
                继续更新
              </Button>
            </>
          ) : (
            <Button
              type="primary"
              disabled={!connected || !!invalid.length || !brands.length}
              onClick={() => void start()}
            >
              {run?.done ? "重新更新" : "开始本机更新"}
            </Button>
          )}
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        title="更新期间保持浏览器和本页打开"
        description="每个品牌采集公开销量榜前50款，再逐款核对规格参数并自动保存。登录和验证在本机唯品会页面完成；切走或刷新本页会中断任务，已保存的数据保留。"
      />
      <div style={{ margin: "14px 0" }}>
        <Space wrap>
          <Tag color={connected ? "success" : "warning"}>
            {connected ? "本机采集助手已连接" : "本机采集助手未连接"}
          </Tag>
          <Button
            loading={checking}
            disabled={run?.running}
            onClick={() => void detect()}
          >
            检测连接
          </Button>
          <Button
            href="/api/v1/analytics/competitors/local-extension"
            download="xuti-vip-local-collector.zip"
          >
            下载采集助手
          </Button>
        </Space>
      </div>
      {!connected && (
        <div>
          <p>
            首次使用：在 Chrome 或 Edge
            中打开本经营系统，下载并解压采集助手。在浏览器「扩展程序 →
            管理扩展」打开开发者模式，点击「加载已解压的扩展程序」，选择含
            manifest.json 的文件夹；随后刷新本页。
          </p>
          <p>
            助手只在本经营系统及唯品会商品、登录网站运行，读取公开商品资料。唯品会登录状态留在本机；回传内容为商品榜单、价格、图片链接和规格参数。Codex
            内置浏览器暂不支持安装此助手。
          </p>
        </div>
      )}
      {!!invalid.length && (
        <Alert
          type="warning"
          title={`这些品牌尚未绑定品牌ID：${invalid.map((b) => b.name).join("、")}`}
          description="请先通过「浏览器补充数据」导入已选择准确品牌的销量榜单，再开始本机更新。"
        />
      )}
      <p>
        本次品牌：
        {(run && !run.done && !run.stopped
          ? run.rows.map((r) => r.brand)
          : brands
        )
          .map((b) => b.name)
          .join("、")}
      </p>
      {(run?.error || error) && (
        <Alert
          type="warning"
          showIcon
          title={run?.error || error}
          description="在采集页按唯品会提示处理后返回继续；无法访问时停止本次更新。已成功回传的数据不会丢失。"
        />
      )}
      {run?.rows.map((row) => (
        <div
          key={row.brand.id}
          style={{ padding: "12px 0", borderBottom: "1px solid #eee" }}
        >
          <Space>
            <strong>{row.brand.name}</strong>
            <Tag
              color={
                row.status === "已完成"
                  ? "success"
                  : row.status === "已暂停"
                    ? "warning"
                    : "default"
              }
            >
              {row.status}
            </Tag>
          </Space>
          <Progress
            aria-label={`${row.brand.name}本机采集进度`}
            percent={
              row.captured
                ? Math.floor(50 + (50 * row.details) / row.captured)
                : 0
            }
            size="small"
          />
          <div>
            已保存榜单 {row.captured} 款 · 本次详情 {row.details} /{" "}
            {row.captured || 50} 款
          </div>
          <small>{row.note}</small>
        </div>
      ))}
      {run?.done && (
        <Alert type="success" showIcon title="本次所有品牌已更新并保存" />
      )}
    </Modal>
  );
}
