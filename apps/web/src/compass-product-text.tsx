import { Fragment } from "react";
import { Popover } from "antd";
import type { CompassImageTarget } from "./compass-product-image";
import { splitProductReferences } from "./compass-product-references";
export { productReferenceTargets } from "./compass-product-references";

export function CompassProductText({
  text,
  targets,
  onPreview,
}: {
  text: string;
  targets: CompassImageTarget[];
  onPreview: (target: CompassImageTarget) => void;
}) {
  return (
    <>
      {splitProductReferences(text, targets).map((part, i) =>
        part.target ? (
          <Popover
            key={i}
            trigger={["hover", "focus"]}
            placement="top"
            mouseEnterDelay={0.15}
            classNames={{ root: "compass-product-image-popover" }}
            content={
              <img
                className="compass-product-image-hover"
                src={part.target.image}
                alt={`商品预览 ${part.target.code}`}
                referrerPolicy="no-referrer"
              />
            }
          >
            <button
              type="button"
              className="compass-product-reference"
              aria-label={`放大图片 ${part.target.code}`}
              onClick={() => onPreview(part.target!)}
            >
              {part.text}
            </button>
          </Popover>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
