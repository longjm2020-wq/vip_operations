import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../apps/web/src/api.js", () => ({ api: vi.fn() }));
vi.mock("../../apps/web/src/desktop-client.js", () => ({
  desktopClientRequest: vi.fn(),
}));
import { api } from "../../apps/web/src/api.js";
import { desktopClientRequest } from "../../apps/web/src/desktop-client.js";
import { connectAndAuthorizeDesktop } from "../../apps/web/src/desktop-setup.js";
const deviceId = "55555555-5555-4555-8555-555555555555";
const connected = {
  version: "1.2.1",
  connected: true,
  deviceId,
  authorized: false,
};
const bridge = vi.mocked(desktopClientRequest);
beforeEach(() => vi.resetAllMocks());
describe("single desktop setup flow", () => {
  it("pairs once then opens native consent for exactly that device", async () => {
    bridge
      .mockResolvedValueOnce({ ...connected, connected: false, deviceId: "" })
      .mockResolvedValueOnce(connected)
      .mockResolvedValueOnce({ ...connected, authorized: true });
    vi.mocked(api).mockResolvedValue({ data: { code: "a".repeat(32) } });
    expect((await connectAndAuthorizeDesktop([])).authorized).toBe(true);
    expect(bridge.mock.calls).toEqual([
      ["status"],
      ["pair", "a".repeat(32)],
      ["authorize", deviceId],
    ]);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith(
      "/my-workspace/assistant/desktop/pair-code",
      "POST",
    );
  });
  it("keeps a cancelled connection and can retry without pairing again", async () => {
    bridge.mockResolvedValue(connected);
    expect(await connectAndAuthorizeDesktop([deviceId])).toEqual(connected);
    expect(bridge.mock.calls).toEqual([["status"], ["authorize", deviceId]]);
    expect(api).not.toHaveBeenCalled();
  });
  it("does not prompt again when authorization is remembered", async () => {
    bridge.mockResolvedValue({ ...connected, authorized: true });
    await connectAndAuthorizeDesktop([deviceId]);
    expect(bridge.mock.calls).toEqual([["status"]]);
    expect(api).not.toHaveBeenCalled();
  });
  it("does not authorize an existing connection owned by another account", async () => {
    bridge.mockResolvedValue(connected);
    vi.mocked(api).mockResolvedValue({ data: { devices: [] } });
    await expect(connectAndAuthorizeDesktop([])).rejects.toThrow(
      "不属于当前登录账号",
    );
    expect(bridge.mock.calls).toEqual([["status"]]);
    expect(api).toHaveBeenCalledWith("/my-workspace/assistant/desktop");
  });
  it("refreshes a stale device list before deciding the local connection belongs to another account", async () => {
    bridge.mockResolvedValue({ ...connected, authorized: true });
    vi.mocked(api).mockResolvedValue({ data: { devices: [{ id: deviceId }] } });
    expect((await connectAndAuthorizeDesktop([])).authorized).toBe(true);
    expect(bridge.mock.calls).toEqual([["status"]]);
  });
  it("opens existing controls on an older client without sending an unsupported action", async () => {
    bridge.mockResolvedValue({ version: "1.2.0", connected: true, deviceId });
    expect(
      (await connectAndAuthorizeDesktop([deviceId])).authorized,
    ).toBeUndefined();
    expect(bridge.mock.calls).toEqual([["status"], ["show-tasks"]]);
  });
  it.each(["status", "pair-code", "pair", "authorize"])(
    "stops a superseded account flow after %s without continuing to the next action",
    async (stopAfter) => {
      let current = true;
      bridge.mockImplementation(async (action) => {
        if (action === stopAfter) current = false;
        return action === "status"
          ? { ...connected, connected: false, deviceId: "" }
          : { ...connected, authorized: action === "authorize" };
      });
      vi.mocked(api).mockImplementation(async () => {
        if (stopAfter === "pair-code") current = false;
        return { data: { code: "a".repeat(32) } };
      });
      await expect(
        connectAndAuthorizeDesktop([], () => current),
      ).rejects.toThrow("连接流程已结束");
      const expected =
        stopAfter === "status" || stopAfter === "pair-code"
          ? [["status"]]
          : stopAfter === "pair"
            ? [["status"], ["pair", "a".repeat(32)]]
            : [["status"], ["pair", "a".repeat(32)], ["authorize", deviceId]];
      expect(bridge.mock.calls).toEqual(expected);
      expect(api).toHaveBeenCalledTimes(stopAfter === "status" ? 0 : 1);
    },
  );
});
