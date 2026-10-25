import type { CSSProperties } from "react";
import { BorderBeam } from "./components/magicui/border-beam";
import { PersonalAssistant } from "./personal-assistant";
import { useUser, type Row } from "./shared";
import { canUsePersonalAssistant } from "../../../packages/contracts/src/personal-assistant";
import type { WorkspaceSchedule } from "../../../packages/contracts/src/personal-workspace";
import "./workspace-ai.css";

// Stable decorative cells: CSS moves the light and bits without timers or renders.
const matrixCells = Array.from({ length: 14 * 12 }, (_, index) => {
  const row = Math.floor(index / 14);
  const column = index % 14;
  const texture = ((row * 17 + column * 11) % 19) / 19;
  // Feather each side separately so the complete rectangular grid stays visible.
  const edgeFade = (inset: number) => {
    const progress = Math.min(1, (inset + 0.6) / 2.2);
    return progress * progress * (3 - 2 * progress);
  };
  const presence =
    edgeFade(Math.min(column, 13 - column)) *
    edgeFade(Math.min(row, 11 - row));
  return {
    style: {
      "--cell-level": Number(((0.4 + texture * 0.5) * presence).toFixed(4)),
      "--cell-softness": `${((1 - presence) * 1.1).toFixed(2)}px`,
      "--cell-tint": `${Math.round(10 + texture * 55)}%`,
      "--cell-delay": `${-(row * 0.23 + column * 0.19)}s`,
    } as CSSProperties,
    bit: (row * 5 + column * 3) % 7 < 2 ? (row + column) % 2 : null,
  };
});

export function WorkspaceAI({
  available,
  schedule,
  onSchedule,
}: {
  available: Row[];
  schedule: WorkspaceSchedule[];
  onSchedule: (event: WorkspaceSchedule) => void;
}) {
  const user = useUser();
  if (!canUsePersonalAssistant({ permissions: user.permissions })) return null;
  return (
    <section className="workspace-ai" aria-labelledby="workspace-ai-title">
      <BorderBeam active />
      <div className="workspace-matrix" aria-hidden="true">
        {matrixCells.map(({ style, bit }, index) => (
          <i key={index} className="workspace-matrix-cell" style={style}>
            {bit !== null && (
              <span className="workspace-matrix-bits">
                <b>{bit}</b>
                <b>{1 - bit}</b>
              </span>
            )}
          </i>
        ))}
      </div>
      <div className="workspace-ai-start">
        <div className="workspace-ai-intro">
          <div className="workspace-ai-eyebrow">
            <span aria-hidden>✦</span> XUTI INTELLIGENCE
          </div>
          <h2 id="workspace-ai-title">
            从想法，
            <br />
            <span>到下一步行动。</span>
          </h2>
          <p>你的 AI 个人助理，让日程、灵感与工作有序展开。</p>
        </div>
        <PersonalAssistant
          available={available}
          schedule={schedule}
          onSchedule={onSchedule}
        />
      </div>
    </section>
  );
}
