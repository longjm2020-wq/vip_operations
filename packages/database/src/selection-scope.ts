import { AsyncLocalStorage } from "node:async_hooks";
import type { Tx } from "./index.js";

// Request-local selection workspace. Only the selection controllers enter a scope.
// Schemas contain selection tables only; users, audit and authentication stay public.
export const selectionScope = new AsyncLocalStorage<string>();
export const selectionGuard = new AsyncLocalStorage<(tx: Tx) => Promise<void>>();
export const selectionSchema = (id: string) => {
  if (!/^[1-9]\d{0,18}$/.test(id))
    throw new Error("Invalid selection table ID");
  return `selection_table_${id}`;
};
export function selectionUrl(path: string) {
  const id = selectionScope.getStore();
  return id ? `${path}${path.includes("?") ? "&" : "?"}tableId=${id}` : path;
}
