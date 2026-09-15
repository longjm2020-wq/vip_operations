import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Card, Empty, Input, Select, Space, Typography } from "antd";
import { Header } from "./shared";

const moduleChapters: Record<string, string> = {
  products: "02-products",
  skus: "03-skus",
  inventory: "04-inventory",
  "purchase-suggestions": "06-suggestions",
  "purchase-orders": "07-purchases",
  receipts: "08-receipts",
  suppliers: "09-suppliers",
  sops: "10-sop",
  projects: "11-projects",
  warehouses: "12-warehouses",
  categories: "13-categories",
  "color-size-mappings": "14-mappings",
  "color-mappings": "14-mappings",
  "size-mappings": "14-mappings",
  brands: "15-brands",
  users: "16-users",
  roles: "17-roles",
  "audit-logs": "18-audit",
  vip: "19-vip",
};
export function manualHref(path: string) {
  const chapter = path.startsWith("/inventory/transactions")
    ? "05-transactions"
    : moduleChapters[path.split("/")[1]];
  return chapter ? `/help?chapter=${chapter}.md` : "/help";
}

const sources = import.meta.glob("../../../docs/manual/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const chapters = Object.entries(sources)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, text]) => ({
    id: path.split("/").pop()!,
    title: text.split(/\r?\n/)[0].replace(/^# /, ""),
    text,
  }));

export function ManualPage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const selected = params.get("chapter") || chapters[0]?.id;
  const setSelected = (chapter: string) => setParams({ chapter });
  const matches = chapters.filter((c) =>
    c.text.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const chapter = matches.find((c) => c.id === selected) || matches[0];
  return (
    <>
      <Header
        title="使用手册"
        subtitle="按功能模块查阅操作步骤、保存规则和常见问题。内容随系统版本发布更新。"
      />
      <Space wrap style={{ marginBottom: 20 }}>
        <Input.Search
          aria-label="搜索使用手册"
          placeholder="搜索功能或问题，例如：入库、连线"
          allowClear
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 320, maxWidth: "100%" }}
        />
        <Select
          aria-label="选择手册章节"
          value={chapter?.id}
          onChange={setSelected}
          style={{ width: 280 }}
          options={matches.map((c) => ({ value: c.id, label: c.title }))}
        />
        <Button
          disabled={!chapter}
          onClick={() => {
            if (!chapter) return;
            const url = URL.createObjectURL(
              new Blob([chapter.text], { type: "text/markdown;charset=utf-8" }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = chapter.id;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          下载本章
        </Button>
      </Space>
      {chapter ? (
        <Card>
          <article style={{ maxWidth: 960, margin: "0 auto", lineHeight: 1.9 }}>
            {chapter.text.split(/\r?\n\r?\n/).map((block, index) => {
              if (block.startsWith("# "))
                return (
                  <Typography.Title key={index} level={2}>
                    {block.slice(2)}
                  </Typography.Title>
                );
              if (block.startsWith("## "))
                return (
                  <Typography.Title key={index} level={4}>
                    {block.slice(3)}
                  </Typography.Title>
                );
              return (
                <p key={index} style={{ whiteSpace: "pre-wrap" }}>
                  {block}
                </p>
              );
            })}
          </article>
        </Card>
      ) : (
        <Empty description="没有匹配的章节，请更换关键词" />
      )}
    </>
  );
}
