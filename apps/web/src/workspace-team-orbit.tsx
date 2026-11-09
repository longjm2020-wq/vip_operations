import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Alert, Button, Dropdown, Modal, Spin, Tag } from "antd";
import {
  ArrowLeftOutlined,
  ArrowUpOutlined,
  CheckCircleOutlined,
  FileTextOutlined,
  FolderOutlined,
  PictureOutlined,
  ReadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  TeamOutlined,
  VideoCameraOutlined,
  BgColorsOutlined,
} from "@ant-design/icons";
import { useUser } from "./shared";
import { useAssistantHub } from "./assistant-hub-context";
import { ArtifactCard } from "./assistant-team-panel";
import { useWorkspaceSceneCover } from "./workspace-scene-presence";
import {
  hasTeamDelivery,
  shouldCollectTeamEnergy,
  teamIsRunning,
  teamMemberActivity,
  teamSceneArtifacts,
  teamSceneMembers,
  type TeamEnergyTone,
} from "./workspace-team-state";
import { paintTeamEnergy } from "./workspace-team-energy";
import type {
  TeamArtifact,
  TeamMember,
  TeamRun,
} from "../../../packages/contracts/src/assistant-team";
import "./workspace-team-orbit.css";

const icons: Record<TeamMember["role"], ReactNode> = {
  orchestrator: <TeamOutlined />,
  coordinator: <SafetyCertificateOutlined />,
  librarian: <FolderOutlined />,
  researcher: <SearchOutlined />,
  writer: <FileTextOutlined />,
  designer: <PictureOutlined />,
  video: <VideoCameraOutlined />,
  custom: <TeamOutlined />,
};
const stageLabels: Record<TeamRun["status"], string> = {
  QUEUED: "等待团队开始",
  PLANNING: "正在制定计划",
  RUNNING: "团队正在协作",
  REVIEWING: "正在独立验收",
  DONE: "成果已交付",
  FAILED: "任务未完成",
  CANCELED: "任务已取消",
  NEEDS_USER: "需要你补充资料",
};
type Node = {
  id: string;
  name: string;
  label: string;
  active: boolean;
  icon: ReactNode;
  member?: TeamMember;
};
function readTone(key: string): TeamEnergyTone {
  try {
    return localStorage.getItem(key) === "ice" ? "ice" : "rose";
  } catch {
    return "rose";
  }
}
function readSeen(key: string): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) || "[]");
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string").slice(-40)
      : [];
  } catch {
    return [];
  }
}

export function WorkspaceTeamOrbit({
  run,
  error,
  covered,
  dismiss,
  retry,
}: {
  run?: TeamRun;
  error: Error | null;
  covered: boolean;
  dismiss: () => void;
  retry: () => void;
}) {
  const user = useUser(),
    hub = useAssistantHub();
  const toneKey = `xuti-team-energy:${user.id}`,
    seenKey = `xuti-team-delivery:${user.id}`;
  const [tone, setTone] = useState<TeamEnergyTone>(() => readTone(toneKey));
  const layer = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [detail, setDetail] = useState<Node | TeamArtifact | "summary" | null>(
    null,
  );
  const [collecting, setCollecting] = useState(false);
  const pending = useRef(false),
    previous = useRef<TeamRun["status"] | undefined>(undefined);
  const collectionTime = useRef(0),
    activityTime = useRef(0),
    played = useRef(new Set(readSeen(seenKey)));
  const [visible, setVisible] = useState(!document.hidden);
  useWorkspaceSceneCover(detail !== null);
  useLayoutEffect(
    () =>
      setHost(
        layer.current?.closest<HTMLElement>(".workspace-ai-core-stage") || null,
      ),
    [],
  );
  useEffect(() => {
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useLayoutEffect(() => {
    if (!run) return;
    if (
      shouldCollectTeamEnergy(previous.current, run) &&
      !played.current.has(run.id)
    )
      pending.current = true;
    previous.current = run.status;
    if (run.status !== "DONE") {
      pending.current = false;
      setCollecting(false);
    }
    if (!pending.current || covered || !visible) return;
    pending.current = false;
    played.current.add(run.id);
    try {
      sessionStorage.setItem(
        seenKey,
        JSON.stringify([...played.current].slice(-40)),
      );
    } catch {
      /* Session memory is enough when storage is unavailable. */
    }
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      collectionTime.current = 0;
      setCollecting(true);
    }
  }, [run, covered, visible, seenKey]);
  const delivered = run?.status === "DONE" && !collecting && !pending.current;
  const active = !!run && teamIsRunning(run.status);
  const energized =
    !!run &&
    ["PLANNING", "RUNNING", "REVIEWING"].includes(run.status) &&
    !error;
  const allMembers = run ? teamSceneMembers(run) : [];
  const nodes: Node[] = allMembers.slice(0, 6).map((member) => ({
    id: member.id,
    name: member.name.replace(/^小序\s*[·・]\s*/, ""),
    ...teamMemberActivity(run!, member),
    icon: icons[member.role],
    member,
  }));
  if (run?.engine === "deerflow") {
    nodes.push(
      ...(run.steps.length
        ? run.steps.slice(0, 6).map((step) => ({
            id: step.id,
            name: step.title,
            label:
              step.status === "DONE"
                ? "已完成"
                : step.status === "RUNNING"
                  ? "执行中"
                  : step.status === "FAILED"
                    ? "步骤失败"
                    : "查看真实步骤",
            active: step.status === "RUNNING" && active,
            icon: <TeamOutlined />,
          }))
        : [
            {
              id: "deerflow",
              name: "DeerFlow",
              label: run.stage,
              active,
              icon: <TeamOutlined />,
            },
          ]),
    );
  }
  const artifacts = run ? teamSceneArtifacts(run) : [];
  const availableResults = !!run && hasTeamDelivery(run);
  const draft = artifacts.some((artifact) => artifact.status === "DRAFT");
  useLayoutEffect(() => {
    if (!host) return;
    host.dataset.teamTone = tone;
    host.dataset.teamPhase = collecting
      ? "collecting"
      : delivered
        ? "delivered"
        : run?.status.toLowerCase() || "loading";
    return () => {
      delete host.dataset.teamTone;
      delete host.dataset.teamPhase;
    };
  }, [host, tone, collecting, delivered, run?.status]);
  useEffect(() => {
    if (!canvas.current || !layer.current || covered || !visible) return;
    return paintTeamEnergy({
      canvas: canvas.current,
      layer: layer.current,
      tone,
      active: energized,
      collecting,
      elapsed: collectionTime,
      activityTime,
      onCollected: () => setCollecting(false),
    });
  }, [
    tone,
    energized,
    collecting,
    covered,
    visible,
    error,
    run?.updatedAt,
    host,
  ]);
  useEffect(() => {
    // A history task opens while the chat's exit transition still covers the
    // nest. Wait until it is available before asking the original pet to dock.
    if (covered || !host) return;
    const frame = requestAnimationFrame(() =>
      window.dispatchEvent(
        new CustomEvent("xuti-companion-command", { detail: "home" }),
      ),
    );
    return () => cancelAnimationFrame(frame);
  }, [covered, host]);
  const chooseTone = (next: TeamEnergyTone) => {
    setTone(next);
    try {
      localStorage.setItem(toneKey, next);
    } catch {
      /* Keep choice in memory. */
    }
  };
  return (
    <>
      <div
        ref={layer}
        className="workspace-team-layer"
        data-world-ui
        aria-label="智能体团队星轨"
        data-status={run?.status || "LOADING"}
        data-collecting={collecting}
        data-energized={energized}
        data-tone={tone}
      >
        <canvas
          ref={canvas}
          className="team-energy-canvas"
          aria-hidden="true"
        />
        <div className="team-orbit-members" inert={!!delivered}>
          {nodes.map((node, index) => (
            <button
              type="button"
              key={node.id}
              className="team-orbit-node"
              data-active={node.active && !error}
              data-source={
                !!run &&
                (run.artifacts.some(
                  (a) => a.memberId === node.id && a.status !== "REJECTED",
                ) ||
                  run.steps.some(
                    (s) =>
                      (node.member
                        ? s.memberId === node.id
                        : s.id === node.id) && s.status === "DONE",
                  ) ||
                  ((node.member?.role === "coordinator" ||
                    node.member?.role === "librarian") &&
                    run.artifacts.some((a) => a.status === "ACCEPTED")) ||
                  node.id === "deerflow")
              }
              style={
                {
                  "--team-node-x": Math.cos(
                    -Math.PI * 0.82 +
                      (index * Math.PI * 2) / Math.max(nodes.length, 1),
                  ),
                  "--team-node-y": Math.sin(
                    -Math.PI * 0.82 +
                      (index * Math.PI * 2) / Math.max(nodes.length, 1),
                  ),
                } as CSSProperties
              }
              onClick={() => setDetail(node)}
              aria-label={`查看团队成员：${node.name}`}
              title={`${node.name} · ${node.label}`}
            >
              <span className="team-orbit-disc">
                <span className="team-orbit-node-ring" aria-hidden />
                {node.icon}
                <strong>{node.name}</strong>
                <small>{node.label}</small>
                <i aria-hidden />
              </span>
            </button>
          ))}
        </div>
      </div>
      {host &&
        createPortal(
          <div className="team-orbit-hud" data-world-ui>
            <header className="team-orbit-heading">
              <div>
                <span className="team-orbit-eyebrow">
                  星轨协作
                  {run &&
                    ` · ${{ native: "网站团队", mastra: "Mastra", deerflow: "DeerFlow" }[run.engine || "native"]}`}
                </span>
                <h3 title={run?.goal}>{run?.goal || "正在读取团队任务…"}</h3>
              </div>
              <div className="team-orbit-actions">
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    selectedKeys: [tone],
                    items: [
                      { key: "rose", label: "紫粉能量" },
                      { key: "ice", label: "冰蓝能量" },
                    ],
                    onClick: ({ key }) => chooseTone(key as TeamEnergyTone),
                  }}
                >
                  <Button
                    type="text"
                    size="small"
                    icon={<BgColorsOutlined />}
                    aria-label="能量配色"
                  />
                </Dropdown>
                <Button
                  type="text"
                  size="small"
                  icon={<ArrowLeftOutlined />}
                  aria-label="返回工作台"
                  onClick={dismiss}
                >
                  返回工作台
                </Button>
              </div>
            </header>
            <div
              className="team-orbit-caption"
              role="status"
              aria-live="polite"
            >
              <span className="team-orbit-caption-dot" />
              <span>
                {collecting ? (
                  "能量汇聚 · 正在呈现交付成果"
                ) : run ? (
                  stageLabels[run.status]
                ) : (
                  <Spin size="small" />
                )}
              </span>
              {run && (
                <button type="button" onClick={() => hub.openPanel("chat")}>
                  查看对话 <ArrowUpOutlined />
                </button>
              )}
            </div>
            {!collecting && run && !delivered && (
              <div className="team-orbit-stage-text" title={run.stage}>
                {run.stage}
                {allMembers.length > 6
                  ? ` · 另有 ${allMembers.length - 6} 位成员，详情见对话`
                  : ""}
              </div>
            )}
            {error && (
              <Alert
                className="team-orbit-alert"
                type="warning"
                title="进度暂时无法更新"
                description="保留上次状态，请重新读取。"
                action={
                  <Button size="small" onClick={retry}>
                    重试
                  </Button>
                }
              />
            )}
            {run?.error && !error && !active && (
              <Alert
                className="team-orbit-alert"
                type={run.status === "FAILED" ? "error" : "warning"}
                title={run.error}
              />
            )}
            {delivered && availableResults && (
              <section
                className="team-orbit-deliveries"
                aria-label="团队交付成果"
              >
                <div className="team-orbit-delivery-heading">
                  <span>
                    <CheckCircleOutlined />
                    {draft
                      ? "成果已返回 · 待独立验收"
                      : artifacts.length
                        ? "成果已交付"
                        : "任务总结"}
                  </span>
                  <button type="button" onClick={() => hub.openPanel("chat")}>
                    查看全部 <ArrowUpOutlined />
                  </button>
                </div>
                <div className="team-orbit-file-row">
                  {artifacts.slice(0, 3).map((artifact) => (
                    <button
                      type="button"
                      key={artifact.id}
                      className="team-orbit-file"
                      onClick={() => setDetail(artifact)}
                      aria-label={`查看交付：${artifact.title}`}
                    >
                      <span
                        className={`team-orbit-cover is-${artifact.kind}`}
                        aria-hidden
                      >
                        {artifact.kind === "image" ? (
                          <PictureOutlined />
                        ) : artifact.kind === "video" ? (
                          <VideoCameraOutlined />
                        ) : artifact.kind === "research" ? (
                          <ReadOutlined />
                        ) : (
                          <FileTextOutlined />
                        )}
                        <i />
                      </span>
                      <span className="team-orbit-file-copy">
                        <strong title={artifact.title}>{artifact.title}</strong>
                        <small>
                          {artifact.status === "ACCEPTED" ? "已验收" : "待验收"}
                          {artifact.files.length
                            ? ` · ${artifact.files.length} 个文件`
                            : " · 内容成果"}
                        </small>
                      </span>
                      <ArrowUpOutlined />
                    </button>
                  ))}
                  {!artifacts.length && (
                    <button
                      type="button"
                      className="team-orbit-file"
                      onClick={() => setDetail("summary")}
                    >
                      <span className="team-orbit-cover">
                        <FileTextOutlined />
                      </span>
                      <span className="team-orbit-file-copy">
                        <strong>任务总结</strong>
                        <small>查看实际返回内容</small>
                      </span>
                      <ArrowUpOutlined />
                    </button>
                  )}
                </div>
              </section>
            )}
          </div>,
          host,
        )}
      <Modal
        title={
          detail === "summary"
            ? "任务总结"
            : detail && "name" in detail
              ? detail.name
              : detail?.title
        }
        open={detail !== null}
        onCancel={() => setDetail(null)}
        footer={null}
        width={660}
        destroyOnHidden
      >
        {detail === "summary" ? (
          <div className="team-prose">{run?.summary}</div>
        ) : detail && "name" in detail ? (
          <div className="team-orbit-member-detail">
            <Tag>{detail.label}</Tag>
            {detail.member && <p>{detail.member.instructions}</p>}
            {run?.steps
              .filter((step) =>
                detail.member
                  ? step.memberId === detail.id
                  : step.id === detail.id,
              )
              .map((step) => (
                <section key={step.id}>
                  <h4>{step.title}</h4>
                  <p>{step.instruction}</p>
                  {step.result && (
                    <div className="team-prose">{step.result}</div>
                  )}
                  {step.review && <p className="team-review">{step.review}</p>}
                  {step.error && <Alert type="warning" title={step.error} />}
                </section>
              ))}
          </div>
        ) : (
          detail && <ArtifactCard artifact={detail} />
        )}
      </Modal>
    </>
  );
}
