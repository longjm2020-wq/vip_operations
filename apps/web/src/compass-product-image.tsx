import { Image, Popover } from "antd";
import { PictureOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import "./compass-product-image.css";

export type CompassImageTarget = { image: string; code: string };

export function CompassProductImage({
  image,
  code,
  onPreview,
}: {
  image?: string;
  code: string;
  onPreview: (target: CompassImageTarget) => void;
}) {
  const [failedImage, setFailedImage] = useState<string>();
  if (!image || !/^https:\/\//i.test(image) || failedImage === image)
    return (
      <span
        className="compass-product-image-placeholder"
        role="img"
        aria-label={`暂无图片 ${code}`}
      >
        <PictureOutlined aria-hidden="true" />
      </span>
    );
  return (
    <Popover
      trigger={["hover", "focus"]}
      placement="right"
      mouseEnterDelay={0.15}
      classNames={{ root: "compass-product-image-popover" }}
      content={
        <img
          className="compass-product-image-hover"
          src={image}
          alt={`商品预览 ${code}`}
          referrerPolicy="no-referrer"
        />
      }
    >
      <button
        type="button"
        className="compass-image-button"
        aria-label={`放大图片 ${code}`}
        onClick={(event) => {
          event.stopPropagation();
          onPreview({ image, code });
        }}
      >
        <img
          className="compass-product-image-thumb"
          src={image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedImage(image)}
        />
      </button>
    </Popover>
  );
}

export function CompassImagePreview({
  target,
  onClose,
}: {
  target: CompassImageTarget | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!target) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      }
    };
    // The image can open inside a Drawer. Escape should close the image even
    // before the preview animation moves keyboard focus into its dialog.
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [target, onClose]);
  return (
    <Image.PreviewGroup
      items={
        target
          ? [
              {
                src: target.image,
                alt: `商品图片 ${target.code}`,
                referrerPolicy: "no-referrer",
              },
            ]
          : []
      }
      classNames={{ popup: { root: "compass-image-preview" } }}
      preview={{
        open: target !== null,
        onOpenChange: (open) => {
          if (!open) onClose();
        },
      }}
    />
  );
}
