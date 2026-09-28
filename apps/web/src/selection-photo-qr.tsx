import { useState } from "react";
import { Button, Modal, QRCode, Typography } from "antd";
import { QrcodeOutlined } from "@ant-design/icons";
export function SelectionPhotoQr({ rowId, disabled = false }: { rowId?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const url = new URL("/mobile/style-photos", window.location.origin);
  if (rowId) url.searchParams.set("id", rowId);
  return <><Button size="small" icon={<QrcodeOutlined />} disabled={disabled} title={disabled ? "请先等待当前款资料保存完成" : "手机扫码拍照上传"} onClick={() => setOpen(true)}>手机拍图</Button><Modal title="手机扫码拍图" open={open} onCancel={() => setOpen(false)} footer={null} width={330}><QRCode value={url.toString()} size={248} style={{margin:"16px auto"}} /><p>手机扫码后登录有选款登记权限的账号，即可按款号与颜色拍照、补拍和管理图片。</p><Typography.Paragraph copyable={{text:url.toString()}}><a href={url.toString()} target="_blank" rel="noreferrer">打开手机拍图页面</a></Typography.Paragraph></Modal></>;
}
