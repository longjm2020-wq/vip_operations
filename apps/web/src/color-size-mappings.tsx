import { QueryClientProvider } from "@tanstack/react-query";
import { Alert, Tabs } from "antd";
import { queryClient } from "./api";
import { MasterPage } from "./master";
import { PageSearchContext } from "./page-search";
import { useCan } from "./shared";

export type MappingTab = "color" | "size";

export function ColorSizeMappings({ tab, onTabChange }: {
  tab: MappingTab;
  onTabChange: (tab: MappingTab) => void;
}) {
  const canRead = useCan("product.read");
  if (!canRead) return <Alert type="warning" showIcon title="查看颜色尺码映射需要商品查看权限，请联系管理员。" />;
  return (
    // Mappings are shared product data, independent of the table's query cache and search.
    <QueryClientProvider client={queryClient}>
      <PageSearchContext.Provider value={null}>
        <div className="color-size-mappings">
          <Tabs
            aria-label="颜色尺码映射"
            activeKey={tab}
            onChange={key => onTabChange(key as MappingTab)}
            items={[
              { key: "color", label: "颜色映射" },
              { key: "size", label: "尺码映射" },
            ]}
          />
          <MasterPage key={tab} resource={`${tab}-mappings`} />
        </div>
      </PageSearchContext.Provider>
    </QueryClientProvider>
  );
}
