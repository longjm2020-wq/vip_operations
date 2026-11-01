import { useState } from "react";
import { Alert, Button, Empty, Input, Popconfirm, Space, Spin } from "antd";
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import type {
  AssistantMemory,
  AssistantMemoryEntry,
} from "../../../packages/contracts/src/personal-assistant";

export function AssistantMemoryPanel({
  data,
  loading,
  error,
  save,
  refresh,
  suggestion,
  clearSuggestion,
}: {
  data?: AssistantMemory;
  loading: boolean;
  error?: Error | null;
  save: (entries: AssistantMemoryEntry[]) => Promise<void>;
  refresh: () => void;
  suggestion: AssistantMemoryEntry | null;
  clearSuggestion: () => void;
}) {
  const [draft, setDraft] = useState<AssistantMemoryEntry | null>(null),
    [saving, setSaving] = useState(false),
    [failure, setFailure] = useState("");
  const current = draft || suggestion;
  const entries = data?.entries || [];
  const commit = async (next: AssistantMemoryEntry[]) => {
    setSaving(true);
    setFailure("");
    try {
      await save(next);
      setDraft(null);
      clearSuggestion();
    } catch (cause) {
      setFailure((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="assistant-memory-panel" aria-label="个人记忆管理">
      <p className="assistant-privacy">
        只有你能查看和管理。勾选“使用个人记忆”后随消息发送给
        AI；清空对话不会删除记忆。
      </p>
      <div className="assistant-memory-toolbar">
        <Button
          icon={<PlusOutlined />}
          onClick={() => {
            clearSuggestion();
            setDraft({ id: crypto.randomUUID(), title: "", content: "" });
          }}
          disabled={saving || entries.length >= 40}
        >
          新增记忆
        </Button>
        <span>{entries.length} / 40</span>
        <Button
          icon={<ReloadOutlined />}
          onClick={refresh}
          aria-label="刷新个人记忆"
          loading={loading}
        />
        <Popconfirm
          title="清空全部个人记忆？"
          description="清空后不再用于新对话，历史对话中的内容仍会保留。"
          okText="清空"
          cancelText="取消"
          onConfirm={() => commit([])}
        >
          <Button danger disabled={!entries.length || saving}>
            清空记忆
          </Button>
        </Popconfirm>
      </div>
      {(error || failure) && (
        <Alert showIcon type="error" title={failure || error?.message} />
      )}
      {loading && !data && <Spin />}
      {current && (
        <div className="assistant-memory-editor">
          <label htmlFor="assistant-memory-title">记忆名称</label>
          <Input
            id="assistant-memory-title"
            maxLength={40}
            value={current.title}
            onChange={(e) => setDraft({ ...current, title: e.target.value })}
            placeholder="例如：工作汇报偏好"
            disabled={saving}
          />
          <label htmlFor="assistant-memory-content">记忆内容</label>
          <Input.TextArea
            id="assistant-memory-content"
            maxLength={500}
            showCount
            autoSize={{ minRows: 3, maxRows: 7 }}
            value={current.content}
            onChange={(e) => setDraft({ ...current, content: e.target.value })}
            placeholder="希望小序记住的工作偏好，请勿填写密码或密钥。"
            disabled={saving}
          />
          <Space>
            <Button
              type="primary"
              loading={saving}
              disabled={
                !data || !current.title.trim() || !current.content.trim()
              }
              onClick={() =>
                commit(
                  entries.some((entry) => entry.id === current.id)
                    ? entries.map((entry) =>
                        entry.id === current.id ? current : entry,
                      )
                    : [...entries, current],
                )
              }
            >
              保存记忆
            </Button>
            <Button
              disabled={saving}
              onClick={() => {
                setDraft(null);
                clearSuggestion();
                setFailure("");
              }}
            >
              取消
            </Button>
          </Space>
        </div>
      )}
      {!loading && !entries.length && !current && (
        <Empty description="还没有个人记忆" />
      )}
      {entries.map((entry) => (
        <article className="assistant-memory-entry" key={entry.id}>
          <strong>{entry.title}</strong>
          <p>{entry.content}</p>
          <Space>
            <Button
              size="small"
              aria-label="编辑记忆"
              icon={<EditOutlined />}
              disabled={saving}
              onClick={() => {
                clearSuggestion();
                setDraft(entry);
              }}
            >
              编辑
            </Button>
            <Popconfirm
              title="删除这条记忆？"
              okText="删除"
              cancelText="取消"
              onConfirm={() =>
                commit(entries.filter((item) => item.id !== entry.id))
              }
            >
              <Button
                danger
                size="small"
                aria-label="删除记忆"
                disabled={saving}
                icon={<DeleteOutlined />}
              >
                删除
              </Button>
            </Popconfirm>
          </Space>
        </article>
      ))}
    </section>
  );
}
