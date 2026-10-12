import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { Tag } from "antd";
import { CompetitorAnalysisPage } from "./competitor-analysis";
import "./compass-share.css";
import "./competitor-share.css";

export function PublicCompetitorAnalysis() {
  const token = useLocation().pathname.slice("/share/competitors/".length);
  useEffect(() => {
    const prior = document.title;
    document.title = "竞品分析 · XUTI";
    const metas = [
      ["robots", "noindex, nofollow"],
      ["referrer", "no-referrer"],
    ].map(([name, content]) => {
      const meta = document.createElement("meta");
      meta.name = name;
      meta.content = content;
      document.head.appendChild(meta);
      return meta;
    });
    return () => {
      document.title = prior;
      metas.forEach((meta) => meta.remove());
    };
  }, []);
  return (
    <div className="public-compass-report public-competitor-analysis">
      <header>
        <span className="public-compass-brand">XUTI</span>
        <Tag>竞品分析 · 只读分享</Tag>
      </header>
      <main>
        <CompetitorAnalysisPage key={token} shareToken={token} />
      </main>
    </div>
  );
}
