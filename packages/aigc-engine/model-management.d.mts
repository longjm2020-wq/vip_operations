import type { AiModelChoice } from "../contracts/src/ai-management.js";
export function aigcModelManagement(config: any, settings: any): { id: string; model: string; selection: string; source: string; configured: boolean; choices: AiModelChoice[] }[];
