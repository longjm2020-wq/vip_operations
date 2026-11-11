import { Fragment } from "react";
import { parseSkillMarkdown, type SkillInline } from "./skill-markdown";

const Inline = ({ parts }: { parts: SkillInline[] }) => (
  <>
    {parts.map((part, i) =>
      part.bold ? (
        <strong key={i}>{part.text}</strong>
      ) : part.code ? (
        <code key={i}>{part.text}</code>
      ) : (
        <Fragment key={i}>{part.text}</Fragment>
      ),
    )}
  </>
);

export function SkillMarkdownView({ source }: { source: string }) {
  const blocks = parseSkillMarkdown(source);
  if (!blocks.length)
    return <div className="skill-markdown skill-markdown-empty">暂无内容</div>;
  return (
    <div className="skill-markdown">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading": {
            const Tag = `h${Math.min(block.level + 2, 6)}` as "h4";
            return (
              <Tag key={i}>
                <Inline parts={block.inline} />
              </Tag>
            );
          }
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Inline parts={item} />
                  </li>
                ))}
              </List>
            );
          }
          case "quote":
            return (
              <blockquote key={i}>
                <Inline parts={block.inline} />
              </blockquote>
            );
          case "code":
            return <pre key={i}>{block.text}</pre>;
          default:
            return (
              <p key={i}>
                <Inline parts={block.inline} />
              </p>
            );
        }
      })}
    </div>
  );
}
