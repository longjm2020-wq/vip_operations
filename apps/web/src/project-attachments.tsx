import { useState } from "react";
import { App, Button, Image, Space, Typography, Upload } from "antd";
import {
  attachmentsSchema,
  attachmentTypes,
  type ProjectAttachment,
} from "../../../packages/contracts/src/project-attachments";

export function ProjectAttachments({
  files = [],
  onChange,
}: {
  files?: ProjectAttachment[];
  onChange?: (files: ProjectAttachment[]) => void;
}) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const add = async (file: File) => {
    if (busy) return false;
    const type =
      attachmentTypes[file.name.split(".").pop()?.toLowerCase() || ""];
    if (!type || file.size === 0 || file.size > 2 * 1024 * 1024) {
      message.error("请选择支持的图片或文档，单个文件不超过 2 MB，不能为空");
      return false;
    }
    setBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          resolve(`data:${type};base64,${String(reader.result).split(",")[1]}`);
        reader.onerror = () => reject(new Error("读取文件失败，请重试"));
        reader.readAsDataURL(file);
      });
      const next = [
        ...files,
        {
          id: crypto.randomUUID(),
          name: file.name,
          type,
          size: file.size,
          data,
        },
      ];
      const valid = attachmentsSchema.safeParse(next);
      if (!valid.success) throw new Error(valid.error.issues[0].message);
      onChange?.(valid.data);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
    return false;
  };
  const download = (file: ProjectAttachment) => {
    if (file.storageKey && file.url) {
      window.open(file.url, "_blank", "noopener,noreferrer");
      return;
    }
    const bytes = Uint8Array.from(atob(file.data.split(",")[1]), (c) =>
      c.charCodeAt(0),
    );
    const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/octet-stream" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Space orientation="vertical" style={{ width: "100%", marginTop: 12 }}>
      {onChange && (
        <>
          <Upload
            beforeUpload={add}
            showUploadList={false}
            accept={Object.keys(attachmentTypes)
              .map((x) => `.${x}`)
              .join(",")}
            disabled={busy}
          >
            <Button loading={busy}>添加图片 / 文档</Button>
          </Upload>
          <Typography.Text type="secondary">
            支持 JPG、PNG、WebP、PDF、Word、Excel、PPT、TXT、CSV；单个 2
            MB，合计 3 MB，最多 10 个。随项目保存后生效。
          </Typography.Text>
        </>
      )}
      {files.map((file) => (
        <Space
          key={file.id}
          wrap
          style={{ border: "1px solid #e1e9e7", padding: 10, width: "100%" }}
        >
          {file.type.startsWith("image/") && (
            <Image
              width={100}
              height={75}
              style={{ objectFit: "contain" }}
              src={file.storageKey ? `${file.url}?preview=1` : file.data}
              alt={file.name}
            />
          )}
          <span>
            {file.name} · {Math.ceil(file.size / 1024)} KB
          </span>
          <Button size="small" onClick={() => download(file)}>
            下载
          </Button>
          {onChange && (
            <Button
              size="small"
              danger
              onClick={() => onChange(files.filter((f) => f.id !== file.id))}
            >
              移除
            </Button>
          )}
        </Space>
      ))}
    </Space>
  );
}
