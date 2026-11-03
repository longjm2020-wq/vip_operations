import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopClientRequest,
  isDesktopClient,
} from "../../apps/web/src/desktop-client.js";

function fixture() {
  const messages = new Set<(event: MessageEvent) => void>();
  const leaves = new Set<() => void>();
  const sent: Record<string, string>[] = [];
  const bridge = {
    postMessage: (value: Record<string, string>) => sent.push(value),
    addEventListener: (_event: string, fn: (e: MessageEvent) => void) =>
      messages.add(fn),
    removeEventListener: (_event: string, fn: (e: MessageEvent) => void) =>
      messages.delete(fn),
  };
  vi.stubGlobal("window", {
    xutiDesktop: { version: "1.1.0" },
    chrome: { webview: bridge },
    addEventListener: (_e: string, fn: () => void) => leaves.add(fn),
    removeEventListener: (_e: string, fn: () => void) => leaves.delete(fn),
  });
  return {
    sent,
    messages,
    leaves,
    bridge,
    reply: (data: unknown) =>
      messages.forEach((f) => f({ data } as MessageEvent)),
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("desktop client connection bridge", () => {
  it("does not offer native operations in ordinary browsers", async () => {
    vi.stubGlobal("window", {});
    expect(isDesktopClient()).toBe(false);
    await expect(desktopClientRequest("status")).rejects.toThrow("桌面端");
  });
  it("correlates replies and never accepts another request's response", async () => {
    const f = fixture();
    const promise = desktopClientRequest("status");
    f.reply({ channel: "xuti-desktop", id: "other", ok: true });
    expect(f.messages.size).toBe(1);
    f.reply({
      channel: "xuti-desktop",
      id: f.sent[0].id,
      ok: true,
      data: { version: "1.1.0", connected: true, deviceId: "device-id" },
    });
    await expect(promise).resolves.toEqual({
      version: "1.1.0",
      connected: true,
      deviceId: "device-id",
    });
    expect(f.messages.size).toBe(0);
    expect(f.leaves.size).toBe(0);
  });
  it("sends only a one-use pairing code and cleans up failures", async () => {
    const f = fixture();
    await expect(desktopClientRequest("pair", "invalid")).rejects.toThrow(
      "配对码",
    );
    expect(f.sent).toHaveLength(0);
    const promise = desktopClientRequest("pair", "a".repeat(32));
    expect(Object.keys(f.sent[0]).sort()).toEqual([
      "action",
      "channel",
      "code",
      "id",
    ]);
    f.reply({
      channel: "xuti-desktop",
      id: f.sent[0].id,
      ok: false,
      error: "配对码已失效",
    });
    await expect(promise).rejects.toThrow("已失效");
    expect(f.messages.size).toBe(0);
  });
  it("does not leave pending connections after navigation or timeout", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const leaving = desktopClientRequest("status");
    const handled = expect(leaving).rejects.toThrow("页面已切换");
    f.leaves.forEach((f) => f());
    await handled;
    expect(f.messages.size).toBe(0);
    const timeout = desktopClientRequest("status");
    const timeoutHandled = expect(timeout).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(120000);
    await timeoutHandled;
    expect(f.leaves.size).toBe(0);
  });
  it("rejects malformed native data and a disconnected bridge", async () => {
    const f = fixture();
    const promise = desktopClientRequest("status");
    f.reply({
      channel: "xuti-desktop",
      id: f.sent[0].id,
      ok: true,
      data: { connected: true },
    });
    await expect(promise).rejects.toThrow("返回无效");
    f.bridge.postMessage = () => {
      throw new Error("closed");
    };
    await expect(desktopClientRequest("show-tasks")).rejects.toThrow(
      "重新打开",
    );
    expect(f.messages.size).toBe(0);
  });
});
