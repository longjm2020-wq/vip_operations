export type AssistantActivity = {
  id: string;
  kind: "schedule" | "project" | "task";
  title: string;
  detail: string;
  href: string;
  at: string;
  status: "upcoming" | "running" | "completed" | "attention" | "info";
  progress?: { done: number; total: number };
};
export type AssistantActivityFeed = {
  items: AssistantActivity[];
  serverTime: string;
};
export const activityFingerprint = (item: AssistantActivity) =>
  `${item.id}:${item.status}:${item.at}:${item.progress?.done ?? ""}:${item.progress?.total ?? ""}`;
