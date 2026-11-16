import { afterEach, expect, test, vi } from "vitest";
import {
  COMPANION_MOUTH_GAZE,
  companionGazeOffset,
  companionMouthOffset,
  lerpGaze,
  companionGazeFactor,
  subscribeCompanionGaze,
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("smoothing takes the same time at different refresh rates without overshooting", () => {
  const advance = (frames: number, ms: number) =>
    Array.from({ length: frames }).reduce<number>(
      (value) => lerpGaze(value, 8, companionGazeFactor(ms)),
      0,
    );
  expect(advance(12, 1000 / 60)).toBeCloseTo(advance(24, 1000 / 120), 8);
  expect(companionGazeFactor(10000)).toBeGreaterThan(0);
  expect(companionGazeFactor(10000)).toBeLessThan(1);
});

test("pointer follow and return both ease smoothly without consulting the system motion preference", () => {
  const fakeWindow = new EventTarget(),
    fakeDocument = new EventTarget();
  Object.assign(fakeWindow, { matchMedia: vi.fn(() => ({ matches: true })) });
  Object.assign(fakeDocument, { hidden: false });
  let now = 100,
    sequence = 0;
  const queued = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queued.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => queued.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const properties = new Map<string, string>();
  const el = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
    style: {
      setProperty: (key: string, value: string) => properties.set(key, value),
      removeProperty: (key: string) => properties.delete(key),
    },
  } as unknown as HTMLElement;
  const frame = () => {
    now += 1000 / 60;
    const pending = [...queued.values()];
    queued.clear();
    pending.forEach((callback) => callback(now));
  };
  const x = () =>
    Number.parseFloat(properties.get("--companion-gaze-x") || "0");
  const dispose = subscribeCompanionGaze(el);
  try {
    const move = new Event("pointermove");
    Object.assign(move, { pointerType: "mouse", clientX: 500, clientY: 97.34 });
    fakeWindow.dispatchEvent(move);
    frame();
    const first = x();
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(8.4);
    frame();
    expect(x()).toBeGreaterThan(first);
    const before = x();
    fakeWindow.dispatchEvent(new Event("blur"));
    frame();
    expect(x()).toBeGreaterThan(0);
    expect(x()).toBeLessThan(before);
    for (let n = 0; n < 50; n++) frame();
    expect(x()).toBe(0);
    expect(
      (fakeWindow as unknown as { matchMedia: ReturnType<typeof vi.fn> })
        .matchMedia,
    ).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
  expect(queued.size).toBe(0);
  expect(properties.size).toBe(0);
});
