const haloTicks = Array.from({ length: 40 }, (_, index) => index);

/** Shared vector ring artwork; glow is a separate backdrop, never a line filter. */
export function WorkspaceDockHalo() {
  return (
    <svg
      className="workspace-dock-halo"
      viewBox="0 0 100 100"
      shapeRendering="geometricPrecision"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="workspace-dock-halo-track" cx="50" cy="50" r="47" />
      <g className="workspace-dock-halo-ticks">
        {haloTicks.map((tick) => (
          <line
            key={tick}
            x1="50"
            x2="50"
            y1={tick % 5 === 0 ? 5.5 : 7}
            y2="9.5"
            transform={`rotate(${tick * 9} 50 50)`}
          />
        ))}
      </g>
      <circle className="workspace-dock-halo-inner" cx="50" cy="50" r="38" />
      <g className="workspace-dock-halo-sweep">
        <circle
          className="workspace-dock-halo-arc"
          cx="50"
          cy="50"
          r="47"
          pathLength="100"
          strokeDasharray="23 12 3 24 10 28"
        />
        <circle className="workspace-dock-halo-beacon" cx="50" cy="3" r="1.6" />
        <circle
          className="workspace-dock-halo-beacon-soft"
          cx="50"
          cy="3"
          r="3.5"
        />
      </g>
      <g className="workspace-dock-halo-counter">
        <circle
          className="workspace-dock-halo-arc-inner"
          cx="50"
          cy="50"
          r="39"
          pathLength="100"
          strokeDasharray="11 34 5 50"
        />
      </g>
    </svg>
  );
}
