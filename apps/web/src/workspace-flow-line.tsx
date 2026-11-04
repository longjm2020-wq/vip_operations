import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";

/** Nested, coincident strokes form one tapered beam, never a repeating dotted line. */
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
      <path className="workspace-flow-glow" d={d} pathLength="100" />
      {[14, 12, 10, 8, 6, 4, 2].map((length, index) => (
        <path
          key={length}
          className="workspace-flow-trail"
          d={d}
          pathLength="100"
          style={
            {
              "--flow-tail": `${length}px`,
              strokeDasharray: `${length} 1000`,
              opacity: [0.04, 0.05, 0.06, 0.08, 0.1, 0.14, 0.2][index],
            } as CSSProperties
          }
        />
      ))}
      <path className="workspace-flow-head" d={d} pathLength="100" />
    </g>
  );
}

/** Use pixel geometry so strokes have consistent thickness without dash tiling. */
export function WorkspaceBranchLines({
  panels,
  selected,
}: {
  panels: string[];
  selected: string | null;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!svg.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    });
    observer.observe(svg.current);
    return () => observer.disconnect();
  }, []);
  return (
    <svg
      ref={svg}
      className="workspace-branch-lines"
      shapeRendering="geometricPrecision"
      aria-hidden="true"
      focusable="false"
    >
      {size.width > 0 &&
        size.height > 0 &&
        panels.map((key, index) => {
          const y = ((index + 0.5) / panels.length) * size.height;
          const midX = size.width / 2;
          const midY = size.height / 2;
          return (
            <WorkspaceFlowLine
              key={key}
              active={selected === key}
              delay={index * -1.4}
              d={`M 0 ${midY} C ${midX} ${midY} ${midX} ${y} ${size.width} ${y}`}
            />
          );
        })}
    </svg>
  );
}
