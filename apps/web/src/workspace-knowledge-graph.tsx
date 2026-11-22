import { useLayoutEffect, useMemo, useRef, useState, useId } from "react";
import { AimOutlined, MinusOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Empty, Select } from "antd";
import "./workspace-knowledge-graph.css";

interface GraphNote {
  id: string;
  title: string;
  employeeIds: string[];
}
interface Employee {
  id: string;
  name: string;
}
interface Link {
  sourceId: string;
  targetId: string;
}
interface Props {
  notes: GraphNote[];
  links: Link[];
  employees: Employee[];
  selectedNoteId?: string;
  onSelectNote: (id: string) => void;
}
type Point = { x: number; y: number };
type Vertex = Point & {
  id: string;
  label: string;
  kind: "note" | "employee";
  neighbors: Set<string>;
};
type Edge = { from: Vertex; to: Vertex; grant: boolean };

// Place each connected component around its most connected node. Breadth-first
// rings put directly related notes close together without an ongoing simulation.
function layoutGraph(notes: GraphNote[], links: Link[], employees: Employee[]) {
  const vertices = new Map<string, Vertex>();
  const edges: Edge[] = [];
  const employeeNames = new Map(employees.map((item) => [item.id, item.name]));
  function add(id: string, label: string, kind: Vertex["kind"]) {
    if (!vertices.has(id))
      vertices.set(id, { id, label, kind, x: 0, y: 0, neighbors: new Set() });
  }
  function connect(a: string, b: string, grant: boolean) {
    const from = vertices.get(a),
      to = vertices.get(b);
    if (!from || !to || a === b) return;
    from.neighbors.add(b);
    to.neighbors.add(a);
    edges.push({ from, to, grant });
  }
  for (const note of notes) add(note.id, note.title, "note");
  for (const { sourceId, targetId } of links)
    connect(sourceId, targetId, false);
  for (const note of notes) {
    for (const id of new Set(note.employeeIds)) {
      const name = employeeNames.get(id);
      if (name === undefined) continue;
      const key = "employee:" + id;
      add(key, name, "employee");
      connect(note.id, key, true);
    }
  }
  const sorted = [...vertices.values()].sort(
    (a, b) =>
      b.neighbors.size - a.neighbors.size ||
      a.label.localeCompare(b.label, "zh-CN") ||
      a.id.localeCompare(b.id),
  );
  const seen = new Set<string>();
  const groups: { nodes: Vertex[]; width: number; height: number }[] = [];
  for (const root of sorted) {
    if (seen.has(root.id)) continue;
    seen.add(root.id);
    const nodes = [root];
    let level = [root],
      radius = 0;
    while (level.length) {
      const next: Vertex[] = [];
      for (const v of level) {
        for (const id of v.neighbors) {
          if (seen.has(id)) continue;
          seen.add(id);
          next.push(vertices.get(id)!);
        }
      }
      if (!next.length) break;
      radius = Math.max(radius + 103, (next.length * 118) / (2 * Math.PI));
      next.forEach((v, i) => {
        const angle = (i / next.length) * 2 * Math.PI - Math.PI / 4;
        v.x = Math.cos(angle) * radius;
        v.y = Math.sin(angle) * radius;
      });
      nodes.push(...next);
      level = next;
    }
    let left = 0,
      right = 0,
      top = 0,
      bottom = 0;
    for (const v of nodes) {
      left = Math.min(left, v.x);
      right = Math.max(right, v.x);
      top = Math.min(top, v.y);
      bottom = Math.max(bottom, v.y);
    }
    for (const v of nodes) {
      v.x += 70 - left;
      v.y += 32 - top;
    }
    groups.push({
      nodes,
      width: right - left + 140,
      height: bottom - top + 84,
    });
  }
  const targetWidth = Math.sqrt(
    groups.reduce((sum, g) => sum + g.width * g.height, 0) * 1.6,
  );
  let x = 0,
    y = 0,
    rowHeight = 0,
    width = 0;
  for (const g of groups) {
    if (x && x + g.width > targetWidth) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    for (const v of g.nodes) {
      v.x += x;
      v.y += y;
    }
    x += g.width;
    rowHeight = Math.max(rowHeight, g.height);
    width = Math.max(width, x);
  }
  return {
    vertices,
    edges,
    width: Math.max(width, 1),
    height: Math.max(y + rowHeight, 1),
  };
}

export function WorkspaceKnowledgeGraph({
  notes,
  links,
  employees,
  selectedNoteId,
  onSelectNote,
}: Props) {
  const graph = useMemo(
    () => layoutGraph(notes, links, employees),
    [notes, links, employees],
  );
  const clipId = useId().replace(/:/g, "");
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 640, height: 390 });
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [pinned, setPinned] = useState<string>();
  const [hover, setHover] = useState<string>();
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    pan: Point;
  } | null>(null);
  const selected =
    graph.vertices.get(pinned ?? "") ??
    graph.vertices.get(selectedNoteId ?? "");
  const focus = graph.vertices.get(hover ?? "") ?? selected;
  const fit = Math.min(
    1.35,
    (size.width - 20) / graph.width,
    (size.height - 24) / graph.height,
  );
  const scale = Math.max(0.001, fit) * view.zoom;
  const options = useMemo(
    () =>
      [...graph.vertices.values()].map((v) => ({
        value: v.id,
        label: (v.kind === "employee" ? "员工 · " : "笔记 · ") + v.label,
      })),
    [graph],
  );
  const hasNotes = notes.length > 0;

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const resize = () =>
      setSize({ width: el.clientWidth, height: el.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNotes]);

  function locate(id?: string) {
    setPinned(id);
    setHover(undefined);
    const node = id && graph.vertices.get(id);
    if (!node) {
      setView({ zoom: 1, x: 0, y: 0 });
      return;
    }
    const targetScale = Math.max(fit, 1);
    setView({
      zoom: targetScale / Math.max(0.001, fit),
      x: (graph.width / 2 - node.x) * targetScale,
      y: (graph.height / 2 - node.y) * targetScale,
    });
  }

  function zoom(factor: number) {
    setView((v) => {
      const z = Math.max(
        0.4,
        Math.min(Math.max(6, 2 / Math.max(0.001, fit)), v.zoom * factor),
      );
      return { zoom: z, x: (v.x * z) / v.zoom, y: (v.y * z) / v.zoom };
    });
  }
  function choose(v: Vertex) {
    if (v.kind === "employee")
      setPinned((prev) => (prev === v.id ? undefined : v.id));
    else {
      setPinned(undefined);
      onSelectNote(v.id);
    }
  }
  if (!notes.length)
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="添加第一篇笔记后即可查看知识图谱"
      />
    );
  return (
    <section className="workspace-kgraph" aria-label="知识图谱">
      <Select
        className="workspace-kgraph__locator"
        variant="borderless"
        aria-label="定位图谱节点"
        placeholder="定位笔记或员工"
        allowClear
        showSearch={{ optionFilterProp: "label" }}
        value={pinned}
        options={options}
        onChange={locate}
      />
      <div className="workspace-kgraph__stage" ref={viewport}>
        <svg
          width="100%"
          height="100%"
          role="group"
          aria-label="笔记引用和员工授权关系，可拖动画布"
          onPointerDown={(e) => {
            if (
              e.button !== 0 ||
              (e.target as Element).closest("[data-vertex]")
            )
              return;
            drag.current = {
              pointerId: e.pointerId,
              x: e.clientX,
              y: e.clientY,
              pan: { x: view.x, y: view.y },
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d?.pointerId !== e.pointerId) return;
            setView((v) => ({
              ...v,
              x: d.pan.x + e.clientX - d.x,
              y: d.pan.y + e.clientY - d.y,
            }));
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
        >
          <defs>
            <marker
              id={clipId + "-arrow"}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0 0 L8 4 L0 8z" fill="currentColor" />
            </marker>
          </defs>
          <g
            transform={`translate(${size.width / 2 + view.x} ${size.height / 2 + view.y}) scale(${scale}) translate(${-graph.width / 2} ${-graph.height / 2})`}
          >
            {graph.edges.map(({ from, to, grant }) => {
              const dx = to.x - from.x,
                dy = to.y - from.y,
                dist = Math.hypot(dx, dy) || 1;
              const active = focus?.id === from.id || focus?.id === to.id;
              return (
                <line
                  key={from.id + ":" + to.id}
                  className={
                    "kgraph-edge" +
                    (grant ? " grant" : "") +
                    (active ? " active" : "")
                  }
                  x1={from.x + (dx * 14) / dist}
                  y1={from.y + (dy * 14) / dist}
                  x2={to.x - (dx * 17) / dist}
                  y2={to.y - (dy * 17) / dist}
                  markerEnd={grant ? undefined : `url(#${clipId}-arrow)`}
                  opacity={focus && !active ? 0.28 : 1}
                />
              );
            })}
            {[...graph.vertices.values()].map((v) => {
              const related =
                !focus || focus.id === v.id || focus.neighbors.has(v.id);
              const short = Array.from(v.label);
              return (
                <g
                  key={v.id}
                  data-vertex={v.id}
                  transform={`translate(${v.x} ${v.y})`}
                  className={
                    "kgraph-node " +
                    v.kind +
                    (selected?.id === v.id ? " selected" : "") +
                    (related ? "" : " muted")
                  }
                  role="button"
                  tabIndex={0}
                  aria-label={
                    (v.kind === "note" ? "打开笔记 " : "查看授权员工 ") +
                    v.label
                  }
                  onMouseEnter={() => setHover(v.id)}
                  onMouseLeave={() => setHover(undefined)}
                  onFocus={() => setHover(v.id)}
                  onBlur={() => setHover(undefined)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      choose(v);
                    }
                  }}
                  onClick={() => choose(v)}
                >
                  <title>{v.label}</title>
                  <circle className="kgraph-hit" r="23" />
                  <circle
                    className="kgraph-halo"
                    r={v.kind === "note" ? 16 : 18}
                  />
                  {v.kind === "note" ? (
                    <circle className="kgraph-core" r="7" />
                  ) : (
                    <path className="kgraph-core" d="M0 -9 9 0 0 9 -9 0Z" />
                  )}
                  <text y="33" textAnchor="middle">
                    {short.length > 10
                      ? short.slice(0, 9).join("") + "…"
                      : v.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
        <div className="workspace-kgraph__tools">
          <Button
            aria-label="缩小图谱"
            title="缩小"
            size="small"
            icon={<MinusOutlined />}
            onClick={() => zoom(1 / 1.4)}
          />
          <Button
            aria-label="放大图谱"
            title="放大"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => zoom(1.4)}
          />
          <Button
            aria-label="图谱全览"
            title="图谱全览"
            size="small"
            icon={<AimOutlined />}
            onClick={() => {
              locate();
            }}
          />
        </div>
      </div>
      <div className="workspace-kgraph__legend">
        <span>
          <i aria-hidden="true" />
          笔记引用
        </span>
        <span>
          <i className="grant" aria-hidden="true" />
          员工授权
        </span>
      </div>
      {selected?.kind === "employee" && (
        <div className="workspace-kgraph__grants">
          <strong>{selected.label}可查阅</strong>
          {[...selected.neighbors].map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => choose(graph.vertices.get(id)!)}
            >
              {graph.vertices.get(id)!.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
