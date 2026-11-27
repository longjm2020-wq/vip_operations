import { useEffect, useId, useRef, useState } from "react";
import { Alert, Button, Input, Space } from "antd";
import { LinkOutlined } from "@ant-design/icons";
import { studioApi, type Item } from "./api";

export function PublicReferenceInput({
  projectId,
  disabled,
  onBusy,
  onImport,
}: {
  projectId: string;
  disabled: boolean;
  onBusy: (value: boolean) => void;
  onImport: (asset: Item) => void;
}) {
  const field = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController>(null);
  useEffect(() => () => pending.current?.abort(), []);

  const submit = async () => {
    if (disabled || pending.current || !text.trim()) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const asset = await studioApi(
        "/assets/import-reference",
        "POST",
        {
          projectId,
          shareText: text.trim(),
        },
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) {
        onImport(asset);
        setOpen(false);
        setText("");
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "无法导入参考片，请从本机上传。",
        );
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
        onBusy(false);
      }
    }
  };

  if (!open)
    return (
      <Button
        icon={<LinkOutlined />}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        导入分享链接
      </Button>
    );

  return (
    <Space orientation="vertical" size="small" style={{ width: "100%" }}>
      <label htmlFor={field}>参考视频链接</label>
      <Input.TextArea
        id={field}
        rows={2}
        maxLength={8192}
        value={text}
        disabled={disabled || busy}
        placeholder="粘贴抖音、小红书分享文案或可直接播放的视频链接"
        onChange={(event) => setText(event.target.value)}
      />
      {error && <Alert type="error" title={error} showIcon />}
      <Space wrap>
        <Button
          type="primary"
          loading={busy}
          disabled={disabled || !text.trim()}
          onClick={() => void submit()}
        >
          导入参考片
        </Button>
        <Button disabled={busy} onClick={() => setOpen(false)}>
          收起
        </Button>
      </Space>
    </Space>
  );
}
