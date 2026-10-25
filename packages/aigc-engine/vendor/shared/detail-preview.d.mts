import type { DetailProject, Job } from "../src/detail-types";
export type DetailPreviewPage = Job & { title: string; outputType: "main_image" | "detail_page"; outputRatio: string };
export function detailPreviewPages(project: Pick<DetailProject, "jobs" | "modules">): DetailPreviewPage[];
