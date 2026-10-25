import { BorderBeam } from "./components/magicui/border-beam";
import { PersonalAssistant } from "./personal-assistant";
import { useUser, type Row } from "./shared";
import { canUsePersonalAssistant } from "../../../packages/contracts/src/personal-assistant";
import type { WorkspaceSchedule } from "../../../packages/contracts/src/personal-workspace";
import "./workspace-ai.css";

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
      <div className="workspace-orbit" aria-hidden="true">
        <div className="workspace-orbit-glow" />
        <div className="workspace-orbit-sphere">
          <span>✦</span>
        </div>
        <i />
        <i />
        <i />
      </div>
      <div className="workspace-ai-start">
        <div className="workspace-ai-eyebrow">
          <span aria-hidden>✦</span> XUTI INTELLIGENCE
        </div>
        <h2 id="workspace-ai-title">
          从想法，
          <br />
          <span>到下一步行动。</span>
        </h2>
        <p>你的 AI 个人助理，让日程、灵感与工作有序展开。</p>
        <PersonalAssistant
          available={available}
          schedule={schedule}
          onSchedule={onSchedule}
        />
      </div>
    </section>
  );
}
