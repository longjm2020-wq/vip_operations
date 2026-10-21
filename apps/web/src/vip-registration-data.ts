import { api } from "./api.js";
import { loadRegistrationRows } from "./product-registration-data.js";
import { readVipRegistrationSources } from "./vip-product-registration.js";

export async function loadVipRegistrationSources(
  ids: string[], request: typeof api, references?: Record<string, { id: string; name: string }[]>,
) {
  const { rows, fields } = await loadRegistrationRows(ids, request);
  return readVipRegistrationSources(rows, fields, references);
}
