import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { Alert, Button, Space, Spin } from "antd";
import {
  selectionLayoutSchema,
  selectionLayoutSnapshotSchema,
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
} from "./selection-layout-storage";

type State = {
  preferences: SelectionLayout | null;
  revision: number;
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
  const cacheKey = storageKey(`selection-layout-v2:${user.id}`),
    ownerKey = storageKey("selection-layout-legacy-owner-v1");
  const [state, setState] = useState<State>({
    preferences: null,
    revision: 0,
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
        (await apiRef.current("/style-selections/layout-preferences")).data,
      );
      if (!mounted.current || request !== sequence.current) return;
      if (wasReady && (current.current.dirty || current.current.saving)) return;
      const cache = wasReady
        ? null
        : readLayoutCache(browserLayoutStorage(), cacheKey);
      const legacy = claimLegacyLayout(
        browserLayoutStorage(),
        ownerKey,
        String(user.id),
      );
      if (
        remote.preferences &&
        cache?.dirty &&
        JSON.stringify(cache.preferences) !== JSON.stringify(remote.preferences)
      ) {
        publish({
          preferences: cache.preferences,
          revision: cache.revision,
          dirty: true,
          error: "",
          conflict: cache.revision === remote.revision ? null : remote,
        });
      } else if (remote.preferences) {
        publish({ ...remote, dirty: false, error: "", conflict: null });
      } else {
        publish({
          preferences: cache?.preferences || initialRef.current(legacy),
          revision: 0,
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
  }, [cacheKey, ownerKey, publish, user.id]);
  const flush = useCallback(
    async (keepalive = false): Promise<void> => {
      const pending = current.current;
      if (
        !pending.preferences ||
        !pending.dirty ||
        pending.saving ||
        pending.conflict ||
        pending.error
      )
        return;
      const preferences = pending.preferences;
      publish({ saving: true });
      try {
        const body = { preferences, revision: pending.revision };
        const options =
          keepalive &&
          new TextEncoder().encode(JSON.stringify(body)).length < 60000
            ? { keepalive: true }
            : undefined;
        const saved = selectionLayoutSnapshotSchema.parse(
          (
            await apiRef.current(
              "/style-selections/layout-preferences",
              "POST",
              body,
              undefined,
              options,
            )
          ).data,
        );
        publish({
          revision: saved.revision,
          saving: false,
          dirty:
            JSON.stringify(current.current.preferences) !==
            JSON.stringify(preferences),
          error: "",
        });
      } catch (error) {
        if ((error as { status?: number }).status === 409) {
          try {
            const remote = selectionLayoutSnapshotSchema.parse(
              (await apiRef.current("/style-selections/layout-preferences"))
                .data,
            );
            // A response lost during navigation may already have saved this exact view.
            if (
              JSON.stringify(remote.preferences) ===
              JSON.stringify(current.current.preferences)
            )
              publish({
                ...remote,
                dirty: false,
                saving: false,
                error: "",
                conflict: null,
              });
            else publish({ conflict: remote, saving: false, error: "" });
          } catch {
            publish({ saving: false, error: "无法核对其他设备的设置，请重试" });
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
      if (
        !mounted.current &&
        current.current.dirty &&
        !current.current.error &&
        !current.current.conflict
      )
        await flush(true);
    },
    [publish],
  );
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    mounted.current = true;
    void load();
    const focus = () => {
      if (!current.current.dirty && !current.current.saving) void load();
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
    window.addEventListener("online", online);
    window.addEventListener("pagehide", leave);
    return () => {
      mounted.current = false;
      sequence.current++;
      leave();
      window.removeEventListener("focus", focus);
      window.removeEventListener("online", online);
      window.removeEventListener("pagehide", leave);
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
      publish({
        preferences: {
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
        },
        dirty: true,
        error: "",
      });
    },
    [publish],
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
    publish({
      ...(cloud
        ? {
            preferences: remote.preferences || initialRef.current(false),
            dirty: !remote.preferences,
          }
        : { dirty: true }),
      revision: remote.revision,
      conflict: null,
      error: "",
    });
  };
  return { ...state, ...setters, update, retry, resolve };
}
export type SelectionLayoutController = ReturnType<
  typeof useSelectionLayoutPreferences
>;
export function SelectionLayoutStatus({
  layout,
}: {
  layout: SelectionLayoutController;
}) {
  return (
    <Space
      className="selection-layout-status"
      size="small"
      aria-label="个人设置同步"
      role="status"
    >
      <span>
        {layout.conflict
          ? "其他设备已更新设置"
          : layout.error
            ? `个人设置未保存：${layout.error}`
            : layout.dirty || layout.saving
              ? "个人设置保存中…"
              : "个人设置已同步"}
      </span>
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
