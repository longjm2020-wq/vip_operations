import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, queryClient } from "./api";

type Workspace = {
  tableId?: string;
  title?: string;
  api: typeof api;
  queryClient: QueryClient;
  storageKey: (key: string) => string;
};
const defaultWorkspace: Workspace = {
  api,
  queryClient,
  storageKey: (key) => key,
};
const WorkspaceContext = createContext(defaultWorkspace);
export const useSelectionWorkspace = () => useContext(WorkspaceContext);
export function SelectionWorkspace({
  tableId,
  title,
  children,
}: {
  tableId?: string;
  title?: string;
  children: ReactNode;
}) {
  const [client] = useState(() =>
    tableId
      ? new QueryClient({
          defaultOptions: {
            queries: { retry: false, staleTime: 10000 },
            mutations: { retry: false },
          },
        })
      : queryClient,
  );
  const workspace = useMemo<Workspace>(
    () => ({
      tableId,
      title,
      queryClient: client,
      api: (path, ...args) =>
        api(
          tableId
            ? `${path}${path.includes("?") ? "&" : "?"}tableId=${encodeURIComponent(tableId)}`
            : path,
          ...args,
        ),
      storageKey: (key) => (tableId ? `project-table:${tableId}:${key}` : key),
    }),
    [tableId, title, client],
  );
  return (
    <WorkspaceContext.Provider value={workspace}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </WorkspaceContext.Provider>
  );
}
