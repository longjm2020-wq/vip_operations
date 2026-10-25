export type DetailDropPlacement = "before" | "after";
export function moveDetailModule<T extends { id: string }>(modules: T[], sourceId: string, targetId: string, placement?: DetailDropPlacement): T[];
