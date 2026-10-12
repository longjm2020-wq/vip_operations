import { useState } from "react";
import { Alert, App, Button, Input, Modal, Space } from "antd";
import {
  type CompetitorBrand,
  vipBrandBinding,
  vipSearchUrl,
} from "../../../packages/contracts/src/competitor-analysis";
import { api } from "./api";

export function CompetitorBrandBinding({
  brands,
  onSaved,
}: {
  brands: CompetitorBrand[];
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const [brand, setBrand] = useState<CompetitorBrand | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const parsed = vipBrandBinding(sourceUrl);
  const valid = !!brand && parsed?.name === brand.name;
  async function save() {
    if (!brand || !valid || saving) return;
    setSaving(true);
    setError("");
    try {
      await api(`/analytics/competitors/brands/${brand.id}/binding`, "POST", {
        sourceUrl,
      });
      message.success(`已绑定「${brand.name}」，可以开始采集`);
      setBrand(null);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <Alert
        type="warning"
        title={`这些品牌尚未绑定品牌ID：${brands.map((b) => b.name).join("、")}`}
        description={
          <>
            <p>点击下方按钮，粘贴唯品会官方品牌筛选链接完成绑定后即可采集。</p>
            <Space wrap>
              {brands.map((b) => (
                <Button
                  key={b.id}
                  onClick={() => {
                    setBrand(b);
                    setSourceUrl("");
                    setError("");
                  }}
                >
                  绑定「{b.name}」
                </Button>
              ))}
            </Space>
          </>
        }
      />
      <Modal
        title={`绑定唯品会品牌：${brand?.name || ""}`}
        open={!!brand}
        width={580}
        maskClosable={false}
        onCancel={() => !saving && setBrand(null)}
        okText="保存绑定"
        onOk={() => void save()}
        confirmLoading={saving}
        okButtonProps={{ disabled: !valid }}
        cancelButtonProps={{ disabled: saving }}
      >
        <p>1. 打开官方搜索页，在「品牌」筛选中点击「{brand?.name}」。</p>
        <Button
          href={brand ? vipSearchUrl(brand.name) : undefined}
          target="_blank"
          rel="noopener noreferrer"
        >
          打开唯品会品牌搜索
        </Button>
        <p>2. 确认页面选中的品牌名称正确，复制地址栏的完整链接粘贴到下方。</p>
        <Input.TextArea
          aria-label="唯品会品牌筛选链接"
          placeholder="https://category.vip.com/suggest.php?keyword=…&brand_sn=…"
          value={sourceUrl}
          onChange={(e) => {
            setSourceUrl(e.target.value);
            setError("");
          }}
          autoSize={{ minRows: 2, maxRows: 4 }}
          disabled={saving}
        />
        <p>
          {!sourceUrl.trim()
            ? "保存后共享品牌绑定，并自动使用销量排序链接。"
            : valid
              ? `待绑定品牌：${brand?.name} · 品牌ID：${parsed!.brandSn}`
              : `请使用搜索「${brand?.name}」并选中单个准确品牌后的官方链接，链接需包含 brand_sn。`}
        </p>
        {error && <Alert type="error" title={error} />}
      </Modal>
    </>
  );
}
