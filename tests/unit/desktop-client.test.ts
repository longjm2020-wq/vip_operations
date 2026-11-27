import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canIndexLocalMedia,
  desktopClientRequest,
  isDesktopClient,
  openLocalMediaIndex,
  prepareLocalMediaExcerpt,
  readLocalMediaFile,
} from "../../apps/web/src/desktop-client.js";

function fixture(localMediaIndex = false) {
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
    xutiDesktop: {
      version: "1.1.0",
      ...(localMediaIndex ? { localMediaIndex: true } : {}),
    },
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

describe("desktop local media index", () => {
  function respond(f: ReturnType<typeof fixture>, data: unknown) {
    f.reply({ channel: "xuti-desktop", id: f.sent.at(-1)?.id, ok: true, data });
  }

  it("requires a current desktop bridge and returns local metadata from the folder picker", async () => {
    fixture();
    expect(canIndexLocalMedia()).toBe(false);
    await expect(openLocalMediaIndex()).rejects.toThrow("更新");

    const f = fixture(true);
    const open = openLocalMediaIndex();
    expect(f.sent[0]).toMatchObject({
      channel: "xuti-desktop",
      action: "media-index-open",
    });
    expect(f.sent[0]).not.toHaveProperty("path");
    const page = {
      indexId: "a".repeat(32),
      folderName: "素材",
      total: 1,
      skipped: 0,
      truncated: false,
      items: [
        {
          id: "b".repeat(32),
          name: "clip.mov",
          relativePath: "01\\clip.mov",
          kind: "video",
          bytes: 64 * 1024 ** 3,
          modifiedAt: "2026-11-28T00:00:00Z",
        },
      ],
    };
    respond(f, page);
    await expect(open).resolves.toEqual(page);
  });

  it("fetches only the bounded one-use native route after selection and preserves native cancellation", async () => {
    const f = fixture(true);
    const fetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "video/mp4", "content-length": "3" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const url = "/__xuti-local-media/" + "c".repeat(32);
    const delivery = {
      url,
      name: "clip-片段.mp4",
      mime: "video/mp4",
      bytes: 3,
    };

    const declined = readLocalMediaFile(
      "a".repeat(32),
      "b".repeat(32),
      50 * 1024 ** 2,
    );
    respond(f, null);
    await expect(declined).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    const invalid = readLocalMediaFile("a".repeat(32), "b".repeat(32), 1);
    respond(f, { ...delivery, url: "https://external.example/clip.mp4" });
    await expect(invalid).rejects.toThrow("返回无效");
    expect(fetch).not.toHaveBeenCalled();

    const selected = prepareLocalMediaExcerpt(
      "a".repeat(32),
      "b".repeat(32),
      12,
      50 * 1024 ** 2,
    );
    expect(f.sent.at(-1)).toMatchObject({
      action: "media-index-excerpt",
      startSeconds: 12,
      maxBytes: 50 * 1024 ** 2,
    });
    respond(f, delivery);
    await expect(selected).resolves.toMatchObject({
      name: "clip-片段.mp4",
      type: "video/mp4",
      size: 3,
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      url,
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
  });
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
  it("opens device-bound native consent and preserves a declined result", async () => {
    const f = fixture();
    const deviceId = "55555555-5555-4555-8555-555555555555";
    await expect(desktopClientRequest("authorize", "bad")).rejects.toThrow(
      "设备无效",
    );
    expect(f.sent).toHaveLength(0);
    const promise = desktopClientRequest("authorize", deviceId);
    expect(f.sent[0]).toMatchObject({ action: "authorize", deviceId });
    expect(f.sent[0]).not.toHaveProperty("enabled");
    f.reply({
      channel: "xuti-desktop",
      id: f.sent[0].id,
      ok: true,
      data: { version: "1.2.1", connected: true, deviceId, authorized: false },
    });
    expect((await promise).authorized).toBe(false);
    expect(f.messages.size).toBe(0);
  });
  it("rejects authorization replies for another device", async () => {
    const f = fixture();
    const promise = desktopClientRequest(
      "authorize",
      "55555555-5555-4555-8555-555555555555",
    );
    f.reply({
      channel: "xuti-desktop",
      id: f.sent[0].id,
      ok: true,
      data: {
        version: "1.2.1",
        connected: true,
        deviceId: "other",
        authorized: true,
      },
    });
    await expect(promise).rejects.toThrow("返回无效");
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
