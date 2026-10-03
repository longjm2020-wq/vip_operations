import { Modal } from "antd";
import type { CompetitorProductPreview } from "../../../packages/contracts/src/competitor-analysis";
import { competitorMaterialDisplay } from "./competitor-material-display";

export function CompetitorProductPreviewDialog({
  product,
  onClose,
}: {
  product: CompetitorProductPreview | null;
  onClose: () => void;
}) {
  if (!product) return null;
  const code = product.styleCode || product.title;
  const material = competitorMaterialDisplay(product.materialInfo);
  return (
    <Modal
      title="商品预览"
      open
      centered
      width={400}
      footer={null}
      onCancel={onClose}
      className="competitor-product-preview"
      rootClassName="competitor-product-preview-root"
    >
      <div className="competitor-product-preview-card">
        <img
          className="competitor-product-preview-image"
          src={product.imageUrl || undefined}
          alt={`商品图片 ${code}`}
          referrerPolicy="no-referrer"
        />
        <div className="competitor-product-preview-details">
          <div className="competitor-product-preview-price">
            <span>特卖价</span>
            <strong>
              {product.salePrice == null
                ? "价格未公开"
                : `¥ ${product.salePrice.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`}
            </strong>
          </div>
          <div className="competitor-product-preview-code">
            {product.styleCode ? "款号" : "商品"}：{code}
          </div>
          <h4>详细材质信息</h4>
          <p className="competitor-product-preview-material">
            {material || "材质未公开"}
          </p>
          <a
            href={product.productUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            查看商品详情
          </a>
        </div>
      </div>
    </Modal>
  );
}
