import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Empty,
  Modal,
  Select,
  Space,
  Table,
  Tooltip,
} from "antd";
import { SendOutlined } from "@ant-design/icons";
import type { SelectionLayoutController } from "./selection-layout-preferences";
import type { SelectionField } from "../../../packages/contracts/src/selection-layout";
import type { Row } from "./shared";
import { systemField } from "./selection-field-types";
import { useSelectionWorkspace } from "./selection-workspace";

type Target = {
  key: string;
  name: string;
  archive: boolean;
  fields: SelectionField[];
};
type Preview = {
  token: string;
  created: number;
  updated: number;
  addedFields: number;
  optionChanges?: {
    key: string;
    label: string;
    addedOptions: string[];
    shared?: boolean;
  }[];
  targetName: string;
  rows: Row[];
};
export function SelectionMigration({
  rows,
  fields,
  blocked,
  layout,
  onComplete,
  onBusy,
}: {
  rows: Row[];
  fields: SelectionField[];
  blocked: boolean;
  layout: SelectionLayoutController;
  onComplete: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const { api } = useSelectionWorkspace(),
    { message } = App.useApp();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [uncertain, setUncertain] = useState(false);
  const [targets, setTargets] = useState<Target[]>([]),
    [targetKey, setTargetKey] = useState(""),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [copyMissing, setCopyMissing] = useState(true),
    [preview, setPreview] = useState<Preview | null>(null);
  const pending = useRef<{ key: string; body: Row } | null>(null);
  const candidates = fields.filter(
    (field) =>
      !field.deleted &&
      !systemField(field) &&
      !["sellingPoints", "reorderDays", "collectionInventory"].includes(
        field.key,
      ),
  );
  const target = targets.find((item) => item.key === targetKey),
    unusable = rows.some((row) => !row.id || row.migrationLocked);
  const activity = (value: boolean) => {
    setBusy(value);
    onBusy(value);
  };
  const choose = (item: Target, remember = false) => {
    const saved = remember ? layout.preferences?.migrationConfig : null,
      next: Record<string, string> = {};
    const used = new Set<string>();
    for (const field of candidates) {
      if (saved?.target === item.key) {
        const selected = saved.mappings.find(
          (mapping) => mapping.source === field.key,
        )?.target;
        if (
          selected &&
          item.fields.some((field) => field.key === selected) &&
          !used.has(selected)
        ) {
          next[field.key] = selected;
          used.add(selected);
          continue;
        }
        if (saved.ignoredSources.includes(field.key)) {
          next[field.key] = "__ignore__";
          continue;
        }
      }
      const match =
        item.fields.find(
          (candidate) =>
            !systemField(candidate) &&
            !used.has(candidate.key) &&
            candidate.key === field.key,
        ) ||
        item.fields.find(
          (candidate) =>
            !systemField(candidate) &&
            !used.has(candidate.key) &&
            candidate.label === field.label,
        );
      if (match) {
        next[field.key] = match.key;
        used.add(match.key);
      }
    }
    setTargetKey(item.key);
    setMapping(next);
    setCopyMissing(saved?.target === item.key ? saved.copyMissingFields : true);
    setPreview(null);
    setError("");
  };
  const start = async () => {
    setOpen(true);
    activity(true);
    setError("");
    setPreview(null);
    pending.current = null;
    setUncertain(false);
    try {
      const data = (await api("/style-selections/migration/targets"))
        .data as Target[];
      setTargets(data);
      const preferred =
        data.find(
          (item) => item.key === layout.preferences?.migrationConfig?.target,
        ) ||
        data.find((item) => item.archive) ||
        data[0];
      if (preferred) choose(preferred, true);
      else setTargetKey("");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      activity(false);
    }
  };
  const config = () => ({
    target: targetKey,
    mappings: Object.entries(mapping)
      .filter(([, value]) => value && value !== "__ignore__")
      .map(([source, target]) => ({ source, target })),
    ignoredSources: Object.entries(mapping)
      .filter(([, value]) => value === "__ignore__")
      .map(([source]) => source),
    copyMissingFields: copyMissing,
  });
  useEffect(() => {
    if (open && targetKey && !busy && !preview)
      layout.update("migrationConfig", config());
  }, [open, targetKey, mapping, copyMissing, busy, preview]);
  const inspect = async () => {
    activity(true);
    setError("");
    try {
      const configuration = config();
      const data = (
        await api("/style-selections/migration/preview", "POST", {
          ...configuration,
          fields: candidates,
          rowIds: rows.map((row) => String(row.id)),
        })
      ).data as Preview;
      layout.update("migrationConfig", configuration);
      setPreview(data);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      activity(false);
    }
  };
  const send = async () => {
    if (!preview) return;
    activity(true);
    setError("");
    pending.current ||= {
      key: crypto.randomUUID(),
      body: {
        ...config(),
        fields: candidates,
        rowIds: rows.map((row) => String(row.id)),
        token: preview.token,
      },
    };
    try {
      const result = (
        await api(
          "/style-selections/migration",
          "POST",
          pending.current.body,
          pending.current.key,
        )
      ).data;
      message.success(
        `已向「${result.targetName}」传送 ${result.count} 行，原行已锁定`,
      );
      pending.current = null;
      setUncertain(false);
      setOpen(false);
      onComplete();
    } catch (error) {
      const failure = error as Error & { status?: number };
      setError(failure.message);
      if (!failure.status || failure.status >= 500) setUncertain(true);
      else {
        pending.current = null;
        setUncertain(false);
        setPreview(null);
      }
    } finally {
      activity(false);
    }
  };
  const disabled = blocked || !rows.length || rows.length > 100 || unusable;
  return (
    <>
      <Tooltip
        title={
          blocked
            ? "请等待当前修改保存完成"
            : unusable
              ? "已传送行请先通过 # 列的小铅笔释放"
              : rows.length > 100
                ? "每次最多传送100行"
                : "选中行后选择目标表及字段对应关系"
        }
      >
        <Button
          aria-label="跨表传送"
          icon={<SendOutlined />}
          disabled={disabled}
          onClick={() => void start()}
        >
          跨表传送
        </Button>
      </Tooltip>
      <Modal
        title="跨表传送"
        open={open}
        width={800}
        maskClosable={!busy && !uncertain}
        closable={!busy && !uncertain}
        onCancel={() => setOpen(false)}
        footer={
          <Space>
            <Button
              aria-label={preview ? "返回配置" : "取消"}
              disabled={busy || uncertain}
              onClick={() => (preview ? setPreview(null) : setOpen(false))}
            >
              {preview ? "返回配置" : "取消"}
            </Button>
            <Button
              type="primary"
              aria-label={
                preview ? (uncertain ? "核对并重试" : "确认传送") : "预览传送"
              }
              loading={busy}
              disabled={!target || !candidates.length}
              onClick={() => void (preview ? send() : inspect())}
            >
              {preview ? (uncertain ? "核对并重试" : "确认传送") : "预览传送"}
            </Button>
          </Space>
        }
      >
        {!!error && (
          <Alert
            type="error"
            showIcon
            title={error}
            style={{ marginBottom: 16 }}
          />
        )}
        {uncertain && (
          <Alert
            type="warning"
            title="结果尚未确认，请核对并重试；系统会复用本次请求，避免重复传送。"
            style={{ marginBottom: 16 }}
          />
        )}
        {!preview ? (
          <>
            <p>
              已选择 {rows.length} 行。传送后保留原行并锁定，点击 #
              列的小铅笔可恢复编辑。
            </p>
            <Select
              aria-label="目标表格"
              style={{ width: "100%", marginBottom: 16 }}
              loading={busy}
              disabled={busy}
              value={targetKey || undefined}
              placeholder="选择目标表格"
              options={targets.map((item) => ({
                value: item.key,
                label: item.name,
              }))}
              onChange={(key) =>
                choose(targets.find((item) => item.key === key)!)
              }
            />
            {target ? (
              <>
                <Table
                  size="small"
                  rowKey="key"
                  dataSource={candidates}
                  pagination={false}
                  scroll={{ y: 340 }}
                  columns={[
                    { title: "当前表字段", dataIndex: "label" },
                    {
                      title: "目标表字段",
                      render: (_, field: SelectionField) => (
                        <Select
                          aria-label={`对应${field.label}`}
                          style={{ width: "100%" }}
                          disabled={busy}
                          value={mapping[field.key] || "__new__"}
                          options={[
                            {
                              value: "__new__",
                              label: copyMissing ? "新增同名字段" : "不传送",
                            },
                            { value: "__ignore__", label: "不传送" },
                            ...target.fields
                              .filter((candidate) => !systemField(candidate))
                              .map((candidate) => ({
                                value: candidate.key,
                                label: candidate.label,
                                disabled: Object.entries(mapping).some(
                                  ([key, value]) =>
                                    key !== field.key &&
                                    value === candidate.key,
                                ),
                              })),
                          ]}
                          onChange={(value) =>
                            setMapping((current) => ({
                              ...current,
                              [field.key]: value === "__new__" ? "" : value,
                            }))
                          }
                        />
                      ),
                    },
                  ]}
                />
                <Checkbox
                  checked={copyMissing}
                  disabled={busy}
                  style={{ marginTop: 16 }}
                  onChange={(event) => setCopyMissing(event.target.checked)}
                >
                  未对应字段在目标表新增
                </Checkbox>
              </>
            ) : (
              !busy && (
                <Empty description="没有可传送的目标表，请先创建表格或联系管理员开通权限" />
              )
            )}
          </>
        ) : (
          <>
            <Alert
              type={preview.updated ? "warning" : "info"}
              showIcon
              title={`目标：${preview.targetName} · 新增 ${preview.created} 行 · 更新 ${preview.updated} 行 · 新增 ${preview.addedFields} 个字段`}
              description={
                preview.updated
                  ? "目标表已有同款号的行，对应字段将以本次传送内容更新；其他字段保留。确认后整批执行。"
                  : "确认后整批执行，任何一行失败时整批不写入。"
              }
            />
            {!!preview.optionChanges?.length && (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 12 }}
                title={`补齐目标字段选项 · ${preview.optionChanges.reduce((count, change) => count + change.addedOptions.length, 0)} 个`}
                description={
                  <>
                    确认后添加以下选项，保留目标已有选项及配色。
                    {preview.optionChanges.some((change) => change.shared) && (
                      <p style={{ margin: "8px 0 0" }}>
                        商品共享字段的新增选项将对所有用户生效；类型及已有选项不变。
                      </p>
                    )}
                    <ul
                      style={{
                        margin: "8px 0 0",
                        paddingLeft: 20,
                        maxHeight: 130,
                        overflowY: "auto",
                      }}
                    >
                      {preview.optionChanges.map((change) => (
                        <li key={change.key}>
                          {change.label}
                          {change.shared ? "（商品共享）" : ""}：
                          {change.addedOptions.join("、")}
                        </li>
                      ))}
                    </ul>
                  </>
                }
              />
            )}
            <Table
              style={{ marginTop: 16 }}
              size="small"
              rowKey="sourceId"
              dataSource={preview.rows}
              pagination={false}
              scroll={{ y: 340 }}
              columns={[
                { title: "款号", dataIndex: "style" },
                { title: "目标处理", dataIndex: "action" },
              ]}
            />
          </>
        )}
      </Modal>
    </>
  );
}
