import {
  selectionFieldSchema,
  selectionLayoutSchema,
  selectionLayoutSnapshotSchema,
  applySelectionSharedLayout,
  mergeSelectionSharedLayoutDraft,
  projectSelectionSharedLayout,
  selectionSharedLayoutKeys,
  type SelectionLayout,
  type SelectionLayoutSnapshot,
  selectionSharedLayoutDelta,
} from "../../../packages/contracts/src/selection-layout.js";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
export function browserLayoutStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
export type LayoutCache = Pick<SelectionLayoutSnapshot, "revision"> &
  Partial<
    Pick<
      SelectionLayoutSnapshot,
      "sharedRevision" | "sharedPreferences" | "canEditShared"
    >
  > & {
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
      raw && {
        preferences: raw.preferences,
        revision: raw.revision,
        sharedRevision: raw.sharedRevision,
        sharedPreferences: raw.sharedPreferences,
        canEditShared: raw.canEditShared,
      },
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

/** Remove revoked definitions even when a cached view still has unsaved changes. */
export function pruneSelectionLayoutDraft(
  local: SelectionLayout,
  remote: SelectionLayout | null,
  userId: string,
  isSuperAdmin = false,
): SelectionLayout {
  const remoteKeys = new Set(remote?.columns.map((field) => field.key) || []);
  const columns = local.columns.filter((field) => {
    if (!field.ownerId) return true;
    if (field.ownerId !== userId)
      return (
        (isSuperAdmin || field.visibility === "PUBLIC") &&
        remoteKeys.has(field.key)
      );
    return !field.fieldRevision || remoteKeys.has(field.key);
  });
  const removed = new Set(
    local.columns
      .filter((field) => !columns.includes(field))
      .map((field) => field.key),
  );
  const references = (keys: string[]) =>
    keys.filter((key) => !removed.has(key));
  const columnGroups = local.columnGroups.flatMap((group) => {
    const columnKeys = references(group.columnKeys);
    return columnKeys.length ? [{ ...group, columnKeys }] : [];
  });
  return selectionLayoutSchema.parse({
    ...local,
    columns,
    hiddenColumns: references(local.hiddenColumns),
    fixedColumns: references(local.fixedColumns),
    columnGroups,
    columnGroupId: columnGroups.some(
      (group) => group.id === local.columnGroupId,
    )
      ? local.columnGroupId
      : "",
    organization: {
      groups: references(local.organization.groups),
      sorts: references(local.organization.sorts),
    },
    columnFilters: Object.fromEntries(
      Object.entries(local.columnFilters).filter(([key]) => !removed.has(key)),
    ),
    columnSort:
      local.columnSort && removed.has(local.columnSort.key)
        ? null
        : local.columnSort,
  });
}

/** Refresh server ownership/CAS metadata without replacing a field being edited. */
export function selectionLayoutDraftMetadata(
  local: SelectionLayout,
  remote: SelectionLayout | null,
): SelectionLayout {
  const fields = new Map(remote?.columns.map((field) => [field.key, field]));
  return {
    ...local,
    columns: local.columns.map((field) => {
      const canonical = fields.get(field.key);
      return canonical
        ? {
            ...field,
            ownerId: canonical.ownerId,
            visibility: canonical.visibility,
            fieldRevision: canonical.fieldRevision,
          }
        : field;
    }),
  };
}

/** A visibility transition must not discard an accessible private field draft. */
export function selectionLayoutVisibilityDraft(
  local: SelectionLayout,
  base: SelectionLayout | null,
  remote: SelectionLayout | null,
  userId: string,
  isSuperAdmin = false,
): SelectionLayout {
  const remoteFields = new Map(
    remote?.columns.map((field) => [field.key, field]),
  );
  const baseFields = new Map(base?.columns.map((field) => [field.key, field]));
  const semantic = (field: SelectionLayout["columns"][number]) => {
    const {
      ownerId: _owner,
      visibility: _visibility,
      fieldRevision: _revision,
      ...definition
    } = field;
    return JSON.stringify(definition);
  };
  return {
    ...local,
    columns: local.columns.map((field) => {
      const canonical = remoteFields.get(field.key);
      if (!canonical || (!isSuperAdmin && canonical.ownerId !== userId))
        return field;
      if (canonical.visibility === "PRIVATE")
        return { ...field, visibility: "PRIVATE" };
      const previous = baseFields.get(field.key);
      if (
        field.visibility === "PRIVATE" &&
        canonical.visibility === "PUBLIC" &&
        (!previous || semantic(previous) !== semantic(field))
      )
        return {
          ...field,
          visibility: "PUBLIC",
          ownerId: canonical.ownerId,
          fieldRevision: canonical.fieldRevision,
        };
      return field;
    }),
  };
}

/** A viewer may maintain private layout and owned definitions, but not public layout. */
export function restrictSelectionReadonlyLayout(
  before: SelectionLayout,
  proposed: SelectionLayout,
  userId: string,
  isSuperAdmin = false,
): { preferences: SelectionLayout; blocked: boolean } {
  const baseline = projectSelectionSharedLayout(before);
  const proposedFields = new Map(
    proposed.columns.map((field) => [field.key, field]),
  );
  const canDefine = (field: SelectionLayout["columns"][number]) =>
    !!field.ownerId && (field.ownerId === userId || isSuperAdmin);
  const allowedPublic = {
    ...baseline,
    columns: baseline.columns.map((field) => {
      const definition = proposedFields.get(field.key);
      return definition && canDefine(field)
        ? {
            ...definition,
            width: field.width,
            ownerId: field.ownerId,
            visibility: field.visibility,
            fieldRevision: field.fieldRevision,
          }
        : field;
    }),
  };
  // Removing a creator's definition also removes its display references; this
  // is part of the allowed deletion, rather than a public layout change.
  const ownedDeleted = new Set(
    allowedPublic.columns
      .filter((field) => field.deleted && canDefine(field))
      .map((field) => field.key),
  );
  for (const name of ["hiddenColumns", "fixedColumns"] as const)
    allowedPublic[name] = [
      ...baseline[name].filter((key) => !ownedDeleted.has(key)),
      ...proposed[name].filter((key) => ownedDeleted.has(key)),
    ];
  const privateKeys = new Set(
    proposed.columns
      .filter((field) => field.visibility === "PRIVATE")
      .map((field) => field.key),
  );
  const previousGroups = new Map(
    before.columnGroups.map((group) => [group.id, group]),
  );
  const normalized = {
    ...proposed,
    columnGroups: proposed.columnGroups.map((group) => {
      const previous = previousGroups.get(group.id);
      // A personal group cannot become a new shared group by removing its last
      // private field. Keep that draft until an editor can make it public.
      return previous &&
        previous.columnKeys.some((key) => privateKeys.has(key)) &&
        !group.columnKeys.some((key) => privateKeys.has(key))
        ? previous
        : group;
    }),
  };
  return {
    preferences: applySelectionSharedLayout(normalized, allowedPublic),
    blocked:
      Object.keys(selectionSharedLayoutDelta(proposed, allowedPublic)).length >
      0,
  };
}

/** Acknowledging a save must retain edits typed while that request was in flight. */
export function mergeSelectionLayoutSave(
  current: SelectionLayout,
  sent: SelectionLayout,
  saved: SelectionLayout,
  userId: string,
  isSuperAdmin = false,
): SelectionLayout {
  const equal = (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right);
  const draft = pruneSelectionLayoutDraft(current, saved, userId, isSuperAdmin);
  const sentFields = new Map(sent.columns.map((field) => [field.key, field]));
  const savedFields = new Map(saved.columns.map((field) => [field.key, field]));
  const columns = draft.columns.map((field) => {
    const canonical = savedFields.get(field.key);
    return canonical && equal(field, sentFields.get(field.key))
      ? canonical
      : field;
  });
  const keys = new Set(columns.map((field) => field.key));
  columns.push(
    ...saved.columns.filter(
      (field) =>
        field.visibility === "PRIVATE" &&
        !keys.has(field.key) &&
        !sentFields.has(field.key),
    ),
  );
  const personal = { ...saved, columns };
  for (const key of Object.keys(current) as (keyof SelectionLayout)[])
    if (
      !(selectionSharedLayoutKeys as readonly string[]).includes(key) &&
      !equal(current[key], sent[key])
    )
      Object.assign(personal, { [key]: current[key] });
  const merged = mergeSelectionSharedLayoutDraft(
    personal,
    sent,
    saved,
  ).preferences;
  return selectionLayoutSchema.parse(
    selectionLayoutDraftMetadata(
      applySelectionSharedLayout(merged, projectSelectionSharedLayout(merged)),
      saved,
    ),
  );
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
