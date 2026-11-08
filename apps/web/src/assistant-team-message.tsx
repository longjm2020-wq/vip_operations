import { useEffect, useState } from "react";
import { Alert, App, Button, Spin, Tag } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useUser } from "./shared";
import { ArtifactCard, teamActive, teamRunsKey } from "./assistant-team-panel";
import type { TeamRun } from "../../../packages/contracts/src/assistant-team";

export function AssistantTeamMessage({ id }: { id: string }) {
  const user = useUser(),
    client = useQueryClient(),
    { message } = App.useApp();
  const [canceling, setCanceling] = useState(false);
  const run = useQuery({
    queryKey: ["assistant-team-run", user.id, id],
    queryFn: async () =>
      (await api(`/my-workspace/assistant/team/runs/${encodeURIComponent(id)}`))
        .data as TeamRun,
    refetchInterval: (query) =>
      !query.state.data || teamActive(query.state.data.status) ? 2500 : false,
  });
  const status = run.data?.status;
  useEffect(() => {
    if (status && !teamActive(status)) {
      void client.invalidateQueries({
        queryKey: ["personal-assistant", user.id],
      });
      void client.invalidateQueries({ queryKey: teamRunsKey(user.id) });
    }
  }, [status, client, user.id]);
  const cancel = async () => {
    setCanceling(true);
    try {
      const response = await api(
        `/my-workspace/assistant/team/runs/${encodeURIComponent(id)}/cancel`,
        "POST",
        {},
      );
      if (response.data?.note) message.info(response.data.note);
      await run.refetch();
    } catch (cause) {
      message.error((cause as Error).message);
    } finally {
      setCanceling(false);
    }
  };
  const value = run.data;
  return (
    <article className="assistant-team-message" aria-label="对话中的团队任务">
      <div className="team-card-heading">
        <strong>小序 · 智能体团队</strong>
        {value && (
          <Tag>
            {
              {
                QUEUED: "排队中",
                PLANNING: "制定计划",
                RUNNING: "执行中",
                REVIEWING: "验收中",
                DONE: "已交付",
                FAILED: "失败",
                CANCELED: "已取消",
                NEEDS_USER: "需要补充",
              }[value.status]
            }
          </Tag>
        )}
      </div>
      {run.isLoading && <Spin size="small" />}
      {run.error && (
        <Alert
          type="error"
          title={run.error.message}
          action={
            <Button size="small" onClick={() => void run.refetch()}>
              重试
            </Button>
          }
        />
      )}
      {value && (
        <>
          <p role="status">{value.stage}</p>
          {teamActive(value.status) && (
            <Button
              size="small"
              loading={canceling}
              onClick={() => void cancel()}
            >
              停止团队任务
            </Button>
          )}
          {value.error && <Alert type="error" title={value.error} />}
          {value.summary && (
            <section>
              <h4>任务结果</h4>
              <div className="team-prose">{value.summary}</div>
            </section>
          )}
          {value.engine === "deerflow" &&
            value.artifacts.some((artifact) => artifact.status === "DRAFT") && (
              <p className="team-meta">结果已返回，尚未经过本站独立验收。</p>
            )}
          {value.artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
          {(value.plan || value.steps.length > 0) && (
            <details>
              <summary>执行详情</summary>
              {value.plan && <p className="team-prose">{value.plan}</p>}
              <ol className="team-steps">
                {value.steps.map((step) => (
                  <li key={step.id} className="team-step">
                    <strong>{step.title}</strong>
                    {step.model && (
                      <p className="team-meta">本步骤模型：{step.model}</p>
                    )}
                    <p>{step.instruction}</p>
                    {step.result && (
                      <div className="team-prose">{step.result}</div>
                    )}
                    {step.review && (
                      <p className="team-review">验收意见：{step.review}</p>
                    )}
                    {step.error && <Alert type="error" title={step.error} />}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </article>
  );
}
