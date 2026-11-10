import { useAssistantHub } from "./assistant-hub-context";
import { PersonalAssistant } from "./personal-assistant";
import { useUser, type Row } from "./shared";
import { canUsePersonalAssistant } from "../../../packages/contracts/src/personal-assistant";
import type { WorkspaceSchedule } from "../../../packages/contracts/src/personal-workspace";
import "./workspace-ai.css";
import { WorkspaceNestHandle } from "./workspace-nest-handle";
import { useWorkspaceTeam } from "./use-workspace-team";
import { WorkspaceTeamOrbit } from "./workspace-team-orbit";
import { teamIsRunning } from "./workspace-team-state";
import { useWorkspaceHubStage } from "./use-workspace-hub-stage";

// Fixed geometry keeps this decorative core independent of timers and model calls.
const coreTicks = Array.from({ length: 60 }, (_, index) => index);

function requestCompanion(command: "home" | "explore") {
  window.dispatchEvent(
    new CustomEvent("xuti-companion-command", { detail: command }),
  );
}

function AssistantCore({
  branchLayout,
  onToggleBranches,
}: {
  branchLayout: boolean;
  onToggleBranches: () => void;
}) {
  return (
    <div
      className="workspace-ai-core"
      role="group"
      aria-label="小序巢穴三维视角"
    >
      <div className="workspace-ai-core-perspective" aria-hidden="true">
        <div className="workspace-ai-core-scene">
          <div className="workspace-ai-core-aura" aria-hidden="true" />
          <div className="workspace-ai-core-resonance" aria-hidden="true" />
          <div className="workspace-ai-core-depth workspace-ai-core-depth-back" />
          <div className="workspace-ai-core-depth workspace-ai-core-depth-cross" />
        </div>
        <svg
          className="workspace-ai-core-orbits"
          viewBox="0 0 320 320"
          shapeRendering="geometricPrecision"
          focusable="false"
          aria-hidden="true"
        >
          <g className="workspace-ai-core-guides" fill="none">
            <circle cx="160" cy="160" r="151" />
            <circle cx="160" cy="160" r="131" />
            <circle cx="160" cy="160" r="103" />
            <path d="M160 2v8M160 310v8M2 160h8M310 160h8" />
          </g>
          <g className="workspace-ai-core-ticks">
            {coreTicks.map((tick) => (
              <line
                key={tick}
                x1="160"
                y1={tick % 5 === 0 ? 18 : 23}
                x2="160"
                y2="28"
                transform={`rotate(${tick * 6} 160 160)`}
                className={tick % 5 === 0 ? "is-major" : undefined}
              />
            ))}
          </g>
          <g className="workspace-ai-core-outer" fill="none">
            <circle
              cx="160"
              cy="160"
              r="145"
              pathLength="100"
              strokeDasharray="16 11 3 20 16 11 3 20"
            />
            <circle cx="160" cy="15" r="2.6" className="is-node" />
            <circle cx="160" cy="305" r="2.6" className="is-node" />
          </g>
          <g className="workspace-ai-core-middle" fill="none">
            <circle
              cx="160"
              cy="160"
              r="120"
              pathLength="100"
              strokeDasharray="30 20 30 20"
            />
            <circle
              cx="160"
              cy="160"
              r="115"
              pathLength="100"
              strokeDasharray="4 46 4 46"
              className="is-trace"
            />
          </g>
          <g className="workspace-ai-core-orbit-plane" fill="none">
            <ellipse cx="160" cy="160" rx="111" ry="55" />
            <ellipse
              cx="160"
              cy="160"
              rx="111"
              ry="55"
              transform="rotate(60 160 160)"
            />
            <ellipse
              cx="160"
              cy="160"
              rx="111"
              ry="55"
              transform="rotate(120 160 160)"
            />
          </g>
          <g className="workspace-ai-core-inner" fill="none">
            <circle
              cx="160"
              cy="160"
              r="88"
              pathLength="100"
              strokeDasharray="22 3 22 3 22 3 22 3"
            />
            <circle cx="160" cy="160" r="79" className="is-inner-guide" />
          </g>
        </svg>
      </div>
      <WorkspaceNestHandle
        branchLayout={branchLayout}
        onToggleBranches={onToggleBranches}
      />
      <div className="workspace-ai-companion-slot" />
      <button
        className="workspace-ai-summon"
        type="button"
        onClick={() => requestCompanion("home")}
      >
        召唤小序
      </button>
    </div>
  );
}

export function WorkspaceAI({
  sceneCovered = false,
  available,
  schedule,
  onSchedule,
  branchLayout,
  onToggleBranches,
}: {
  sceneCovered?: boolean;
  available: Row[];
  schedule: WorkspaceSchedule[];
  onSchedule: (event: WorkspaceSchedule) => void;
  branchLayout: boolean;
  onToggleBranches: () => void;
}) {
  const user = useUser();
  const hub = useAssistantHub();
  const team = useWorkspaceTeam();
  const stage = useWorkspaceHubStage();
  if (!canUsePersonalAssistant({ permissions: user.permissions })) return null;
  const backgroundTaskRunning = hub.feed?.items?.some(
    (item) => item.kind === "task" && item.status === "running",
  );
  const state =
    hub.voiceState ||
    (hub.busy ||
    backgroundTaskRunning ||
    (team.visible && team.run && teamIsRunning(team.run.status))
      ? "working"
      : hub.conversation?.ready
        ? "idle"
        : "unavailable");
  return (
    <section
      className="workspace-ai"
      data-core-state={state}
      aria-label="小序智能工作区"
    >
      <div className="workspace-ai-start">
        <div
          className="workspace-ai-core-stage"
          ref={stage}
          inert={sceneCovered}
          data-team-active={team.visible}
        >
          <div className="workspace-world-camera">
            <div className="workspace-world-plane">
              <AssistantCore
                branchLayout={branchLayout}
                onToggleBranches={onToggleBranches}
              />
              {team.visible && (
                <WorkspaceTeamOrbit
                  key={team.id}
                  run={team.run}
                  error={team.error}
                  covered={sceneCovered}
                  dismiss={team.dismiss}
                  retry={team.retry}
                />
              )}
              <div className="workspace-ai-orbit-slot" />
            </div>
          </div>
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
