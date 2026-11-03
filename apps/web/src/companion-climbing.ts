export type ClimbSide = "left" | "right";
export type ClimbTarget = {
  element: HTMLElement;
  side: ClimbSide;
  compact: boolean;
  x: number;
  fromY: number;
  y: number;
  offsetY: number;
};

const targetSelector = [
  ".personal-workspace-panel:not([hidden])",
  ".workspace-hologram",
  ".ant-drawer-open .ant-drawer-section",
  ".ant-drawer-open .ant-drawer-content",
  ".ant-modal-wrap .ant-modal-container",
  ".ant-modal-wrap .ant-modal-content",
  ".ant-card",
].join(",");
const controlsSelector =
  "button, a, input, textarea, select, [contenteditable=true], [role=button], [role=slider], .workspace-voice-slot";
const visible = (element: HTMLElement) => {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return (
    !element.closest("[hidden], [inert], [aria-hidden=true]") &&
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    Number(style.opacity) > 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.left < innerWidth &&
    rect.bottom > 0 &&
    rect.top < innerHeight
  );
};
const controlAreas = () =>
  [...document.querySelectorAll<HTMLElement>(controlsSelector)]
    .filter(
      (node) => !node.closest(".workspace-companion-host") && visible(node),
    )
    .map((node) => node.getBoundingClientRect());
const clear = (
  x: number,
  y: number,
  width: number,
  height: number,
  areas: DOMRect[],
) =>
  !areas.some(
    (r) =>
      x < r.right + 5 &&
      x + width > r.left - 5 &&
      y < r.bottom + 5 &&
      y + height > r.top - 5,
  );

function foreground(element: HTMLElement) {
  const r = element.getBoundingClientRect();
  const x = Math.max(8, Math.min(innerWidth - 8, (r.left + r.right) / 2));
  const y = Math.max(8, Math.min(innerHeight - 8, (r.top + r.bottom) / 2));
  const first = document
    .elementsFromPoint(x, y)
    .find((node) => !node.closest(".workspace-companion-host"));
  return !!first && (first === element || element.contains(first));
}

/** Only visible, already authorized UI surfaces are inspected; no component is clicked. */
export function findClimbTarget(
  origin: { x: number; y: number },
  nearOnly = false,
): ClimbTarget | undefined {
  const candidates: (ClimbTarget & { distance: number })[] = [];
  const areas = controlAreas();
  const elements = [
    ...new Set(document.querySelectorAll<HTMLElement>(targetSelector)),
  ].filter((element) => visible(element) && foreground(element));
  for (const compact of innerWidth < 600 ? [true] : [false, true]) {
    const width = compact ? 64 : 132,
      height = compact ? 58 : 118;
    for (const element of elements) {
      const r = element.getBoundingClientRect();
      if (r.width < 180 || r.height < 170) continue;
      for (const side of ["left", "right"] as const) {
        const x = Math.max(
          8,
          Math.min(
            innerWidth - width - 8,
            side === "left" ? r.left - width + 8 : r.right - 8,
          ),
        );
        if (
          nearOnly &&
          (Math.abs(origin.x - x) > 68 ||
            origin.y + height < r.top ||
            origin.y > r.bottom)
        )
          continue;
        const top = Math.max(8, r.top + 54);
        const bottom = Math.min(
          innerHeight - height - 8,
          r.bottom - height - 20,
        );
        for (let y = top; y <= bottom - 35; y += 24) {
          const fromY = Math.min(bottom, y + 112);
          if (!clear(x, y, width, fromY - y + height, areas)) continue;
          candidates.push({
            element,
            side,
            compact,
            x,
            fromY,
            y,
            offsetY: y - r.top,
            distance: Math.hypot(origin.x - x, origin.y - fromY),
          });
          break;
        }
      }
    }
    // Keep the full-size character whenever a safe full-size path exists.
    if (candidates.length) break;
  }
  return candidates.sort((a, b) => a.distance - b.distance)[0];
}

export function climbRestPosition(target: ClimbTarget) {
  if (
    !target.element.isConnected ||
    !visible(target.element) ||
    !foreground(target.element)
  )
    return null;
  const r = target.element.getBoundingClientRect();
  const width = target.compact ? 64 : 132,
    height = target.compact ? 58 : 118;
  const x = Math.max(
    8,
    Math.min(
      innerWidth - width - 8,
      target.side === "left" ? r.left - width + 8 : r.right - 8,
    ),
  );
  const y = Math.max(
    8,
    Math.min(innerHeight - height - 8, r.top + target.offsetY),
  );
  return clear(x, y, width, height, controlAreas()) ? { x, y } : null;
}
