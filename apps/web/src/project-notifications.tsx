import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Alert, Badge, Button, Card, Drawer, Empty } from "antd";
import { BellOutlined } from "@ant-design/icons";
import { api, queryClient } from "./api";
import { type Row, useCan, when } from "./shared";

/** Kept separate so the global bell never downloads the project editor or tables. */
export function ProjectNotifications() {
  const can = useCan("project.read"),
    [open, setOpen] = useState(false);
  const result = useQuery({
    queryKey: ["project-notifications"],
    queryFn: async () => (await api("/projects/notifications")).data,
    enabled: can,
    refetchInterval: 15000,
  });
  if (!can) return null;
  const notices = result.data || [];
  return (
    <>
      <Badge count={notices.filter((n: Row) => !n.readAt).length}>
        <Button
          type="text"
          aria-label="项目通知"
          icon={<BellOutlined />}
          onClick={() => setOpen(true)}
        />
      </Badge>
      <Drawer title="项目通知" open={open} onClose={() => setOpen(false)}>
        {result.error && <Alert type="error" title={result.error.message} />}
        {!notices.length && <Empty description="暂无项目通知" />}
        {notices.map((n: Row) => (
          <Card key={n.id} size="small">
            <Link
              to={"/projects/" + n.projectId}
              onClick={() => {
                setOpen(false);
                api(`/projects/${n.projectId}/read`, "POST", {})
                  .then(() =>
                    queryClient.invalidateQueries({
                      predicate: (q) =>
                        String(q.queryKey[0]).startsWith("project-"),
                    }),
                  )
                  .catch(() => {});
              }}
            >
              {!n.readAt && <Badge status="processing" />}
              {n.body}
            </Link>
            <p>{when(n.createdAt)}</p>
          </Card>
        ))}
      </Drawer>
    </>
  );
}
