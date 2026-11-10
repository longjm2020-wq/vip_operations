/** Preferred workbench hub sizes, in CSS pixels, before fitting a small stage. */
export const WORKSPACE_HUB_NEST_SIZE = 286;
export const WORKSPACE_HUB_NODE_SIZE = 76;
/** Clear gap between the nest's outer ring and a node's inner edge. */
export const WORKSPACE_HUB_RING_GAP = 36;
/** Halo, focus ring and a little extra so nodes are not clipped. */
export const WORKSPACE_HUB_NODE_PAD = 16;
/** Gap between the top node and the status reminder. */
export const WORKSPACE_HUB_TOAST_GAP = 10;
/** Reserved height of the status reminder chip. */
export const WORKSPACE_HUB_TOAST_BAND = 44;

export const WORKSPACE_HUB_ORBIT_RADIUS =
  WORKSPACE_HUB_NEST_SIZE / 2 +
  WORKSPACE_HUB_NODE_SIZE / 2 +
  WORKSPACE_HUB_RING_GAP;

export const WORKSPACE_HUB_COMPOSITION =
  WORKSPACE_HUB_ORBIT_RADIUS * 2 +
  WORKSPACE_HUB_NODE_SIZE +
  WORKSPACE_HUB_NODE_PAD;

export const WORKSPACE_HUB_SPAN =
  WORKSPACE_HUB_COMPOSITION +
  WORKSPACE_HUB_TOAST_GAP +
  WORKSPACE_HUB_TOAST_BAND;

/** Shift the nest and orbit down so the reminder band sits above the nodes. */
export const WORKSPACE_HUB_NUDGE_Y =
  (WORKSPACE_HUB_TOAST_GAP + WORKSPACE_HUB_TOAST_BAND) / 2;

export type WorkspaceHubMetrics = {
  scale: number;
  nestSize: number;
  nodeSize: number;
  orbitRadius: number;
  ringGap: number;
  adjacentGap: number;
  composition: number;
  span: number;
};

export function workspaceHubScale(width: number, height: number): number {
  const space = Math.min(width, height);
  if (!(space > 0)) return 1;
  return Math.min(1, space / WORKSPACE_HUB_SPAN);
}

export function workspaceHubMetrics(
  width: number,
  height: number,
): WorkspaceHubMetrics {
  const scale = workspaceHubScale(width, height);
  const nestSize = WORKSPACE_HUB_NEST_SIZE * scale;
  const nodeSize = WORKSPACE_HUB_NODE_SIZE * scale;
  const orbitRadius = WORKSPACE_HUB_ORBIT_RADIUS * scale;
  const ringGap = orbitRadius - nestSize / 2 - nodeSize / 2;
  const adjacentGap =
    2 * orbitRadius * Math.sin(Math.PI / 5) - nodeSize;
  return {
    scale,
    nestSize,
    nodeSize,
    orbitRadius,
    ringGap,
    adjacentGap,
    composition:
      orbitRadius * 2 + nodeSize + WORKSPACE_HUB_NODE_PAD * scale,
    span: WORKSPACE_HUB_SPAN * scale,
  };
}
