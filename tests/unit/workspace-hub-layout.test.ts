import { describe, expect, test } from "vitest";
import {
  WORKSPACE_HUB_NEST_SIZE,
  WORKSPACE_HUB_NODE_PAD,
  WORKSPACE_HUB_NODE_SIZE,
  WORKSPACE_HUB_ORBIT_RADIUS,
  WORKSPACE_HUB_RING_GAP,
  WORKSPACE_HUB_SPAN,
  workspaceHubMetrics,
} from "../../apps/web/src/workspace-hub-layout.js";

describe("workspace hub orbit keeps a clear gap around the nest", () => {
  test("preferred orbit sits outside the nest plus a generous ring gap", () => {
    expect(WORKSPACE_HUB_ORBIT_RADIUS).toBe(
      WORKSPACE_HUB_NEST_SIZE / 2 +
        WORKSPACE_HUB_NODE_SIZE / 2 +
        WORKSPACE_HUB_RING_GAP,
    );
    expect(WORKSPACE_HUB_RING_GAP).toBeGreaterThanOrEqual(36);
    const preferred = workspaceHubMetrics(1920, 1080);
    expect(preferred.scale).toBe(1);
    expect(preferred.orbitRadius).toBe(217);
    expect(preferred.ringGap).toBe(36);
    expect(preferred.adjacentGap).toBeGreaterThan(80);
  });

  test("a short stage scales nest, mascot slot and nodes together instead of collapsing into the nest", () => {
    const laptop = workspaceHubMetrics(1024, 380);
    const narrow = workspaceHubMetrics(390, 320);
    for (const current of [laptop, narrow]) {
      expect(current.scale).toBeLessThan(1);
      expect(current.ringGap).toBeCloseTo(
        WORKSPACE_HUB_RING_GAP * current.scale,
        8,
      );
      expect(current.ringGap).toBeGreaterThan(16);
      expect(current.adjacentGap).toBeGreaterThan(24);
      expect(current.composition).toBeLessThanOrEqual(current.span + 1e-6);
      expect(current.span).toBeLessThanOrEqual(
        Math.min(
          current === laptop ? 1024 : 390,
          current === laptop ? 380 : 320,
        ) + 1e-6,
      );
    }
    expect(laptop.nestSize / laptop.nodeSize).toBeCloseTo(
      WORKSPACE_HUB_NEST_SIZE / WORKSPACE_HUB_NODE_SIZE,
    );
  });

  test("a large stage keeps the preferred composition and does not overflow", () => {
    const wide = workspaceHubMetrics(1920, 1080);
    expect(wide.composition).toBe(
      WORKSPACE_HUB_ORBIT_RADIUS * 2 +
        WORKSPACE_HUB_NODE_SIZE +
        WORKSPACE_HUB_NODE_PAD,
    );
    expect(wide.span).toBe(WORKSPACE_HUB_SPAN);
    expect(wide.span).toBeLessThan(1080);
  });
});
