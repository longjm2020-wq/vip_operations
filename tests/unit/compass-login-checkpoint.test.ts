import { afterEach, describe, expect, it, vi } from "vitest";
import { compassLoginCheckpoint } from "../../apps/worker/src/compass-login-checkpoint.js";
afterEach(() => { vi.useRealTimers(); });
describe("responsive login backups", () => {
  it("returns control for a blocked backup, aborts late persistence and keeps one read in flight", async () => {
    vi.useFakeTimers();
    let complete!: () => void; const persist = vi.fn();
    const read = vi.fn(async (signal: AbortSignal) => { await new Promise<void>(resolve => { complete = resolve; }); if (!signal.aborted) persist(); return { active: true, expiresAtMs: 100 }; });
    const backups = compassLoginCheckpoint(read, 100), pending = backups.run();
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBeNull(); expect(await backups.run()).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    complete(); await vi.advanceTimersByTimeAsync(0); expect(persist).not.toHaveBeenCalled();
  });
  it("allows a new browser backup after restart without a late old read clearing it", async () => {
    let first!: () => void, second!: () => void; const signals: AbortSignal[] = [];
    const backups = compassLoginCheckpoint(async signal => { signals.push(signal); await new Promise<void>(resolve => { if (signals.length === 1) first = resolve; else second = resolve; }); return { active: true, expiresAtMs: 100 }; });
    const old = backups.run(); backups.cancel(); const fresh = backups.run();
    expect(signals[0].aborted).toBe(true); first(); await old;
    expect(await backups.run()).toBeNull(); expect(signals).toHaveLength(2);
    second(); expect(await fresh).toEqual({ active: true, expiresAtMs: 100 });
  });
  it("still surfaces permission and persistence failures rather than claiming a saved login", async () => {
    const backups = compassLoginCheckpoint(async () => { throw Error("synthetic denied"); });
    await expect(backups.run()).rejects.toThrow("synthetic denied");
  });
});
