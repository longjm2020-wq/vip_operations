import type { DetailModule, DetailProject } from "../src/detail-types";
export const MAX_DETAIL_MODULES: 80;
export function isMainImageModule(module: Pick<DetailModule, "id" | "type">): boolean;
export function requestedMainImageCount(project: Pick<DetailProject, "modules" | "mainImageCount">): number;
export function resizeMainImages(modules: DetailModule[], count: number): DetailModule[];
