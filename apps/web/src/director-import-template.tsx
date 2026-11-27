import { useState } from "react";
import { FolderOpenOutlined } from "@ant-design/icons";
import { Alert, Button, Modal } from "antd";
import { directorRoles } from "../../../packages/contracts/src/director";
import { roleNames } from "./director-project";
import { releaseSheetDownload, triggerSheetDownload } from "./download-sheet";

async function downloadDirectorImportTemplate() {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const role of directorRoles) zip.folder(roleNames[role]);
  const blob = await zip.generateAsync({ type: "blob", platform: "DOS" });
  const file = {
    url: URL.createObjectURL(blob),
    fileName: "导演台素材文件夹模板.zip",
  };
  try {
    triggerSheetDownload(file);
  } finally {
    releaseSheetDownload(file);
  }
}

export function DirectorImportTemplate({
  local,
  nativeTemplate = false,
}: {
  local: boolean;
  nativeTemplate?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const folderAction = local
    ? nativeTemplate
      ? "导入本机文件夹"
      : "按模板上传文件夹"
    : "上传文件夹";
  async function download() {
    setError("");
    setLoading(true);
    try {
      await downloadDirectorImportTemplate();
    } catch {
      setError("模板下载失败，请重新下载。");
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <Button
        size="small"
        type="text"
        icon={<FolderOpenOutlined aria-hidden />}
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        文件夹模板
      </Button>
      <Modal
        title="素材文件夹模板"
        width={460}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void download()}
        confirmLoading={loading}
        cancelText="关闭"
        okText="下载模板"
      >
        <ol>
          <li>下载 ZIP 并解压到一个文件夹。</li>
          <li>
            按用途放入素材，可只使用需要的子文件夹。模板内含
            {directorRoles.map((role) => roleNames[role]).join("、")}。
          </li>
          <li>
            回到「整理素材」，点「{folderAction}
            」，选择包含这些子文件夹的根目录。
          </li>
        </ol>
        <p className="director-muted">
          只有一种用途时，也可以直接点该用途旁的加号选文件。肖像和音色导入后仍需确认使用授权。
        </p>
        {error && <Alert type="error" showIcon title={error} />}
      </Modal>
    </>
  );
}
