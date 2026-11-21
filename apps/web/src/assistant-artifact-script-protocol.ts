export type ArtifactScriptSnapshot = {
  attributes: Record<string, string>;
  text: string;
  value?: string;
};

export type ArtifactScriptRequest =
  | {
      type: "init";
      scripts: string[];
      elements: Record<string, ArtifactScriptSnapshot>;
      reducedMotion: boolean;
      hidden: boolean;
    }
  | {
      type: "event";
      id?: string;
      name: "click" | "input" | "change" | "visibilitychange";
      value?: string;
      hidden?: boolean;
    };

export type ArtifactScriptChange =
  | { id: string; text: string }
  | { id: string; attribute: string; value: string };

export type ArtifactScriptResponse =
  | { type: "ready" }
  | { type: "error" }
  | { type: "update"; changes: ArtifactScriptChange[] };

export const artifactScriptLimits = {
  sourceLength: 512 * 1024,
  elementCount: 1024,
  maxIdLength: 256,
  valueLength: 64 * 1024,
  snapshotLength: 1024 * 1024,
  changeCount: 128,
  updateLength: 256 * 1024,
} as const;

export const artifactScriptAttributes = [
  "d",
  "transform",
  "patternTransform",
  "gradientTransform",
  "viewBox",
  "points",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "pathLength",
  "opacity",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "aria-label",
  "aria-pressed",
  "aria-valuenow",
  "aria-valuetext",
  "title",
] as const;

const writableAttributes = new Set<string>(artifactScriptAttributes);

export function isArtifactScriptAttribute(name: string): boolean {
  return writableAttributes.has(name);
}
