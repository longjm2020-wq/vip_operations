import { useState } from "react";
import { Alert, Button, Image, Modal, Radio, Tooltip } from "antd";
import { ClearOutlined } from "@ant-design/icons";
import type { SelectionImageIdentity } from "../../../packages/contracts/src/selection-image-dedup.js";
import { keepStandardColorImages, standardColorImageCleanup, type StandardImageColors } from "./selection-image-color-cleanup-plan";
import { invalidSelectionImage } from "./selection-image-links";
import "./selection-image-color-cleanup.css";

export function SelectionImageColorCleanup<T extends SelectionImageIdentity & { id: string }>({ images, basis, disabled, onChange }: {
  images: T[]; basis?: StandardImageColors; disabled: boolean; onChange: (images: T[]) => void;
}) {
  const [previewToken, setPreviewToken] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const token = JSON.stringify({ images, basis });
  const plan = standardColorImageCleanup(images, basis);
  const stale = previewToken !== null && previewToken !== token;
  const preview = () => {
    setChoices(Object.fromEntries(plan.duplicates.map(group => [group.color, group.images[0].id])));
    setPreviewToken(token);
  };
  if (disabled) return null;
  return <div className="selection-image-cleanup-entry">
    <Tooltip title={!basis ? "请先填写唯一且可查看的标准颜色字段" : !plan.removeCount ? "没有同一标准颜色下的多张图片可清理" : "预览并选择每种标准颜色需要保留的一张图片"}>
      <Button size="small" aria-label="按标准颜色去重" icon={<ClearOutlined aria-hidden />} disabled={!basis || !plan.removeCount} onClick={preview}>按标准颜色去重</Button>
    </Tooltip>
    <Modal title="按标准颜色去重" open={previewToken !== null} onCancel={() => setPreviewToken(null)}
      width={620} okText={`确认移除 ${plan.removeCount} 张`} cancelText="取消"
      okButtonProps={{ disabled: stale || !basis || !plan.removeCount }}
      onOk={() => {
        if (stale || disabled || !basis || !plan.removeCount) return;
        onChange(keepStandardColorImages(images, basis, choices));
        setPreviewToken(null);
      }}>
      {stale ? <Alert type="warning" showIcon title="图片或标准颜色已变化，请重新预览"
        action={<Button size="small" onClick={preview}>重新预览</Button>} /> : <>
        <p className="selection-image-cleanup-summary">标准颜色 {basis?.colors.length || 0} 种 · 当前 {images.length} 张 → 保留 {plan.keepCount} 张 · 移除 {plan.removeCount} 张</p>
        <p className="selection-image-cleanup-note">每种标准颜色保留一张。默认保留第一张，可点击更换；同色不同角度的照片也会移除，请核对后确认。</p>
        {!!plan.unmatchedCount && <p className="selection-image-cleanup-note">另有 {plan.unmatchedCount} 张图片未匹配标准颜色或关联其他颜色字段，将原样保留。</p>}
        <div className="selection-image-cleanup-groups">
          {plan.duplicates.map(group => <section key={group.color}>
            <h4>{group.color} · {group.images.length} 张，保留 1 张</h4>
            <Radio.Group aria-label={`${group.color}保留图片`} value={choices[group.color]}
              onChange={event => setChoices(current => ({ ...current, [group.color]: event.target.value }))}>
              {group.images.map(image => <Radio key={image.id} value={image.id} className="selection-image-cleanup-choice">
                <Image src={image.url} referrerPolicy="no-referrer" preview={false} fallback={invalidSelectionImage}
                  alt={`${group.color}第 ${images.indexOf(image) + 1} 张`} />
                <span>保留第 {images.indexOf(image) + 1} 张（{group.color}）</span>
              </Radio>)}
            </Radio.Group>
          </section>)}
        </div>
        <p className="selection-image-cleanup-note">确认后自动保存当前图片格，可通过表格的「撤销」恢复。</p>
      </>}
    </Modal>
  </div>;
}
