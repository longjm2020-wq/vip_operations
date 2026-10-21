import { api } from "./api.js";
import { loadRegistrationRows } from "./product-registration-data.js";
import { readJushuitanSources } from "./jushuitan-products.js";
export { loadRegistrationMappings as loadJushuitanMappings } from "./product-registration-data.js";

export async function loadJushuitanSources(
  ids: string[], request: typeof api,
  references?: Record<string, { id: string; name: string }[]>,
) {
  const { rows, fields } = await loadRegistrationRows(ids, request);
  return readJushuitanSources(rows, fields, references);
}
