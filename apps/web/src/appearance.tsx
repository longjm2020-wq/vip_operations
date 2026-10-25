import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { Button, ConfigProvider, Tooltip } from "antd";
import { MoonOutlined, SunOutlined, ReloadOutlined } from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  appearanceSchema,
  type Appearance,
  type ThemeMode,
} from "../../../packages/contracts/src/appearance";
import { api, queryClient } from "./api";
import { appThemes } from "./workspace-theme";
import "./theme.css";

const AppearanceContext = createContext({
  mode: "dark" as ThemeMode,
  busy: false,
  error: "",
  toggle: () => {},
  retry: () => {},
});
const storageKey = (accountId: string | null) =>
  `xuti:appearance:${accountId || "guest"}`;
function cachedMode(accountId: string | null): ThemeMode {
  try {
    return localStorage.getItem(storageKey(accountId)) === "light"
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}
function cacheMode(accountId: string | null, mode: ThemeMode) {
  try {
    localStorage.setItem(storageKey(accountId), mode);
  } catch {
    /* The server remains authoritative when browser storage is unavailable. */
  }
}

// Keyed by authenticated account, never by route: changing theme preserves page drafts.
export function AppearanceProvider({
  accountId,
  children,
}: {
  accountId: string | null;
  children: ReactNode;
}) {
  const [localMode, setLocalMode] = useState(() => cachedMode(accountId));
  const [optimistic, setOptimistic] = useState<ThemeMode | null>(null);
  const [error, setError] = useState("");
  const queryKey = ["appearance", accountId];
  const preference = useQuery({
    queryKey,
    enabled: !!accountId && optimistic === null,
    queryFn: async ({ signal }) =>
      appearanceSchema.parse(
        (
          await api("/my-workspace/appearance", "GET", undefined, undefined, {
            signal,
          })
        ).data,
      ),
    refetchOnWindowFocus: "always",
    refetchInterval: 60_000,
  });
  const save = useMutation({
    mutationFn: async (input: Appearance) =>
      appearanceSchema.parse(
        (await api("/my-workspace/appearance", "POST", input)).data,
      ),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      setError("");
      setOptimistic(input.mode);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKey, saved);
      cacheMode(accountId, saved.mode);
    },
    onError: async (reason: Error & { status?: number }) => {
      setError(
        reason.status === 409
          ? "主题已在其他设备更新，请再次选择"
          : "主题保存未确认，已重新读取；请检查后重试",
      );
      // A lost response may have committed. Read the authoritative version before retrying.
      await preference.refetch();
    },
    onSettled: () => setOptimistic(null),
  });
  const mode = optimistic || preference.data?.mode || localMode;
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
  }, [mode]);
  useEffect(() => {
    if (preference.data) cacheMode(accountId, preference.data.mode);
  }, [accountId, preference.data]);
  useEffect(() => {
    const refresh = () => {
      if (accountId)
        void queryClient.invalidateQueries({
          queryKey: ["appearance", accountId],
        });
    };
    const sync = (event: StorageEvent) => {
      if (event.key !== storageKey(accountId)) return;
      if (accountId)
        void queryClient.invalidateQueries({
          queryKey: ["appearance", accountId],
        });
      else setLocalMode(cachedMode(null));
    };
    window.addEventListener("storage", sync);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("focus", refresh);
    };
  }, [accountId]);
  const busy = save.isPending || (!!accountId && preference.isPending);
  const readError =
    accountId && preference.isError ? "主题设置读取失败，点击重试" : "";
  const retry = () => {
    setError("");
    void preference.refetch();
  };
  const toggle = () => {
    if (busy) return;
    if (readError) return retry();
    const next = mode === "dark" ? "light" : "dark";
    if (accountId && preference.data)
      save.mutate({ mode: next, version: preference.data.version });
    else {
      setLocalMode(next);
      cacheMode(null, next);
    }
  };
  return (
    <AppearanceContext.Provider
      value={{ mode, busy, error: readError || error, toggle, retry }}
    >
      <ConfigProvider
        button={{ autoInsertSpace: false }}
        locale={zhCN}
        theme={appThemes[mode]}
      >
        {children}
      </ConfigProvider>
    </AppearanceContext.Provider>
  );
}

export function ThemeToggle({ standalone = false }: { standalone?: boolean }) {
  const { mode, busy, error, toggle, retry } = useContext(AppearanceContext);
  const label = mode === "dark" ? "切换为亮色主题" : "切换为暗色主题";
  return (
    <div
      className={`theme-control${standalone ? " theme-control-standalone" : ""}`}
    >
      <Tooltip title={busy ? "正在同步主题设置" : label}>
        <Button
          className="theme-toggle"
          aria-label={label}
          icon={mode === "dark" ? <SunOutlined /> : <MoonOutlined />}
          loading={busy}
          onClick={toggle}
        />
      </Tooltip>
      {error && (
        <div className="theme-error" role="alert">
          <span>{error}</span>
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            onClick={retry}
          >
            重新读取
          </Button>
        </div>
      )}
    </div>
  );
}
