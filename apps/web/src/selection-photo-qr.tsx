import {useSelectionWorkspace} from "./selection-workspace";
import {type SelectionField,defaultImageConfig} from "./selection-field-types";
import { useState } from "react";
import { Button, Modal, QRCode, Typography } from "antd";
import { QrcodeOutlined } from "@ant-design/icons";
export function SelectionPhotoQr({ rowId, disabled = false, labelImages = false,field }: {field?:SelectionField; rowId?: string; disabled?: boolean; labelImages?: boolean }) {
  const {tableId}=useSelectionWorkspace();
  const [open, setOpen] = useState(false);
  const url = new URL("/mobile/style-photos", window.location.origin);
  if(tableId)url.searchParams.set("tableId",tableId);
  if (rowId) url.searchParams.set("id", rowId);
  if(field){url.searchParams.set("field",field.key);url.searchParams.set("fieldName",field.label);url.searchParams.set("fieldConfig",JSON.stringify({...defaultImageConfig,...field.imageConfig}));}
  if (labelImages) url.searchParams.set("section", "labels");
  return <><Button size="small" icon={<QrcodeOutlined />} disabled={disabled} title={disabled ? "请先等待当前款资料保存完成" : "手机扫码拍照上传"} onClick={() => setOpen(true)}>手机拍图</Button><Modal title={labelImages?"手机扫码拍洗唛/吊牌图":"手机扫码拍图"} open={open} onCancel={() => setOpen(false)} footer={null} width={330}><QRCode value={url.toString()} size={248} style={{margin:"16px auto"}} /><p>{field?`手机登录有选款登记权限的账号后，拍摄图片保存到本款的「${field.label}」字段。二维码携带本次字段功能设置。`:"手机扫码后登录有选款登记权限的账号，即可为本款拍摄候选款图片或洗唛/吊牌图。洗唛/吊牌图无需选择颜色。"}</p><Typography.Paragraph copyable={{text:url.toString()}}><a href={url.toString()} target="_blank" rel="noreferrer">打开手机拍图页面</a></Typography.Paragraph></Modal></>;
}
