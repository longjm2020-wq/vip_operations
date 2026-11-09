export const workspaceTeamEvent = "xuti-workspace-team";
let queuedRun: string | undefined;
export function showWorkspaceTeam(id: string) {
  queuedRun = id;
  window.dispatchEvent(new Event(workspaceTeamEvent));
}
export function takeWorkspaceTeam() {
  const id = queuedRun;
  queuedRun = undefined;
  return id;
}
