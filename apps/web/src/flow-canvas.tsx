import { useEffect, useId, useRef, useState } from "react";
import { App, Button, Space, Typography } from "antd";
import { Row } from "./shared";
import { flowSteps, validFlow } from "../../../packages/contracts/src/projects";
type FlowNode = {
  id: string;
  name: string;
  description?: string;
  department?: string;
  dependsOn?: string[];
  position?: { x: number; y: number };
};

export function FlowCanvas({
  stages,
  tasks = [],
  onStage,
  onChange,
}: {
  stages: Row[];
  tasks?: Row[];
  onStage?: (id: string) => void;
  onChange?: (steps: Row[]) => void;
}) {
  const { message } = App.useApp();
  const marker = useId().replace(/:/g, "");
  const root = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const canvas = root.current;
    const preventScroll = (event: WheelEvent) => event.preventDefault();
    canvas?.addEventListener("wheel", preventScroll, { passive: false });
    return () => canvas?.removeEventListener("wheel", preventScroll);
  }, []);
  const [view, setView] = useState({ x: 40, y: 60, scale: 0.8 });
  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [source, setSource] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [edge, setEdge] = useState<{ from: string; to: string } | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const drag = useRef<{
    id?: string;
    x: number;
    y: number;
    ox: number;
    oy: number;
    moved: boolean;
  } | null>(null);
  const nodes = flowSteps<FlowNode>(stages as FlowNode[]).map((s) => ({
    ...s,
    position: positions[s.id] || s.position,
  }));
  const selected = nodes.find((n) => n.id === selectedNode);
  const addAfter = () => {
    if (!onChange || !selected || nodes.length >= 30) return;
    const id = crypto.randomUUID();
    onChange([
      ...nodes,
      {
        id,
        name: "新环节",
        description: "",
        dependsOn: [selected.id],
        position: {
          x: selected.position.x + 340,
          y: selected.position.y + 260,
        },
      },
    ]);
    setSelectedNode(id);
    setEdge(null);
    setSource(null);
  };
  const removeNode = () => {
    if (!onChange || !selected) return;
    if (nodes.length === 1) {
      message.warning("至少保留一个环节");
      return;
    }
    onChange(
      nodes
        .filter((n) => n.id !== selected.id)
        .map((n) => ({
          ...n,
          dependsOn: n.dependsOn.filter((id) => id !== selected.id),
        })),
    );
    setSelectedNode(null);
    setEdge(null);
    setSource(null);
  };
  const removeEdge = () => {
    if (!onChange || !edge) return;
    onChange(
      nodes.map((n) =>
        n.id === edge.to
          ? { ...n, dependsOn: n.dependsOn.filter((id) => id !== edge.from) }
          : n,
      ),
    );
    setEdge(null);
    setSource(null);
  };
  const insertOnEdge = () => {
    if (!onChange || !edge || nodes.length >= 30) return;
    const from = nodes.find((n) => n.id === edge.from),
      to = nodes.find((n) => n.id === edge.to);
    if (!from || !to) return;
    const id = crypto.randomUUID();
    onChange([
      ...nodes.map((n) =>
        n.id === to.id
          ? {
              ...n,
              dependsOn: n.dependsOn.map((p) => (p === from.id ? id : p)),
            }
          : n,
      ),
      {
        id,
        name: "新环节",
        description: "",
        dependsOn: [from.id],
        position: {
          x: (from.position.x + to.position.x) / 2,
          y: (from.position.y + to.position.y) / 2 + 260,
        },
      },
    ]);
    setSelectedNode(id);
    setEdge(null);
    setSource(null);
  };
  const point = (x: number, y: number) => {
    const box = root.current!.getBoundingClientRect();
    return {
      x: (x - box.left - view.x) / view.scale,
      y: (y - box.top - view.y) / view.scale,
    };
  };
  const connect = (to: string) => {
    if (!source || !onChange) return;
    const next = nodes.map((s) =>
      s.id === to ? { ...s, dependsOn: [...s.dependsOn, source] } : s,
    );
    if (!validFlow(next)) message.warning("不能连接自身、重复连线或形成循环");
    else onChange(next);
    setSource(null);
  };
  const fit = () => {
    if (!nodes.length || !root.current) return;
    const minX = Math.min(...nodes.map((n) => n.position.x)),
      minY = Math.min(...nodes.map((n) => n.position.y));
    const width = Math.max(...nodes.map((n) => n.position.x + 270)) - minX;
    const height = Math.max(...nodes.map((n) => n.position.y + 220)) - minY;
    const scale = Math.max(
      0.05,
      Math.min(
        1,
        (root.current.clientWidth - 80) / width,
        (root.current.clientHeight - 80) / height,
      ),
    );
    setView({ x: 40 - minX * scale, y: 40 - minY * scale, scale });
  };
  const path = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const bend = Math.max(80, Math.abs(b.x - a.x) / 2);
    return `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`;
  };
  return (
    <div className={expanded ? "flow-shell flow-fullscreen" : "flow-shell"}>
      <Space wrap className="project-flow-tools">
        <Button
          aria-label="放大画布"
          onClick={() =>
            setView((v) => ({ ...v, scale: Math.min(2.5, v.scale * 1.2) }))
          }
        >
          ＋
        </Button>
        <Button
          aria-label="缩小画布"
          onClick={() =>
            setView((v) => ({ ...v, scale: Math.max(0.05, v.scale / 1.2) }))
          }
        >
          －
        </Button>
        <Button onClick={fit}>适应全部</Button>
        <Button onClick={() => setExpanded((v) => !v)}>
          {expanded ? "退出全屏" : "全屏画布"}
        </Button>
        {onChange && (
          <Button
            disabled={nodes.length >= 30}
            onClick={() => {
              const box = root.current!.getBoundingClientRect();
              onChange([
                ...nodes,
                {
                  id: crypto.randomUUID(),
                  name: "新环节",
                  description: "",
                  dependsOn: [],
                  position: point(
                    box.left + box.width / 2 - 100,
                    box.top + box.height / 2 - 100,
                  ),
                },
              ]);
            }}
          >
            添加环节
          </Button>
        )}
        <Typography.Text>{Math.round(view.scale * 100)}%</Typography.Text>
        {onChange && selected && (
          <>
            <Typography.Text>已选：{selected.name}</Typography.Text>
            <Button disabled={nodes.length >= 30} onClick={addAfter}>
              ＋ 后续环节
            </Button>
            <Button
              onClick={() => {
                setSource(selected.id);
                setCursor({
                  x: selected.position.x + 330,
                  y: selected.position.y + 105,
                });
              }}
            >
              ＋ 连线
            </Button>
            <Button danger disabled={nodes.length === 1} onClick={removeNode}>
              － 删除卡片
            </Button>
          </>
        )}
        {onChange && edge && (
          <>
            <Button disabled={nodes.length >= 30} onClick={insertOnEdge}>
              ＋ 在线上插入环节
            </Button>
            <Button danger onClick={removeEdge}>
              － 删除选中连线
            </Button>
          </>
        )}
        {source && <Button onClick={() => setSource(null)}>取消连线</Button>}
        <Typography.Text type="secondary">
          拖动空白平移 · 滚轮缩放 · 拖动卡片
          {onChange ? " · 从右侧圆点连到目标左侧圆点" : " · 双击查看任务"}
        </Typography.Text>
      </Space>
      <div
        ref={root}
        className="project-canvas flow-infinite"
        tabIndex={0}
        style={{
          backgroundPosition: `${view.x}px ${view.y}px`,
          backgroundSize: `${20 * view.scale}px ${20 * view.scale}px`,
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setSource(null);
            setEdge(null);
            setSelectedNode(null);
          }
          if (
            e.key === "Delete" &&
            !(e.target as Element).closest("input,textarea,button")
          ) {
            e.preventDefault();
            if (edge) removeEdge();
            else removeNode();
          }
        }}
        onWheel={(e) => {
          const p = point(e.clientX, e.clientY),
            box = root.current!.getBoundingClientRect();
          const scale = Math.min(
            2.5,
            Math.max(0.05, view.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)),
          );
          setView({
            scale,
            x: e.clientX - box.left - p.x * scale,
            y: e.clientY - box.top - p.y * scale,
          });
        }}
        onPointerDown={(e) => {
          if (
            e.button !== 0 ||
            (e.target as Element).closest("[data-flow-interactive]")
          )
            return;
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            ox: view.x,
            oy: view.y,
            moved: false,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
          setEdge(null);
          setSelectedNode(null);
        }}
        onPointerMove={(e) => {
          if (source) setCursor(point(e.clientX, e.clientY));
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x,
            dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
          if (d.id)
            setPositions((old) => ({
              ...old,
              [d.id!]: { x: d.ox + dx / view.scale, y: d.oy + dy / view.scale },
            }));
          else setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          if (d?.id && d.moved && onChange) {
            const position = {
              x: d.ox + (e.clientX - d.x) / view.scale,
              y: d.oy + (e.clientY - d.y) / view.scale,
            };
            onChange(
              nodes.map((s) => (s.id === d.id ? { ...s, position } : s)),
            );
          }
          drag.current = null;
          if (source) {
            const target = document
              .elementFromPoint(e.clientX, e.clientY)
              ?.closest("[data-input]")
              ?.getAttribute("data-input");
            if (target) connect(target);
          }
        }}
        onPointerCancel={() => {
          drag.current = null;
          setSource(null);
        }}
      >
        <div
          style={{
            position: "absolute",
            transform: `translate(${view.x}px,${view.y}px) scale(${view.scale})`,
            transformOrigin: "0 0",
          }}
        >
          <svg
            width="1"
            height="1"
            style={{ position: "absolute", overflow: "visible" }}
          >
            <defs>
              <marker
                id={marker}
                markerWidth="10"
                markerHeight="10"
                refX="8"
                refY="3"
                orient="auto"
              >
                <path d="M0,0 L0,6 L8,3 z" fill="#e66b18" />
              </marker>
            </defs>
            {nodes.flatMap((n) =>
              n.dependsOn.map((from) => {
                const start = nodes.find((s) => s.id === from);
                if (!start) return null;
                const d = path(
                  { x: start.position.x + 270, y: start.position.y + 105 },
                  { x: n.position.x, y: n.position.y + 105 },
                );
                return (
                  <g
                    key={`${from}-${n.id}`}
                    data-flow-interactive="edge"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEdge({ from, to: n.id });
                      setSelectedNode(null);
                      setSource(null);
                    }}
                  >
                    <path
                      d={d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={18}
                      style={{ cursor: "pointer", pointerEvents: "stroke" }}
                    />
                    <path
                      d={d}
                      fill="none"
                      stroke={
                        edge?.from === from && edge.to === n.id
                          ? "#e89b36"
                          : "#e66b18"
                      }
                      strokeWidth={3}
                      markerEnd={`url(#${marker})`}
                      style={{ pointerEvents: "none" }}
                    />
                  </g>
                );
              }),
            )}
            {source && nodes.some((n) => n.id === source) && (
              <path
                d={path(
                  {
                    x: nodes.find((n) => n.id === source)!.position.x + 270,
                    y: nodes.find((n) => n.id === source)!.position.y + 105,
                  },
                  cursor,
                )}
                fill="none"
                stroke="#e66b18"
                strokeWidth={2}
                strokeDasharray="6 4"
                style={{ pointerEvents: "none" }}
              />
            )}
          </svg>
          {nodes.map((s) => {
            const ts = tasks.filter((t) => t.stage === s.id),
              done = ts.filter((t) => t.status === "DONE").length;
            return (
              <div
                key={s.id}
                data-flow-interactive="node"
                className={`project-flow-node ${selectedNode === s.id ? "flow-node-selected" : ""} ${ts.some((t) => t.status === "DISPUTED") ? "disputed" : ts.length && done === ts.length ? "done" : ""}`}
                style={{
                  left: s.position.x,
                  top: s.position.y,
                  cursor: "grab",
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0 || (e.target as Element).closest("button"))
                    return;
                  e.stopPropagation();
                  setSelectedNode(s.id);
                  setEdge(null);
                  drag.current = {
                    id: s.id,
                    x: e.clientX,
                    y: e.clientY,
                    ox: s.position.x,
                    oy: s.position.y,
                    moved: false,
                  };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onDoubleClick={() => onStage?.(s.id)}
              >
                {onChange && (
                  <button
                    type="button"
                    className="flow-port input"
                    data-input={s.id}
                    aria-label={`${s.name} 接入端`}
                    onClick={() => connect(s.id)}
                  />
                )}
                <span className="eyebrow">
                  {s.dependsOn.length
                    ? `${s.dependsOn.length} 个前置环节`
                    : "起始 / 并行环节"}{" "}
                  · {s.department || "SOP"}
                </span>
                <h3>{s.name}</h3>
                {onChange && selectedNode === s.id && (
                  <Space className="flow-node-actions">
                    <Button
                      size="small"
                      aria-label={`在${s.name}后增加环节`}
                      disabled={nodes.length >= 30}
                      onClick={addAfter}
                    >
                      ＋
                    </Button>
                    <Button
                      size="small"
                      danger
                      aria-label={`删除${s.name}卡片`}
                      disabled={nodes.length === 1}
                      onClick={removeNode}
                    >
                      －
                    </Button>
                  </Space>
                )}
                <p>{s.description}</p>
                {ts.length > 0 && (
                  <small>
                    {done}/{ts.length} 项任务已验收
                  </small>
                )}
                {onStage && (
                  <Button size="small" onClick={() => onStage(s.id)}>
                    查看任务
                  </Button>
                )}
                {onChange && (
                  <button
                    type="button"
                    className="flow-port output"
                    aria-label={`${s.name} 连接到下一环节`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSource(s.id);
                      setCursor(point(e.clientX, e.clientY));
                    }}
                    onClick={() => {
                      setSource(s.id);
                      setCursor({
                        x: s.position.x + 330,
                        y: s.position.y + 105,
                      });
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <Typography.Paragraph type="secondary">
        多个后续环节可并行；多个前置连入时，全部验收通过后才可交付本环节。
        {onChange ? "调整后点击“保存模板”保存位置与连线。" : ""}
      </Typography.Paragraph>
    </div>
  );
}
