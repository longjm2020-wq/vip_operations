import { useState } from "react";
import { App, Avatar, Button, Dropdown, Modal } from "antd";
import {
  DownOutlined,
  LogoutOutlined,
  PictureOutlined,
} from "@ant-design/icons";
import { api, queryClient } from "./api";
import { Row, UserRoles } from "./shared";
import { prepareUpload, readUpload } from "./upload-file";

export function AccountMenu({
  user,
  onLogout,
}: {
  user: Row;
  onLogout: () => Promise<void>;
}) {
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    data: string;
    type: string;
    key: string;
  }>();
  const name = user.displayName || user.username || "账号";
  const src = user.avatarId
    ? `/api/v1/auth/avatar?v=${encodeURIComponent(user.avatarId)}`
    : undefined;
  const choose = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
        throw new Error("请选择 JPG、PNG 或 WebP 图片");
      const bitmap = await createImageBitmap(file);
      try {
        const side = Math.min(bitmap.width, bitmap.height);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = Math.min(512, side);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("当前浏览器不支持图片处理");
        ctx.drawImage(
          bitmap,
          (bitmap.width - side) / 2,
          (bitmap.height - side) / 2,
          side,
          side,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/webp", 0.9),
        );
        if (!blob) throw new Error("图片处理失败，请换一张图片重试");
        const prepared = await prepareUpload(
          new File(
            [blob],
            blob.type === "image/webp" ? "avatar.webp" : "avatar.png",
            { type: blob.type },
          ),
        );
        setPreview({
          data: await readUpload(prepared),
          type: prepared.type,
          key: crypto.randomUUID(),
        });
      } finally {
        bitmap.close();
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!preview || busy) return;
    setBusy(true);
    try {
      const r = await api(
        "/auth/avatar",
        "POST",
        { type: preview.type, data: preview.data },
        preview.key,
      );
      queryClient.setQueryData(["me"], (old: Row | null | undefined) =>
        old ? { ...old, avatarId: r.data.avatarId } : old,
      );
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      setEditing(false);
      setPreview(undefined);
      message.success("头像已更新");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Dropdown
        trigger={["click"]}
        placement="bottomRight"
        menu={{
          items: [
            { key: "avatar", icon: <PictureOutlined />, label: "更换头像" },
            { type: "divider" },
            {
              key: "logout",
              icon: <LogoutOutlined />,
              label: "退出登录",
              disabled: busy,
            },
          ],
          onClick: async ({ key }) => {
            if (key === "avatar") {
              setPreview(undefined);
              setEditing(true);
              return;
            }
            setBusy(true);
            try {
              await onLogout();
            } catch (e) {
              message.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          },
        }}
        popupRender={(menu) => (
          <div className="account-dropdown">
            <div className="account-dropdown-profile">
              <strong>{name}</strong>
              {user.username && user.username !== name && (
                <small>@{user.username}</small>
              )}
              <UserRoles names={user.roleNames} />
            </div>
            {menu}
          </div>
        )}
      >
        <Button
          type="text"
          className="account-menu-trigger"
          aria-label={`账号菜单：${name}`}
          aria-haspopup="menu"
        >
          <Avatar size={28} src={src}>
            {name.slice(0, 1)}
          </Avatar>
          <span className="account-menu-name">{name}</span>
          <DownOutlined className="account-menu-chevron" />
        </Button>
      </Dropdown>
      <Modal
        title="更换头像"
        open={editing}
        width={400}
        okText="保存头像"
        cancelText="取消"
        onOk={save}
        okButtonProps={{ disabled: !preview }}
        confirmLoading={busy}
        cancelButtonProps={{ disabled: busy }}
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
        onCancel={() => {
          if (!busy) {
            setEditing(false);
            setPreview(undefined);
          }
        }}
      >
        <div className="avatar-editor">
          <Avatar size={112} src={preview?.data || src}>
            {name.slice(0, 1)}
          </Avatar>
          <label className="supply-upload">
            {busy ? "处理中…" : "选择图片"}
            <input
              type="file"
              aria-label="选择头像图片"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy}
              onChange={(e) => {
                void choose(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <p className="secondary">
            支持 JPG、PNG、WebP；居中裁切并压缩至1 MB以下，确认预览后保存。
          </p>
        </div>
      </Modal>
    </>
  );
}
