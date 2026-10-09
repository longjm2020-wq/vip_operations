import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { Alert, App, Button, Space, Spin } from "antd";
import {
  selectionLayoutSchema,
  selectionLayoutSnapshotSchema,
  selectionFieldSchema,
  applySelectionSharedLayout,
  mergeSelectionSharedLayoutDraft,
  selectionSharedLayoutDelta,
  selectionSharedLayoutKeys,
  type SelectionField,
  type SelectionSharedLayout,
  type SelectionLayout,
  type SelectionLayoutSnapshot,
} from "../../../packages/contracts/src/selection-layout.js";
import { useSelectionWorkspace } from "./selection-workspace";
import { useUser } from "./shared";
import {
  browserLayoutStorage,
  claimLegacyLayout,
  readLayoutCache,
  writeLayoutCache,
  pruneSelectionLayoutDraft,
  selectionLayoutDraftMetadata,
  mergeSelectionLayoutSave,
  selectionLayoutVisibilityDraft,
  restrictSelectionReadonlyLayout,
} from "./selection-layout-storage";

type State = {
  preferences: SelectionLayout | null;
  revision: number;
  sharedPreferences: SelectionSharedLayout | null;
  sharedRevision: number;
  canEditShared: boolean;
  initializing: boolean;
  dirty: boolean;
  saving: boolean;
  error: string;
  conflict: SelectionLayoutSnapshot | null;
};
export function useSelectionLayoutPreferences(
  initial: (legacy: boolean) => SelectionLayout,
) {
  const { api, storageKey } = useSelectionWorkspace(),
    user = useUser();
  const { message } = App.useApp();
  const isSuperAdmin = !!user.roleCodes?.includes("SUPER_ADMIN");
  const cacheKey = storageKey(`selection-layout-v2:${user.id}`),
    ownerKey = storageKey("selection-layout-legacy-owner-v1");
  const [state, setState] = useState<State>({
    preferences: null,
    revision: 0,
    sharedPreferences: null,
    sharedRevision: 0,
    canEditShared: false,
    initializing: false,
    dirty: false,
    saving: false,
    error: "",
    conflict: null,
  });
  const current = useRef(state),
    mounted = useRef(false),
    sequence = useRef(0),
    apiRef = useRef(api),
    initialRef = useRef(initial);
  const committed = useRef<SelectionLayoutSnapshot | null>(null),
    inFlight = useRef<Promise<void> | null>(null);
  apiRef.current = api;
  initialRef.current = initial;
  const publish = useCallback(
    (patch: Partial<State>) => {
      current.current = { ...current.current, ...patch };
      const next = current.current;
      if (next.preferences)
        writeLayoutCache(browserLayoutStorage(), cacheKey, {
          preferences: next.preferences,
          revision: next.revision,
          sharedPreferences: next.sharedPreferences,
          sharedRevision: next.sharedRevision,
          canEditShared: next.canEditShared,
          dirty: next.dirty,
        });
      if (mounted.current) setState(next);
    },
    [cacheKey],
  );
  const load = useCallback(async () => {
    const request = ++sequence.current,
      wasReady = !!current.current.preferences;
    try {
      const remote = selectionLayoutSnapshotSchema.parse(
        (
          await apiRef.current(
            "/style-selections/layout-preferences?shared=true",
          )
        ).data,
      );
      if (!mounted.current || request !== sequence.current) return;
      const cache = wasReady
        ? null
        : readLayoutCache(browserLayoutStorage(), cacheKey);
      const legacy = claimLegacyLayout(
        browserLayoutStorage(),
        ownerKey,
        String(user.id),
      );
      const local = cache?.dirty
        ? {
            ...current.current,
            ...cache,
            sharedPreferences: cache.sharedPreferences || null,
            sharedRevision: cache.sharedRevision || 0,
          }
        : current.current;
      if (local.preferences && (local.dirty || local.saving)) {
        const pruned = pruneSelectionLayoutDraft(
          local.preferences,
          remote.preferences,
          String(user.id),
          isSuperAdmin,
        );
        // A stale response may precede an in-flight save. Only remove inaccessible
        // fields until that save has acknowledged its own CAS revisions.
        if (local.saving) {
          publish({ preferences: pruned, canEditShared: remote.canEditShared });
          return;
        }
        const visibilityDraft = selectionLayoutVisibilityDraft(
          pruned,
          committed.current?.preferences || null,
          remote.preferences,
          String(user.id),
          isSuperAdmin,
        );
        const sharedMerge = remote.sharedPreferences
          ? local.sharedPreferences
            ? mergeSelectionSharedLayoutDraft(
                visibilityDraft,
                local.sharedPreferences,
                remote.sharedPreferences,
              )
            : {
                preferences: applySelectionSharedLayout(
                  visibilityDraft,
                  remote.sharedPreferences,
                ),
                conflict: false,
              }
          : { preferences: visibilityDraft, conflict: false };
        let preferences = sharedMerge.preferences;
        const baselineKeys = new Set(
          committed.current?.preferences?.columns.map((field) => field.key) ||
            local.preferences.columns.map((field) => field.key),
        );
        const localKeys = new Set(
          preferences.columns.map((field) => field.key),
        );
        preferences = selectionLayoutDraftMetadata(
          {
            ...preferences,
            columns: [
              ...preferences.columns,
              ...(remote.preferences?.columns || []).filter(
                (field) =>
                  (isSuperAdmin || field.ownerId === String(user.id)) &&
                  field.visibility === "PRIVATE" &&
                  !localKeys.has(field.key) &&
                  !baselineKeys.has(field.key),
              ),
            ],
          },
          remote.preferences,
        );
        const same =
          JSON.stringify(preferences) === JSON.stringify(remote.preferences);
        const conflict =
          sharedMerge.conflict || local.revision !== remote.revision;
        committed.current = remote;
        publish({
          preferences,
          revision: conflict && !same ? local.revision : remote.revision,
          sharedPreferences: remote.sharedPreferences,
          sharedRevision: remote.sharedRevision,
          canEditShared: remote.canEditShared,
          dirty: !same,
          error: same ? "" : local.error,
          conflict: !same && conflict ? remote : null,
        });
      } else if (remote.preferences) {
        committed.current = remote;
        publish({ ...remote, dirty: false, error: "", conflict: null });
      } else {
        committed.current = remote;
        publish({
          preferences: initialRef.current(legacy),
          revision: 0,
          sharedPreferences: remote.sharedPreferences,
          sharedRevision: remote.sharedRevision,
          canEditShared: remote.canEditShared,
          dirty: true,
          error: "",
          conflict: null,
        });
      }
    } catch (error) {
      if (mounted.current && request === sequence.current)
        publish({
          error:
            error instanceof Error ? error.message : "个人设置读取失败，请重试",
        });
    }
  }, [cacheKey, ownerKey, publish, user.id, isSuperAdmin]);
  const flush = useCallback(
    async (keepalive = false): Promise<void> => {
      if (inFlight.current) return await inFlight.current;
      const pending = current.current;
      if (
        !pending.preferences ||
        !pending.dirty ||
        pending.saving ||
        pending.conflict ||
        pending.error
      )
        return;
      sequence.current++;
      const operation = (async () => {
        const preferences = pending.preferences!;
        publish({ saving: true });
        try {
          const sharedChanges =
            pending.canEditShared && pending.sharedPreferences
              ? selectionSharedLayoutDelta(
                  preferences,
                  pending.sharedPreferences,
                )
              : undefined;
          const body = {
            preferences,
            revision: pending.revision,
            sharedRevision: pending.sharedRevision,
            ...(sharedChanges && Object.keys(sharedChanges).length
              ? { sharedChanges }
              : {}),
          };
          const options =
            keepalive &&
            new TextEncoder().encode(JSON.stringify(body)).length < 60000
              ? { keepalive: true }
              : undefined;
          const saved = selectionLayoutSnapshotSchema.parse(
            (
              await apiRef.current(
                "/style-selections/layout-preferences?shared=true",
                "POST",
                body,
                undefined,
                options,
              )
            ).data,
          );
          const unchanged =
            JSON.stringify(current.current.preferences) ===
            JSON.stringify(preferences);
          const currentPreferences = current.current.preferences!,
            savedPreferences = saved.preferences || initialRef.current(false),
            next = unchanged
              ? savedPreferences
              : mergeSelectionLayoutSave(
                  currentPreferences,
                  preferences,
                  savedPreferences,
                  String(user.id),
                  isSuperAdmin,
                );
          committed.current = saved;
          publish({
            preferences: next,
            revision: saved.revision,
            sharedPreferences: saved.sharedPreferences,
            sharedRevision: saved.sharedRevision,
            canEditShared: saved.canEditShared,
            saving: false,
            dirty: JSON.stringify(next) !== JSON.stringify(savedPreferences),
            error: "",
            conflict: null,
          });
        } catch (error) {
          if ((error as { status?: number }).status === 409) {
            try {
              const remote = selectionLayoutSnapshotSchema.parse(
                (
                  await apiRef.current(
                    "/style-selections/layout-preferences?shared=true",
                  )
                ).data,
              );
              // A response lost during navigation may already have saved this exact view.
              if (
                JSON.stringify(remote.preferences) ===
                JSON.stringify(current.current.preferences)
              ) {
                committed.current = remote;
                publish({
                  ...remote,
                  dirty: false,
                  saving: false,
                  error: "",
                  conflict: null,
                });
              } else
                publish({
                  preferences: current.current.preferences
                    ? pruneSelectionLayoutDraft(
                        current.current.preferences,
                        remote.preferences,
                        String(user.id),
                        isSuperAdmin,
                      )
                    : null,
                  conflict: remote,
                  saving: false,
                  error: "",
                });
            } catch {
              publish({
                saving: false,
                error: "无法核对其他设备的设置，请重试",
              });
            }
          } else
            publish({
              saving: false,
              error:
                error instanceof Error
                  ? error.message
                  : "个人设置保存失败，请重试",
            });
        }
      })();
      inFlight.current = operation;
      try {
        await operation;
      } finally {
        if (inFlight.current === operation) inFlight.current = null;
      }
      if (
        !mounted.current &&
        current.current.dirty &&
        !current.current.error &&
        !current.current.conflict
      )
        await flush(true);
    },
    [publish, user.id, isSuperAdmin],
  );
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const ensureSaved = useCallback(async (): Promise<boolean> => {
    // Field registration can already be saving when a cell autosave starts.
    // Wait for the exact request, then save any definitions changed meanwhile.
    for (let pass = 0; pass < 20; pass++) {
      if (inFlight.current) await inFlight.current;
      const pending = current.current;
      if (!pending.preferences || pending.error || pending.conflict)
        return false;
      if (!pending.dirty) return true;
      await flush();
    }
    return (
      !current.current.dirty &&
      !current.current.error &&
      !current.current.conflict
    );
  }, [flush]);
  const setFieldVisibility = useCallback(
    async (field: SelectionField, isPublic: boolean): Promise<void> => {
      if (!(await ensureSaved()))
        throw new Error("请先处理未保存或冲突的字段设置，再修改公开范围");
      const stored = current.current.preferences?.columns.find(
        (column) => column.key === field.key,
      );
      if (!stored?.fieldRevision)
        throw new Error("字段尚未保存，请保存后再修改公开范围");
      const savedField = selectionFieldSchema.parse(
        (
          await apiRef.current(
            `/style-selections/fields/${encodeURIComponent(field.key)}/visibility`,
            "POST",
            { public: isPublic, revision: stored.fieldRevision },
          )
        ).data,
      );
      const preferences = current.current.preferences;
      if (preferences)
        publish({
          preferences: selectionLayoutDraftMetadata(preferences, {
            ...preferences,
            columns: preferences.columns.map((column) =>
              column.key === savedField.key ? savedField : column,
            ),
          }),
        });
      await load();
    },
    [ensureSaved, load, publish],
  );
  const initializeShared = useCallback(async (): Promise<void> => {
    if (
      !current.current.canEditShared ||
      current.current.sharedPreferences ||
      current.current.initializing
    )
      return;
    if (!(await ensureSaved())) return;
    publish({ initializing: true });
    try {
      await apiRef.current(
        "/style-selections/layout-preferences/initialize",
        "POST",
        {},
      );
      await load();
    } catch (error) {
      publish({
        error:
          error instanceof Error ? error.message : "统一字段与布局失败，请重试",
      });
    } finally {
      publish({ initializing: false });
    }
  }, [ensureSaved, load, publish]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const focus = () => {
      if (document.visibilityState !== "hidden" && !current.current.saving)
        void load();
    };
    const online = () => {
      publish({ error: "" });
      if (current.current.preferences) void flushRef.current();
      else void load();
    };
    const leave = () => {
      void flushRef.current(true);
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("online", online);
    window.addEventListener("pagehide", leave);
    const refreshTimer = window.setInterval(focus, 20000);
    return () => {
      mounted.current = false;
      sequence.current++;
      leave();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("online", online);
      window.removeEventListener("pagehide", leave);
      window.clearInterval(refreshTimer);
    };
  }, [load, publish]);
  useEffect(() => {
    if (!state.dirty || state.saving || state.error || state.conflict) return;
    const timer = window.setTimeout(() => void flushRef.current(), 200);
    return () => window.clearTimeout(timer);
  }, [state]);
  const update = useCallback(
    <K extends keyof SelectionLayout>(
      key: K,
      value: SetStateAction<SelectionLayout[K]>,
    ) => {
      const before = current.current.preferences;
      if (!before) return;
      const next =
        typeof value === "function"
          ? (value as (previous: SelectionLayout[K]) => SelectionLayout[K])(
              before[key],
            )
          : value;
      if (JSON.stringify(before[key]) === JSON.stringify(next)) return;
      const proposed = {
        ...before,
        [key]: next,
        ...([
          "searchText",
          "columnFilters",
          "columnSort",
          "groupBy",
          "sort",
          "direction",
        ].includes(key)
          ? { page: 1 }
          : {}),
      };
      let preferences = proposed;
      if (
        current.current.sharedPreferences &&
        !current.current.canEditShared &&
        (selectionSharedLayoutKeys as readonly string[]).includes(key)
      ) {
        const restricted = restrictSelectionReadonlyLayout(
          before,
          proposed,
          String(user.id),
          isSuperAdmin,
        );
        preferences = restricted.preferences;
        if (restricted.blocked)
          message.warning({
            key: "selection-shared-layout-permission",
            content:
              "公开列和公共布局需要表格编辑权限；你仍可设置自己的私有字段。",
          });
      }
      if (JSON.stringify(before) === JSON.stringify(preferences)) return;
      publish({
        preferences,
        dirty: true,
        error: "",
      });
    },
    [publish, message, user.id, isSuperAdmin],
  );
  const setters = useMemo(
    () => ({
      setColumns: (value: SetStateAction<SelectionLayout["columns"]>) =>
        update("columns", value),
      setFixedColumns: (value: SetStateAction<string[]>) =>
        update("fixedColumns", value),
      setColumnGroups: (
        value: SetStateAction<SelectionLayout["columnGroups"]>,
      ) => update("columnGroups", value),
      setColumnGroupId: (value: SetStateAction<string>) =>
        update("columnGroupId", value),
      setSearchText: (value: SetStateAction<string>) =>
        update("searchText", value),
      setColumnFilters: (
        value: SetStateAction<SelectionLayout["columnFilters"]>,
      ) => update("columnFilters", value),
      setColumnSort: (value: SetStateAction<SelectionLayout["columnSort"]>) =>
        update("columnSort", value),
      setFollowShared: (value: SetStateAction<boolean>) =>
        update("followShared", value),
      setGroupBy: (value: SetStateAction<string>) => update("groupBy", value),
      setSort: (value: SetStateAction<string>) => update("sort", value),
      setDirection: (value: SetStateAction<SelectionLayout["direction"]>) =>
        update("direction", value),
      setRowHeight: (value: SetStateAction<SelectionLayout["rowHeight"]>) =>
        update("rowHeight", value),
      setPageSize: (value: SetStateAction<number>) =>
        update("pageSize", (previous) => {
          const next = typeof value === "function" ? value(previous) : value;
          return selectionLayoutSchema.parse({ columns: [], pageSize: next })
            .pageSize;
        }),
      setPage: (value: SetStateAction<number>) => update("page", value),
      setVisible: (value: SetStateAction<string[]>) => {
        const before = current.current.preferences;
        if (!before) return;
        const visible = before.columns
          .filter(
            (column) =>
              !column.deleted && !before.hiddenColumns.includes(column.key),
          )
          .map((column) => column.key);
        const next = typeof value === "function" ? value(visible) : value;
        update(
          "hiddenColumns",
          before.columns
            .filter((column) => !next.includes(column.key))
            .map((column) => column.key),
        );
      },
    }),
    [update],
  );
  const retry = () => {
    publish({ error: "" });
    if (!current.current.preferences) void load();
    else void flush();
  };
  const resolve = (cloud: boolean) => {
    const remote = current.current.conflict;
    if (!remote) return;
    committed.current = remote;
    publish({
      ...(cloud
        ? {
            preferences: remote.preferences || initialRef.current(false),
            dirty: !remote.preferences,
          }
        : {
            preferences: current.current.preferences
              ? selectionLayoutDraftMetadata(
                  pruneSelectionLayoutDraft(
                    current.current.preferences,
                    remote.preferences,
                    String(user.id),
                    isSuperAdmin,
                  ),
                  remote.preferences,
                )
              : remote.preferences,
            dirty: true,
          }),
      revision: remote.revision,
      sharedPreferences: remote.sharedPreferences,
      sharedRevision: remote.sharedRevision,
      canEditShared: remote.canEditShared,
      conflict: null,
      error: "",
    });
  };
  return {
    ...state,
    ...setters,
    update,
    retry,
    resolve,
    refresh: load,
    ensureSaved,
    setFieldVisibility,
    initializeShared,
  };
}
export type SelectionLayoutController = ReturnType<
  typeof useSelectionLayoutPreferences
>;
export function SelectionLayoutStatus({
  layout,
}: {
  layout: SelectionLayoutController;
}) {
  const canInitialize =
    layout.canEditShared && layout.sharedPreferences === null;
  if (!layout.error && !layout.conflict && !canInitialize) return null;
  return (
    <Space
      className="selection-layout-status"
      size="small"
      aria-label="表格设置同步"
      role="status"
    >
      {(layout.error || layout.conflict) && (
        <span>
          {layout.conflict
            ? "其他用户或设备已更新设置"
            : `表格设置未保存：${layout.error}`}
        </span>
      )}
      {canInitialize && (
        <Button
          size="small"
          loading={layout.initializing}
          disabled={layout.saving || !!layout.error || !!layout.conflict}
          onClick={() => void layout.initializeShared()}
        >
          统一当前字段与布局
        </Button>
      )}
      {layout.error && (
        <Button size="small" onClick={layout.retry}>
          重试保存
        </Button>
      )}
      {layout.conflict && (
        <>
          <Button size="small" onClick={() => layout.resolve(true)}>
            使用云端设置
          </Button>
          <Button size="small" onClick={() => layout.resolve(false)}>
            保留当前设置
          </Button>
        </>
      )}
    </Space>
  );
}
export function SelectionLayoutLoading({
  layout,
}: {
  layout: SelectionLayoutController;
}) {
  return layout.error ? (
    <Alert
      type="error"
      title="个人设置读取失败"
      description={layout.error}
      action={<Button onClick={layout.retry}>重新读取</Button>}
    />
  ) : (
    <Spin tip="正在恢复个人设置…">
      <div style={{ minHeight: 160 }} />
    </Spin>
  );
}
