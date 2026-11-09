import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useUser } from "./shared";
import { useAssistantHub } from "./assistant-hub-context";
import { teamIsRunning } from "./workspace-team-state";
import type { TeamRun } from "../../../packages/contracts/src/assistant-team";
import {
  takeWorkspaceTeam,
  workspaceTeamEvent,
} from "./workspace-team-navigation";

export function useWorkspaceTeam() {
  const hub = useAssistantHub(),
    user = useUser(),
    client = useQueryClient();
  const [dismissed, setDismissed] = useState<string>();
  const latest = hub.conversation?.messages.at(-1)?.teamRunId;
  const [id, setId] = useState(hub.selectedTeamRunId || latest);
  useEffect(
    () => setId(hub.selectedTeamRunId || latest),
    [hub.selectedTeamRunId, latest, user.id],
  );
  useEffect(() => {
    const select = () => {
      const pending = takeWorkspaceTeam();
      if (pending) {
        setId(pending);
        setDismissed(undefined);
      }
    };
    window.addEventListener(workspaceTeamEvent, select);
    select();
    return () => window.removeEventListener(workspaceTeamEvent, select);
  }, []);
  const visible = hub.allowed && !!id && id !== dismissed;
  const query = useQuery({
    queryKey: ["assistant-team-run", user.id, id],
    enabled: visible,
    queryFn: async () =>
      (
        await api(
          `/my-workspace/assistant/team/runs/${encodeURIComponent(id!)}`,
        )
      ).data as TeamRun,
    refetchInterval: (q) =>
      !q.state.data || teamIsRunning(q.state.data.status) ? 2500 : false,
  });
  const status = query.data?.status;
  useEffect(() => {
    if (!status || teamIsRunning(status)) return;
    void client.invalidateQueries({
      queryKey: ["personal-assistant", user.id],
    });
    void client.invalidateQueries({
      queryKey: ["assistant-team-runs", user.id],
    });
  }, [status, id, user.id, client]);
  return {
    id,
    visible,
    run: query.data,
    error: query.error,
    retry: () => void query.refetch(),
    dismiss: () => setDismissed(id),
  };
}
