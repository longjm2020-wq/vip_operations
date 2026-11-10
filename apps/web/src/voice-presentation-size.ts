/** The whole presentation panel keeps a 21:9 widescreen frame. */
export const presentationAspect = 21 / 9;
export const presentationMinWidth = 360;

/**
 * Width of the 21:9 panel for a viewport. `requested` is the user's resized
 * width (undefined = responsive default: min(72vw, 1100px), at most 60vh tall).
 * A manual resize may grow to 85% of the viewport height, never off-screen.
 */
export function presentationPanelWidth(
  viewport: { width: number; height: number },
  requested?: number,
) {
  const fitWidth = Math.max(0, viewport.width - 24);
  const defaultWidth = Math.min(
    viewport.width * 0.72,
    1100,
    viewport.height * 0.6 * presentationAspect,
  );
  const max = Math.min(fitWidth, viewport.height * 0.85 * presentationAspect);
  const min = Math.min(presentationMinWidth, max);
  const width = requested ?? Math.max(defaultWidth, Math.min(min, fitWidth));
  return Math.round(Math.max(min, Math.min(max, width)));
}

/** Text density scale: more bullets start smaller so nothing needs scrolling. */
export function presentationDensity(bullets: number, titleLength: number) {
  const byBullets =
    bullets <= 3 ? 1 : bullets === 4 ? 0.92 : bullets === 5 ? 0.84 : 0.78;
  return titleLength > 24 ? byBullets * 0.94 : byBullets;
}

/** Text auto-fit range applied to the base typography of a slide. */
export const presentationMaxFit = 1.4;
export const presentationMinFit = 0.5;
