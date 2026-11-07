import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";

// Composite the same-width strokes into a smooth light trail. Its brightness
// falls quadratically with distance behind the shared leading edge.
const flowLayers = Array.from({ length: 24 }, (_, index) => {
  const previous = 0.78 * (index / 24) ** 2;
  const next = 0.78 * ((index + 1) / 24) ** 2;
  return {
    length: 30 * (1 - index / 24),
    opacity: (next - previous) / (1 - previous),
  };
});

/** One constant-width line lights ahead and fades behind, without a wider halo. */
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
      {flowLayers.map(({ length, opacity }) => (
        <path
          key={length}
          className="workspace-flow-trail"
          d={d}
          pathLength="100"
          style={
            {
              "--flow-tail": `${length}px`,
              strokeDasharray: `${length} 1000`,
              opacity,
            } as CSSProperties
          }
        />
      ))}
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
