import type { WorkItem } from "../src/types";
export type WorkCategory = "short_video" | "detail_page" | "main_image" | "digital_human";
export function workCategory(work: WorkItem): WorkCategory;
export function filterWorks(works: WorkItem[], options?: { section?: "library" | "trash"; category?: "all" | WorkCategory; favoritesOnly?: boolean }): WorkItem[];
