import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, queryClient } from "./api";
import { UserContext, useUser } from "./shared";
import { tableSelectionPermissions } from "../../../packages/contracts/src/table-permissions";

type Workspace = {
  tableId?: string;
  title?: string;
  blankLayout?: boolean;
  emptyLayout?: boolean;
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
  blankLayout = false,
  emptyLayout = false,
  children,
}: {
  tableId?: string;
  title?: string;
  blankLayout?: boolean;
  emptyLayout?: boolean;
  children: ReactNode;
}) {
  const user = useUser();
  const scopedUser = useMemo(() => tableId
    ? { ...user, permissions: tableSelectionPermissions(user.permissions) }
    : user, [tableId, user]);
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
      blankLayout,
      emptyLayout,
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
    [tableId, title, blankLayout, emptyLayout, client],
  );
  return (
    <WorkspaceContext.Provider value={workspace}>
      <UserContext.Provider value={scopedUser}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </UserContext.Provider>
    </WorkspaceContext.Provider>
  );
}
