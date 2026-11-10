import { expect, test } from "vitest";
import {
  COMPANION_MOUTH_GAZE,
  companionGazeOffset,
  companionMouthOffset,
  lerpGaze,
} from "../../apps/web/src/companion-gaze.js";

const limits = { range: 200, maxX: 8, maxYUp: 6, maxYDown: 2 };

test("gaze stays centred on the origin", () => {
  expect(companionGazeOffset(40, 50, 40, 50, limits)).toEqual({ x: 0, y: 0 });
});

test("gaze looks left and is clamped to the visor", () => {
  const left = companionGazeOffset(0, 50, 40, 50, limits);
  expect(left.x).toBeLessThan(0);
  expect(left.x).toBeGreaterThanOrEqual(-limits.maxX);
  expect(left.y).toBe(0);
  const far = companionGazeOffset(-400, 50, 40, 50, limits);
  expect(far.x).toBeCloseTo(-limits.maxX, 5);
});

test("downward look is tighter so the face stays inside the visor", () => {
  const down = companionGazeOffset(40, 400, 40, 50, limits);
  const up = companionGazeOffset(40, -400, 40, 50, limits);
  expect(down.y).toBeCloseTo(limits.maxYDown, 5);
  expect(up.y).toBeCloseTo(-limits.maxYUp, 5);
  expect(Math.abs(down.y)).toBeLessThan(Math.abs(up.y));
});

test("lerp eases the current offset toward the target", () => {
  expect(lerpGaze(0, 10, 0.2)).toBeCloseTo(2, 8);
  expect(lerpGaze(8, 8, 0.2)).toBe(8);
});

test("the mouth follows the eyes with slightly less travel", () => {
  expect(COMPANION_MOUTH_GAZE).toBe(0.8);
  expect(companionMouthOffset({ x: 10, y: -5 })).toEqual({ x: 8, y: -4 });
});
