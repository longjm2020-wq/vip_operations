import { useState } from "react";
import { Alert, Modal } from "antd";
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
  legacyDesktop,
  onClose,
}: {
  legacyDesktop: boolean;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
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
    <Modal
      title="素材文件夹模板"
      width={460}
      open
      onCancel={onClose}
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
          点「导入素材」→「导入本机文件夹」，选择包含这些子文件夹的根目录。
        </li>
      </ol>
      {legacyDesktop && <p className="director-muted">桌面端按目录名归类需要 Windows 1.3.2 或更新版本，也可在网页端使用模板。</p>}
      {error && <Alert type="error" showIcon title={error} />}
    </Modal>
  );
}
