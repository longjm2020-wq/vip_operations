import {
  workspaceTools,
  availableWorkspaceTools,
  type WorkspaceActor,
} from "./personal-workspace.js";

const workspaceHome = {
  id: "workspace",
  title: "我的工作台",
  path: "/my-workspace",
} as const;

// Home is available to every signed-in user, but is not a configurable shortcut.
export function assistantNavigationTools(actor: WorkspaceActor) {
  return [workspaceHome, ...availableWorkspaceTools(actor)];
}

export type VoiceCommand =
  | { kind: "navigate"; toolId: string; title: string }
  | { kind: "sync"; syncKind: "compass" | "jushuitan" };

// Recognize a single explicit imperative, never mentions, questions, negations or compound requests.
export function parseVoiceCommand(text: string): VoiceCommand | undefined {
  const command = text
    .trim()
    .replace(/[。.!！]+$/, "")
    .trim()
    .replace(/^小序[，,、\s]*/, "")
    .replace(/^(?:请|麻烦)?(?:帮我|替我)?(?:现在|马上)?/, "");
  if (
    /^(?:开始)?(?:更新|同步)(?:唯品会)?(?:魔方)?罗盘(?:数据|报表)(?:一下|吧)?$/.test(
      command,
    )
  )
    return { kind: "sync", syncKind: "compass" };
  if (/^(?:开始)?(?:同步|更新)聚水潭库存(?:一下|吧)?$/.test(command))
    return { kind: "sync", syncKind: "jushuitan" };
  const match =
    /^(?:打开|进入|前往|切换到|返回到?|回到?|切回到?)(?:唯品会)?(.+?)(?:页面)?(?:一下|吧)?$/.exec(
      command,
    );
  const name = match?.[1];
  const target = ["我的工作台", "工作台", "首页"].includes(name || "")
    ? workspaceHome
    : workspaceTools.find((tool) => tool.title === name);
  if (target)
    return { kind: "navigate", toolId: target.id, title: target.title };
}
