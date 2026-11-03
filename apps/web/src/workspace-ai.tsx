import { useAssistantHub } from "./assistant-hub-context";
import { PersonalAssistant } from "./personal-assistant";
import { useUser, type Row } from "./shared";
import { canUsePersonalAssistant } from "../../../packages/contracts/src/personal-assistant";
import type { WorkspaceSchedule } from "../../../packages/contracts/src/personal-workspace";
import "./workspace-ai.css";

const coreStates = {
  idle: { label: "待命中", description: "把想法交给小序，让下一步更清晰。" },
  connecting: { label: "正在连接", description: "正在准备语音连接。" },
  listening: { label: "正在聆听", description: "我在听，慢慢说。" },
  thinking: { label: "思考中", description: "正在梳理你的问题，请稍候。" },
  working: { label: "处理中", description: "正在处理你的请求，请稍候。" },
  speaking: { label: "正在说话", description: "正在为你播放回答。" },
  unavailable: {
    label: "尚未就绪",
    description: "在下方打开个人助理，查看连接状态。",
  },
};

// Fixed geometry keeps this decorative core independent of timers and model calls.
const coreTicks = Array.from({ length: 60 }, (_, index) => index);

function AssistantCore() {
  return (
    <div className="workspace-ai-core" aria-hidden="true">
      <div className="workspace-ai-core-aura" />
      <svg className="workspace-ai-core-orbits" viewBox="0 0 320 320">
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
      <div className="workspace-ai-core-center">
        <span className="workspace-ai-core-wordmark">XUTI</span>
        <b>小序</b>
        <span className="workspace-ai-core-caption">AI 个人助理</span>
        <span className="workspace-ai-core-signal">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}

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
  const hub = useAssistantHub();
  if (!canUsePersonalAssistant({ permissions: user.permissions })) return null;
  const state =
    hub.voiceState ||
    (hub.busy ? "working" : hub.conversation?.ready ? "idle" : "unavailable");
  const status = coreStates[state];
  return (
    <section
      className="workspace-ai"
      data-core-state={state}
      aria-labelledby="workspace-ai-title"
    >
      <div className="workspace-ai-start">
        <header className="workspace-ai-intro">
          <div className="workspace-ai-eyebrow">
            <span>XUTI INTELLIGENCE</span>
            <span
              className="workspace-ai-status"
              role="status"
              aria-live="polite"
            >
              <i aria-hidden="true" />
              {status.label}
            </span>
          </div>
          <h2 id="workspace-ai-title">从想法，到下一步行动。</h2>
        </header>
        <AssistantCore />
        <p className="workspace-ai-description">{status.description}</p>
        <PersonalAssistant
          available={available}
          schedule={schedule}
          onSchedule={onSchedule}
        />
      </div>
    </section>
  );
}
