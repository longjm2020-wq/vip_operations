/** Shared ring artwork for workbench entries and team members. */
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
      <circle
        className="workspace-dock-halo-ticks"
        cx="50"
        cy="50"
        r="43"
        pathLength="100"
        strokeDasharray="0.3 4.7"
      />
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
