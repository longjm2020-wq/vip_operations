import type { Project, ProjectCast } from "../src/types";
export function getProjectCast(project: Project): ProjectCast;
export function selectedCast(project: Project): ProjectCast;
export function projectWithCast(project: Project, cast: ProjectCast): Project;
export function castIssue(project: Project, requireLength?: boolean): string;
export function castFingerprint(project: Project): unknown;
