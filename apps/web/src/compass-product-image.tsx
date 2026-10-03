import { Image, Popover } from "antd";
import { PictureOutlined } from "@ant-design/icons";
import { useLayoutEffect, useRef, useState } from "react";
import "./compass-product-image.css";

export type CompassImageTarget = { image: string; code: string };

export function CompassProductImage({
  image,
  code,
  onPreview,
  onHover,
  hoverPreview = true,
}: {
  image?: string;
  code: string;
  onPreview: (target: CompassImageTarget) => void;
  onHover?: () => void;
  hoverPreview?: boolean;
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
      open={hoverPreview ? undefined : false}
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
        onMouseEnter={onHover}
        onFocus={onHover}
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
  const onCloseRef = useRef(onClose);
  const open = target !== null;
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = document.activeElement;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
      }
    };
    // Install before the preview paints, and handle Escape before either
    // the Drawer or image portal processes it during its focus animation.
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("keydown", escape, true);
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, [open]);
  // Remove the portal when closing so a canceled enter animation cannot
  // leave an invisible mask blocking the report underneath it.
  if (!target) return null;
  return (
    <Image.PreviewGroup
      items={[
        {
          src: target.image,
          alt: `商品图片 ${target.code}`,
          referrerPolicy: "no-referrer",
        },
      ]}
      classNames={{ popup: { root: "compass-image-preview" } }}
      preview={{
        open: true,
        onOpenChange: (open) => {
          if (!open) onClose();
        },
      }}
    />
  );
}
