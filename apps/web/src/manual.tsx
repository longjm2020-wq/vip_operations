import { useState } from "react";
import { Button, Card, Empty, Input, Select, Space, Typography } from "antd";
import { Header } from "./shared";

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
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(chapters[0]?.id);
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
