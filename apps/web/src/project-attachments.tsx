import { prepareUpload, readUpload } from "./upload-file";
import { api } from "./api";
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
    let type = attachmentTypes[file.name.split(".").pop()?.toLowerCase() || ""];
    if (!type || file.size === 0) {
      message.error("请选择支持的图片或文档，不能为空");
      return false;
    }
    setBusy(true);
    try {
      file = await prepareUpload(new File([file], file.name, { type }));
      type = file.type;
      const data = await readUpload(file);
      const result = await api("/projects/uploads", "POST", {
        id: crypto.randomUUID(),
        name: file.name,
        type,
        size: file.size,
        data,
      });
      const next = [...files, result.data];
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
            支持图片及常见文档，最多10个。图片自动压缩至1 MB以下；文档须小于50
            MB，超限尝试无损压缩为.gz，仍超限则提示拆分。随项目保存后关联生效。
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
