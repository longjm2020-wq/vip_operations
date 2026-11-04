import type { CSSProperties, Ref } from "react";

/** All layers share one vector path; only the small highlight travels along it. */
export function WorkspaceFlowLine({
  d,
  active = false,
  delay = 0,
  lineRef,
}: {
  d?: string;
  active?: boolean;
  delay?: number;
  lineRef?: Ref<SVGGElement>;
}) {
  return (
    <g
      ref={lineRef}
      className="workspace-flow-line"
      data-active={active}
      style={{ "--flow-delay": `${delay}s` } as CSSProperties}
    >
      <path className="workspace-flow-track" d={d} pathLength="100" />
      <path className="workspace-flow-trail" d={d} pathLength="100" />
      <path className="workspace-flow-head" d={d} pathLength="100" />
    </g>
  );
}
