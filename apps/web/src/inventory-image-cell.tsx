import { App, Button, Dropdown, Tooltip } from "antd";
import { CameraOutlined, PlusOutlined } from "@ant-design/icons";
import { useRef, useState } from "react";
import { api } from "./api";
import { prepareUpload, readUpload } from "./upload-file";
import { CompassProductImage, type CompassImageTarget } from "./compass-product-image";
import { inventoryImageSourceLabels, type InventoryImageSource } from "../../../packages/contracts/src/inventory-image";
import type { Row } from "./shared";

type Source = { url: string; source: InventoryImageSource };

export function inventoryImageSources(row: Row): Source[] {
  const sources: Source[] = Array.isArray(row.imageSources) ? row.imageSources : row.mainImageUrl ? [{ url: row.mainImageUrl, source: "archive" }] : [];
  // Browsers block plain http pictures on the https site; skip them like a load error.
  return sources.filter((item) => typeof item.url === "string" && /^(https:\/\/|\/api\/v1\/)/i.test(item.url));
}

/** Tries each source in order (Vipshop → user upload → archive). A picture that
 * fails to load falls through to the next one, then to an upload prompt or "—". */
export function InventoryImageCell({
  row,
  code,
  canEdit,
  onPreview,
  onChanged,
}: {
  row: Row;
  code: string;
  canEdit: boolean;
  onPreview: (target: CompassImageTarget) => void;
  onChanged: () => void;
}) {
  const { message, modal } = App.useApp();
  const input = useRef<HTMLInputElement>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const sources = inventoryImageSources(row);
  const current = sources.find((item) => !failed.includes(item.url));
  const uploadColor: string | null = row.imageUploadColor ?? null;
  const editable = canEdit && uploadColor !== null && !!row.productId;
  const userImage = row.inventoryUserImage as Row | null | undefined;
  const scope = uploadColor ? `颜色「${uploadColor}」` : "整款";
  const platformShown = current?.source === "vip" || current?.source === "vip-style" || current?.source === "compass";
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const prepared = await prepareUpload(file);
      if (!prepared.type.startsWith("image/")) throw new Error("请选择 JPG、PNG 或 WebP 图片");
      await api("/inventory/images", "POST", {
        productId: String(row.productId),
        colorName: uploadColor ?? "",
        data: await readUpload(prepared),
        fileName: file.name.slice(0, 255),
      });
      message.success(platformShown ? "已保存上传图片；唯品会已有图片，仍优先显示唯品会图" : "已保存上传图片");
      setFailed([]);
      onChanged();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const remove = () =>
    modal.confirm({
      title: `删除${scope}上传图片？`,
      content: "只删除本页上传的图片，不影响唯品会、罗盘或选款登记图片。",
      okText: "删除",
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api("/inventory/images/delete", "POST", { productId: String(row.productId), colorName: uploadColor ?? "" });
          message.success("已删除上传图片");
          onChanged();
        } catch (error) {
          message.error((error as Error).message);
          throw error;
        }
      },
    });
  const picker = editable && (
    <input
      ref={input}
      type="file"
      hidden
      accept="image/jpeg,image/png,image/webp"
      aria-label={`选择图片 ${code}`}
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void upload(file);
      }}
    />
  );
  if (!current)
    return editable ? (
      <>
        {picker}
        <Tooltip title={`唯品会暂无图片，可上传${scope}图片`}>
          <Button
            size="small"
            type="dashed"
            className="inventory-image-upload"
            icon={<PlusOutlined />}
            loading={busy}
            aria-label={`上传图片 ${code}`}
            onClick={(event) => {
              event.stopPropagation();
              input.current?.click();
            }}
          />
        </Tooltip>
      </>
    ) : (
      <span aria-label={`暂无图片 ${code}`}>—</span>
    );
  return (
    <span className="inventory-image-frame" title={inventoryImageSourceLabels[current.source]}>
      <CompassProductImage
        key={current.url}
        image={current.url}
        code={code}
        onPreview={onPreview}
        onFailed={(url) => setFailed((list) => (list.includes(url) ? list : [...list, url]))}
      />
      {editable && (
        <>
          {picker}
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                {
                  key: "upload",
                  label: `${userImage ? "替换" : "上传"}${scope}图片${platformShown ? "（唯品会缺图时显示）" : ""}`,
                },
                ...(userImage ? [{ key: "delete", danger: true, label: `删除${scope}上传图片` }] : []),
              ],
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === "upload") input.current?.click();
                else remove();
              },
            }}
          >
            <Button
              size="small"
              type="text"
              className="inventory-image-edit"
              icon={<CameraOutlined />}
              loading={busy}
              aria-label={`管理图片 ${code}`}
              onClick={(event) => event.stopPropagation()}
            />
          </Dropdown>
        </>
      )}
    </span>
  );
}
