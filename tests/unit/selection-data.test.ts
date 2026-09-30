import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../apps/web/src/api.js";
import { fetchSelectionRows } from "../../apps/web/src/selection-data.js";
vi.mock("../../apps/web/src/api.js", () => ({ api: vi.fn() }));
beforeEach(() => vi.mocked(api).mockReset());
it("skips record downloads when the revision is unchanged", async () => {
  const previous = { data: [{ id: "1" }], total: 1, revision: "same" };
  vi.mocked(api).mockResolvedValue({ data: { revision: "same" } });
  expect(await fetchSelectionRows("", "createdAt", "asc", previous)).toBe(previous);
  expect(api).toHaveBeenCalledTimes(1);
});
it("refreshes records after updates or deletions", async () => {
  vi.mocked(api).mockResolvedValueOnce({ data: { revision: "changed" } }).mockResolvedValueOnce({ data: { data: [], index: [], revision: "changed" } });
  expect(await fetchSelectionRows("", "createdAt", "asc", { data: [{ id: "1" }], total: 1, revision: "old" })).toEqual({ data: [], total: 0, revision: "changed", tokens: {} });
  expect(api).toHaveBeenCalledTimes(2);
});
it("merges changed records, removes deleted rows and follows server ordering", async () => {
  const retained = { id: "1", material: "unchanged" };
  vi.mocked(api).mockResolvedValueOnce({ data: { revision: "changed" } }).mockResolvedValueOnce({ data: { revision: "snapshot", index: [{ id: "2", token: "b" }, { id: "1", token: "a" }], data: [{ id: "2", material: "new" }] } });
  const result = await fetchSelectionRows("", "createdAt", "asc", { data: [retained, { id: "3" }], total: 2, revision: "old", tokens: { "1": "a", "3": "c" } });
  expect(result.data).toEqual([{ id: "2", material: "new" }, retained]);
  expect(result.data[1]).toBe(retained);
  expect(result.tokens).toEqual({ "1": "a", "2": "b" });
});
it("falls back only for an unsupported endpoint, not a server failure", async () => {
  vi.mocked(api).mockResolvedValueOnce({ data: { revision: "v" } }).mockRejectedValueOnce({ status: 404 }).mockResolvedValueOnce({ data: [], total: 0 });
  expect((await fetchSelectionRows("")).total).toBe(0);
  vi.mocked(api).mockReset().mockResolvedValueOnce({ data: { revision: "v" } }).mockRejectedValueOnce({ status: 503 });
  await expect(fetchSelectionRows("")).rejects.toEqual({ status: 503 });
  expect(api).toHaveBeenCalledTimes(2);
});
