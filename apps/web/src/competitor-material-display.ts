const materialPart =
  "袖子面料|主面料|副面料|面料成分|里料成分|面料|里料|填充物|填充料|衬里|配料";

function isColorName(value: string) {
  return /(?:色|白|黑|灰|红|蓝|绿|紫|黄|橙|粉|棕|褐|咖|驼|金|银|杏|卡其)$/.test(
    value.trim(),
  );
}

/** Hide color qualifiers in material labels without changing the source or composition. */
export function competitorMaterialDisplay(value: string) {
  const partLabel = new RegExp(`^(.+?)(?:的)?(${materialPart})$`);
  return value
    .replace(
      /([【[(])([^【】()[\]\r\n]{1,80})([】)\]])/g,
      (label, open: string, text: string, close: string) => {
        const match = text.trim().match(partLabel);
        return match && isColorName(match[1])
          ? `${open}${match[2]}${close}`
          : label;
      },
    )
    .replace(
      new RegExp(
        `(^|[\\s；;。])([\\p{Script=Han}/、]{1,20}?)(?:的)?\\s+(${materialPart})(?=[：:])`,
        "gu",
      ),
      (label, space: string, color: string, part: string) =>
        isColorName(color) ? `${space}${part}` : label,
    )
    .replace(
      new RegExp(
        `(^|[\\s；;。])([\\p{Script=Han}/、]{1,40}?)[：:]\\s*(?=(?:${materialPart})[：:])`,
        "gu",
      ),
      (label, space: string, color: string) =>
        isColorName(color) ? space : label,
    )
    .trim();
}
