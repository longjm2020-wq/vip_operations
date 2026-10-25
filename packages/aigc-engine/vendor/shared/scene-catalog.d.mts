import type { Project } from "../src/types";
export type Scene = { id: string; name: string; styleId: string; style: string; keywords: string; description: string };
export const SCENE_STYLES: { id: string; label: string; keywords: string; scenes: Scene[] }[];
export const SCENES: Scene[];
export function findScene(id?: string): Scene | undefined;
export function cleanSceneSelection(selection?: { sceneId: string }): { sceneId: string } | undefined;
export function sceneInstructions(project: Project): string;
export function sceneInputKey(project: Project): string;
