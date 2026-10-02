import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button, Result, Spin, Tag } from "antd";
import { RobotOutlined } from "@ant-design/icons";
import { CompassReportView, type CompassReportSnapshot } from "./compass-ai";
import "./compass-share.css";

export function PublicCompassReport() {
  const token = useLocation().pathname.slice("/share/compass/".length);
  const report = useQuery({
    queryKey: ["public-compass-report", token],
    queryFn: async (): Promise<
      CompassReportSnapshot & { expiresAt: string }
    > => {
      if (!/^[a-f0-9]{64}$/.test(token))
        throw new Error("分享链接不存在、已过期或已撤销");
      const response = await fetch(`/api/v1/public/compass-reports/${token}`, {
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? "分享链接不存在、已过期或已撤销"
            : "报告暂时无法读取，请稍后重试",
        );
      return result.data;
    },
    staleTime: 0,
  });
  useEffect(() => {
    const priorTitle = document.title;
    document.title = "AI 经营分析 · XUTI";
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
      document.title = priorTitle;
      metas.forEach((meta) => meta.remove());
    };
  }, []);
  return (
    <div className="public-compass-report">
      <header>
        <div>
          <span className="public-compass-brand">XUTI</span>
          <h1>
            <RobotOutlined aria-hidden="true" /> AI 经营分析
          </h1>
        </div>
        <Tag>分享报告</Tag>
      </header>
      <main>
        {report.isLoading ? (
          <div className="public-compass-loading">
            <Spin size="large" tip="正在读取分享报告" />
          </div>
        ) : report.error ? (
          <Result
            status={
              (report.error as Error).message.includes("已过期")
                ? "404"
                : "warning"
            }
            title={(report.error as Error).message}
            subTitle="请联系分享者获取新的链接。"
            extra={
              <Button onClick={() => void report.refetch()}>重新读取</Button>
            }
          />
        ) : (
          report.data && (
            <>
              <CompassReportView report={report.data} />
              <footer>
                分享快照 · 有效至{" "}
                {new Date(report.data.expiresAt).toLocaleString("zh-CN", {
                  hour12: false,
                })}
              </footer>
            </>
          )
        )}
      </main>
    </div>
  );
}
