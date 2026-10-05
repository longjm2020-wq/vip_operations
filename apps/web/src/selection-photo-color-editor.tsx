import { useRef, useState } from "react";
import { Alert, Button, Form, Input, Modal } from "antd";
import { useSelectionWorkspace } from "./selection-workspace";
import type { Row } from "./shared";

export function PhotoColorEditor({
  row,
  color,
  onClose,
  onSaved,
}: {
  row: Row;
  color: string;
  onClose: () => void;
  onSaved: (row: Row, nextColor: string) => void;
}) {
  const { api } = useSelectionWorkspace();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const colors = String(row.color || "")
    .split("/")
    .map((value) => value.trim())
    .filter(Boolean);
  return (
    <Modal
      className="mobile-photo-metadata"
      open
      title="修改颜色标签"
      footer={null}
      onCancel={() => {
        if (!busy) onClose();
      }}
      mask={{ closable: !busy }}
      closable={!busy}
    >
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          style={{ marginBottom: 12 }}
        />
      )}
      <Form
        layout="vertical"
        initialValues={{ color }}
        onFinish={async ({ color: value }: { color: string }) => {
          if (busy) return;
          const nextColor = value.trim();
          if (nextColor === color) {
            onClose();
            return;
          }
          const body = {
            color: colors
              .map((item) => (item === color ? nextColor : item))
              .join("/"),
            images: (row.images || []).map((image: Row) =>
              image.color === color ? { ...image, color: nextColor } : image,
            ),
            expectedUpdatedAt: row.updatedAt,
          };
          const encoded = JSON.stringify(body);
          if (!attempt.current || attempt.current.body !== encoded)
            attempt.current = { body: encoded, key: crypto.randomUUID() };
          setBusy(true);
          setError("");
          try {
            const response = await api(
              `/style-selections/${row.id}`,
              "PATCH",
              body,
              attempt.current.key,
            );
            onSaved(response.data, nextColor);
          } catch (e) {
            setError(
              (e as Error).message +
                ((e as Error & { status?: number }).status === 409
                  ? "；请关闭窗口，刷新最新资料后再修改颜色"
                  : ""),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <Form.Item
          name="color"
          label="颜色名称"
          rules={[
            {
              validator: async (_, value: string) => {
                const name = String(value || "").trim();
                if (!name) throw Error("请填写颜色名称");
                if (name.includes("/"))
                  throw Error(
                    "单个颜色名称不能包含 /，请在编辑款号 / 颜色中添加多种颜色",
                  );
                if (name !== color && colors.includes(name))
                  throw Error("该款已有此颜色，请使用不同名称");
                if (
                  colors.map((item) => (item === color ? name : item)).join("/")
                    .length > 100
                )
                  throw Error("全部颜色合计不能超过100个字符");
              },
            },
          ]}
        >
          <Input autoFocus maxLength={100} disabled={busy} />
        </Form.Item>
        <p className="mobile-photo-hint">
          该颜色下已有图片会保留，并同步修改图片颜色标签及电脑端颜色字段。
        </p>
        <Button
          block
          type="primary"
          htmlType="submit"
          size="large"
          loading={busy}
        >
          保存颜色
        </Button>
      </Form>
    </Modal>
  );
}
