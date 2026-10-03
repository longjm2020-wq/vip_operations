import { Button, Modal } from "antd";
import { CloseOutlined } from "@ant-design/icons";
import type { CompetitorProductPreview } from "../../../packages/contracts/src/competitor-analysis";
import { competitorMaterialDisplay } from "./competitor-material-display";

export function CompetitorProductPreviewCard({
  product,
  onClose,
  onPreview,
}: {
  product: CompetitorProductPreview;
  onClose?: () => void;
  onPreview?: () => void;
}) {
  const code = product.styleCode || product.title;
  const material = competitorMaterialDisplay(product.materialInfo);
  const image = (
    <img
      className="competitor-product-preview-image"
      src={product.imageUrl || undefined}
      alt={`商品图片 ${code}`}
      referrerPolicy="no-referrer"
    />
  );
  return (
    <div className="competitor-product-preview-card">
      {onClose && (
        <Button
          type="text"
          shape="circle"
          className="competitor-product-hover-close"
          aria-label="关闭商品卡片"
          icon={<CloseOutlined />}
          onClick={onClose}
        />
      )}
      {onPreview ? (
        <button
          type="button"
          className="competitor-product-preview-enlarge"
          aria-label={`放大图片 ${code}`}
          onClick={onPreview}
        >
          {image}
        </button>
      ) : (
        image
      )}
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
        <a href={product.productUrl} target="_blank" rel="noopener noreferrer">
          查看商品详情
        </a>
      </div>
    </div>
  );
}

export function CompetitorProductPreviewDialog({
  product,
  onClose,
}: {
  product: CompetitorProductPreview | null;
  onClose: () => void;
}) {
  if (!product) return null;
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
      styles={{
        header: { display: "none" },
        container: { padding: 0 },
        close: {
          top: 8,
          right: 8,
          borderRadius: "50%",
          background: "rgba(255, 255, 255, 0.92)",
        },
      }}
    >
      <CompetitorProductPreviewCard product={product} />
    </Modal>
  );
}
