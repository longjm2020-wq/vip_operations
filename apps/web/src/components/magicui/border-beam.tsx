/**
 * Adapted from Magic UI Border Beam (MIT, Copyright (c) Magic UI).
 * https://github.com/magicuidesign/magicui/blob/main/apps/www/registry/magicui/border-beam.tsx
 * Local adaptation uses CSS animation instead of Motion/Tailwind.
 * License is distributed at /licenses/magicui.txt.
 */
import type { CSSProperties } from "react";
import "./border-beam.css";

export function BorderBeam({
  active = true,
  duration = 14,
}: {
  active?: boolean;
  duration?: number;
}) {
  return (
    <div
      aria-hidden="true"
      className={`magic-border-beam${active ? " is-active" : ""}`}
    >
      <div style={{ "--beam-duration": `${duration}s` } as CSSProperties} />
    </div>
  );
}
