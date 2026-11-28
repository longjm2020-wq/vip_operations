export interface CozyClayExportInput {
  workflowId: string;
  title: string;
  characters?: Array<{ id?: string; name: string }>;
  props?: Array<{ id?: string; name: string; note?: string }>;
  shots: Array<{
    id: string;
    title?: string;
    type?: string;
    caption?: string;
    camera?: string;
    action?: string;
    props?: string;
    scene?: string;
    characterNames?: string[];
    durationSec?: number;
  }>;
}

export function buildCozyClayProjectV5(
  input: CozyClayExportInput,
): Record<string, unknown>;
