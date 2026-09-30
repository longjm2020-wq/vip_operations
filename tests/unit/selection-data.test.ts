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
  vi.mocked(api).mockResolvedValueOnce({ data: { revision: "changed" } }).mockResolvedValueOnce({ data: [], total: 0 });
  expect(await fetchSelectionRows("", "createdAt", "asc", { data: [{ id: "1" }], total: 1, revision: "old" })).toEqual({ data: [], total: 0, revision: "changed" });
  expect(api).toHaveBeenCalledTimes(2);
});
