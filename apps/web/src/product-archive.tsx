import { useQuery } from "@tanstack/react-query";
import { Spin } from "antd";
import { api } from "./api";
import { QueryState, useUser } from "./shared";
import { SelectionWorkspace } from "./selection-workspace";
import { StyleSelectionsPage } from "./style-selections";

export function ProductArchive() {
  const user = useUser();
  const query = useQuery({
    queryKey: ["product-archive-table", user.id],
    queryFn: async () => (await api("/product-archive-table")).data,
    refetchInterval:10000,
  });
  if (query.error)
    return <QueryState error={query.error} reload={() => query.refetch()} />;
  if (!query.data) return <Spin />;
  return (
    <SelectionWorkspace
      key={`${query.data.id}:${query.data.layoutGeneration || 0}`}
      tableId={query.data.id}
      title="商品档案"
      archive
      emptyLayout={query.data.initialLayout === "empty"}
      layoutGeneration={query.data.layoutGeneration}
      defaultColumns={query.data.fields}
      archiveReferences={query.data.references}
      canEdit={query.data.canEdit}
      canManage={query.data.canManage}
    >
      <StyleSelectionsPage />
    </SelectionWorkspace>
  );
}
