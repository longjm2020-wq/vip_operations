import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { TeamEnergyTone } from "./workspace-team-state";
import "./workspace-team-labels.css";

export type TeamLabelNode = {
  id: string;
  name: string;
  label: string;
  icon: ReactNode;
  active: boolean;
};

/** Visual labels stay outside the 3D plane; original buttons own interaction. */
export function WorkspaceTeamLabels({
  host,
  nodes,
  tone,
  hidden = false,
}: {
  host: HTMLElement | null;
  nodes: readonly TeamLabelNode[];
  tone: TeamEnergyTone;
  hidden?: boolean;
}) {
  if (!host || hidden) return null;
  return createPortal(
    <>
      {nodes.map((node) => (
        <span
          className="team-member-label"
          key={node.id}
          data-team-label-id={node.id}
          data-active={node.active}
          data-tone={tone}
          aria-hidden="true"
        >
          <span className="team-member-label-icon">{node.icon}</span>
          <strong className="team-member-label-name">{node.name}</strong>
          <small className="team-member-label-status">{node.label}</small>
        </span>
      ))}
    </>,
    host,
  );
}

/** Called by the existing scene painter; does not create another animation loop. */
export function createTeamLabelPainter(layer: HTMLElement) {
  const host = layer.closest<HTMLElement>(".workspace-ai-core-stage");
  const previousStyles = new WeakMap<HTMLElement, string>();
  return () => {
    if (!host || document.hidden) return;
    const labels = [
      ...host.querySelectorAll<HTMLElement>(".team-member-label"),
    ];
    if (!labels.length) return;
    const sources = new Map(
      [...layer.querySelectorAll<HTMLElement>(".team-orbit-node")].map(
        (node) => [node.dataset.teamNodeId, node],
      ),
    );
    const origin = host.getBoundingClientRect();
    const originX = origin.left + host.clientLeft - host.scrollLeft;
    const originY = origin.top + host.clientTop - host.scrollTop;
    const ratio = window.devicePixelRatio || 1;
    const snap = (value: number) => Math.round(value * ratio) / ratio;
    // Finish all projected-geometry reads before changing any screen-space label.
    const measured = labels.map((copy) => ({
      copy,
      box: sources
        .get(copy.dataset.teamLabelId)
        ?.querySelector<HTMLElement>(".team-orbit-disc")
        ?.getBoundingClientRect(),
    }));
    for (const { copy, box } of measured) {
      const style =
        box && box.width > 0 && box.height > 0
          ? `left:${snap(box.left - originX)}px;top:${snap(box.top - originY)}px;width:${snap(box.width)}px;height:${snap(box.height)}px;visibility:visible`
          : "visibility:hidden";
      if (previousStyles.get(copy) === style) continue;
      copy.style.cssText = style;
      previousStyles.set(copy, style);
    }
  };
}
