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
import {
  archiveSelectionPermissions,
  tableSelectionPermissions,
} from "../../../packages/contracts/src/table-permissions";
import type { SelectionField } from "../../../packages/contracts/src/selection-layout";

type Workspace = {
  tableId?: string;
  title?: string;
  blankLayout?: boolean;
  emptyLayout?: boolean;
  archive?: boolean;
  defaultColumns?: SelectionField[];
  archiveReferences?: Record<
    string,
    { id: string; name: string; status: string; hasChildren?: boolean }[]
  >;
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
  layoutGeneration = 0,
  archive = false,
  defaultColumns,
  archiveReferences,
  children,
}: {
  tableId?: string;
  title?: string;
  blankLayout?: boolean;
  emptyLayout?: boolean;
  layoutGeneration?: number;
  archive?: boolean;
  defaultColumns?: SelectionField[];
  archiveReferences?: Workspace["archiveReferences"];
  children: ReactNode;
}) {
  const user = useUser();
  const scopedUser = useMemo(
    () =>
      tableId
        ? {
            ...user,
            permissions: (archive
              ? archiveSelectionPermissions
              : tableSelectionPermissions)(user.permissions),
          }
        : user,
    [tableId, archive, user],
  );
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
      archive,
      defaultColumns,
      archiveReferences,
      queryClient: client,
      api: (path, ...args) =>
        api(
          tableId
            ? `${path}${path.includes("?") ? "&" : "?"}tableId=${encodeURIComponent(tableId)}`
            : path,
          ...args,
        ),
      storageKey: (key) =>
        tableId
          ? `project-table:${tableId}:${layoutGeneration > 0 ? `generation:${layoutGeneration}:` : ""}${key}`
          : key,
    }),
    [
      tableId,
      title,
      blankLayout,
      emptyLayout,
      layoutGeneration,
      archive,
      defaultColumns,
      archiveReferences,
      client,
    ],
  );
  return (
    <WorkspaceContext.Provider value={workspace}>
      <UserContext.Provider value={scopedUser}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </UserContext.Provider>
    </WorkspaceContext.Provider>
  );
}
