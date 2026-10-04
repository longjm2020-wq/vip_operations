import {
  selectionFieldSchema,
  selectionLayoutSchema,
  selectionLayoutSnapshotSchema,
  type SelectionLayout,
  type SelectionLayoutSnapshot,
} from "../../../packages/contracts/src/selection-layout.js";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
export function browserLayoutStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
export type LayoutCache = SelectionLayoutSnapshot & {
  preferences: SelectionLayout;
  dirty: boolean;
};
export function readLayoutCache(
  storage: Storage | undefined,
  key: string,
): LayoutCache | null {
  try {
    const raw = JSON.parse(storage?.getItem(key) || "null");
    const parsed = selectionLayoutSnapshotSchema.safeParse(
      raw && { preferences: raw.preferences, revision: raw.revision },
    );
    return parsed.success && parsed.data.preferences
      ? {
          ...parsed.data,
          preferences: parsed.data.preferences,
          dirty: raw.dirty === true,
        }
      : null;
  } catch {
    return null;
  }
}
export function writeLayoutCache(
  storage: Storage | undefined,
  key: string,
  value: LayoutCache,
) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* Cloud saving still works when browser storage is unavailable. */
  }
}
export function claimLegacyLayout(
  storage: Storage | undefined,
  key: string,
  userId: string,
) {
  try {
    if (!storage) return false;
    const owner = storage.getItem(key);
    if (owner && owner !== userId) return false;
    if (!owner) storage.setItem(key, userId);
    return true;
  } catch {
    return false;
  }
}
export function migrateSelectionLayout(
  columns: unknown[],
  extras: Record<string, unknown>,
): SelectionLayout {
  const seen = new Set<string>();
  const fields = columns.flatMap((value) => {
    const parsed = selectionFieldSchema.safeParse(value);
    if (!parsed.success || seen.has(parsed.data.key)) return [];
    seen.add(parsed.data.key);
    return [parsed.data];
  });
  // Keep valid old fields even when one unrelated legacy setting is damaged.
  const base = selectionLayoutSchema.parse({ columns: fields });
  for (const [key, value] of Object.entries(extras)) {
    const parsed = selectionLayoutSchema.safeParse({ ...base, [key]: value });
    if (parsed.success) Object.assign(base, parsed.data);
  }
  return base;
}
